/**
 * catchers — the two delivery catchers of the `@local:notif` rows (REG-WFL-25 / 26 / 27 / 29; decision D3: the local overlay gets
 * an SMTP catcher and a webhook receiver). Local stack only: nothing here is reachable from a shared-tier run, every client
 * refuses unless `TIER_KIND=local`, and no notification is ever delivered to a real recipient or URL.
 *
 * - `MailCatcher` is a client of a Mailpit-class catcher's HTTP read API (`GET /api/v1/messages`, `GET /api/v1/message/{id}`,
 *   `DELETE /api/v1/messages`), at REG_SMTP_CATCHER_URL; the e-mail provider's SMTP_HOST / SMTP_PORT point at its SMTP port.
 * - `WebhookReceiver` is a RUNNER-hosted HTTP server (the plan's "equivalent": reached through a dotted alias of the runner,
 *   REG_WEBHOOK_HOST) that records method, path, headers and the RAW body of every request and answers 204, or 500 when told
 *   to (fire-and-forget oracle, REG-WFL-35). The webhook instance's URL is `receiver.url()`.
 *
 * Plain `node:http` calls (not Playwright contexts): these are the test's own infrastructure, not the ILM API the guard
 * protects. A message or request is matched by what the TEST caused (a run-prefixed subject / body), never by position.
 */
import * as http from 'http';
import type { AddressInfo } from 'net';
import { isLocalTier } from './tier';

type Json = Record<string, any>;

function requireLocal(what: string): void {
    if (!isLocalTier()) throw new Error(`${what}: a delivery catcher exists on a local stack only (TIER_KIND=local)`);
}

/** Why the SMTP catcher cannot be used ("deploy gate"), or undefined. */
export function smtpCatcherProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return (env.REG_SMTP_CATCHER_URL ?? '').trim()
        ? undefined
        : 'deploy gate: no SMTP catcher (REG_SMTP_CATCHER_URL unset): the local notification overlay (decision D3) is not up; @needs:smtp-catcher';
}

/** Why the webhook receiver cannot be hosted ("deploy gate"), or undefined. */
export function webhookReceiverProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return (env.REG_WEBHOOK_HOST ?? '').trim()
        ? undefined
        : 'deploy gate: no webhook receiver address (REG_WEBHOOK_HOST unset): a dotted alias of the runner the webhook provider container can reach; @needs:webhook-receiver';
}

interface Answer {
    status: number;
    body: string;
}

function call(method: string, urlText: string, body?: string): Promise<Answer> {
    const url = new URL(urlText);
    return new Promise((resolve, reject) => {
        const req = http.request(
            { method, hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}, timeout: 10_000 },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
            },
        );
        req.on('timeout', () => req.destroy(new Error(`${method} ${url.origin}${url.pathname}: timed out`)));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// ------------------------------------------------------------------ the SMTP catcher (Mailpit API)

export interface CaughtMessage {
    id: string;
    to: string[];
    from: string;
    subject: string;
    /** The HTML part (the e-mail provider sends HTML only, rules T10 R56). */
    html: string;
    text: string;
}

export class MailCatcher {
    constructor(private readonly base: string) {
        requireLocal('MailCatcher');
    }

    static fromEnv(env: NodeJS.ProcessEnv = process.env): MailCatcher {
        const problem = smtpCatcherProblem(env);
        if (problem) throw new Error(problem);
        return new MailCatcher(String(env.REG_SMTP_CATCHER_URL).replace(/\/$/, ''));
    }

    /** Every caught message (summaries), oldest first. */
    async list(): Promise<Json[]> {
        const res = await call('GET', `${this.base}/api/v1/messages?limit=500`);
        if (res.status !== 200) throw new Error(`catcher list answered ${res.status}`);
        return ((JSON.parse(res.body) as Json).messages ?? []) as Json[];
    }

    async get(id: string): Promise<CaughtMessage> {
        const res = await call('GET', `${this.base}/api/v1/message/${encodeURIComponent(id)}`);
        if (res.status !== 200) throw new Error(`catcher message ${id} answered ${res.status}`);
        const m = JSON.parse(res.body) as Json;
        return {
            id,
            to: ((m.To ?? []) as Json[]).map((t) => String(t.Address)),
            from: String(m.From?.Address ?? ''),
            subject: String(m.Subject ?? ''),
            html: String(m.HTML ?? ''),
            text: String(m.Text ?? ''),
        };
    }

    /** Empties the catcher (the overlay's own, never a shared one). */
    async clear(): Promise<void> {
        const res = await call('DELETE', `${this.base}/api/v1/messages`);
        if (res.status >= 300) throw new Error(`catcher clear answered ${res.status}`);
    }

    /** Messages whose subject contains `marker`, fully read, once at least `count` have arrived (polled; fails with what it saw). */
    async waitForMessages(marker: string, count: number, timeoutMs = 90_000): Promise<CaughtMessage[]> {
        const started = Date.now();
        for (;;) {
            const summaries = (await this.list()).filter((m) => String(m.Subject ?? '').includes(marker));
            if (summaries.length >= count) return Promise.all(summaries.map((s) => this.get(String(s.ID))));
            if (Date.now() - started > timeoutMs) throw new Error(`catcher: ${summaries.length} of ${count} message(s) with "${marker}" after ${timeoutMs} ms`);
            await new Promise((r) => setTimeout(r, 2_000));
        }
    }
}

// ------------------------------------------------------------------ the webhook receiver (runner-hosted)

export interface ReceivedRequest {
    method: string;
    path: string;
    /** Lower-cased header names. */
    headers: Record<string, string>;
    /** The raw body exactly as received. */
    body: string;
    receivedAt: number;
}

export class WebhookReceiver {
    private constructor(
        private readonly server: http.Server,
        readonly port: number,
        private readonly host: string,
        private readonly requests: ReceivedRequest[],
        private readonly mode: { status: number },
    ) {}

    /** Starts a receiver on a random port, bound to REG_WEBHOOK_BIND (default 0.0.0.0); `url()` uses REG_WEBHOOK_HOST. */
    static async start(env: NodeJS.ProcessEnv = process.env): Promise<WebhookReceiver> {
        requireLocal('WebhookReceiver');
        const problem = webhookReceiverProblem(env);
        if (problem) throw new Error(problem);
        const requests: ReceivedRequest[] = [];
        const mode = { status: 204 };
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => {
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
                requests.push({ method: req.method ?? '', path: req.url ?? '', headers, body: Buffer.concat(chunks).toString('utf8'), receivedAt: Date.now() });
                res.statusCode = mode.status;
                res.end();
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, (env.REG_WEBHOOK_BIND ?? '0.0.0.0').trim() || '0.0.0.0', () => resolve());
        });
        return new WebhookReceiver(server, (server.address() as AddressInfo).port, String(env.REG_WEBHOOK_HOST).trim(), requests, mode);
    }

    /** The URL the webhook instance is configured with (`http://<alias>:<port>/hook`, the path carries the marker). */
    url(marker = 'hook'): string {
        return `http://${this.host}:${this.port}/${marker}`;
    }

    all(): ReceivedRequest[] {
        return [...this.requests];
    }

    /** Answer every request with this status from now on (204 default; 500 for the fire-and-forget row). */
    answerWith(status: number): void {
        this.mode.status = status;
    }

    async waitForRequests(marker: string, count: number, timeoutMs = 90_000): Promise<ReceivedRequest[]> {
        const started = Date.now();
        for (;;) {
            const hits = this.requests.filter((r) => r.path.includes(marker));
            if (hits.length >= count) return hits;
            if (Date.now() - started > timeoutMs) throw new Error(`webhook receiver: ${hits.length} of ${count} request(s) for "${marker}" after ${timeoutMs} ms`);
            await new Promise((r) => setTimeout(r, 1_000));
        }
    }

    async close(): Promise<void> {
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
}
