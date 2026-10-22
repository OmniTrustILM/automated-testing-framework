/**
 * notificationCatchers — the delivery receivers of the local-stack notification rows.
 *
 * WHAT: the two delivery receivers of the `@local` notification rows: `MailCatcher` (a client of a
 *       Mailpit-class SMTP catcher's HTTP read API, REG_SMTP_CATCHER_URL) and `WebhookReceiver` (an HTTP server on the runner,
 *       reached through REG_WEBHOOK_HOST, recording method, path, headers and the raw body). Local stack only: every client refuses
 *       unless `TIER_KIND=local`; a message is matched by what the test caused (a run-prefixed marker), never by position.
 * WHY: A notification is only proven by receiving it, and receiving needs an e-mail catcher and a webhook receiver that no shared tier may use.
 * HOW: `MailCatcher` reads a Mailpit-class catcher over HTTP and `WebhookReceiver` is a runner-side HTTP server; both refuse unless `TIER_KIND=local`, and a message is matched by a run-prefixed marker, never by position.
 */
import * as http from 'http';
import type { AddressInfo } from 'net';
import { isLocalTier } from '../tier/kind';
import { pollUntil } from '../wait';
import { settings } from '../run/settings';
import type { JsonObject } from '../json';
import { objectOf } from '../json';

function requireLocal(what: string): void {
    if (!isLocalTier()) throw new Error(`${what}: a delivery catcher exists on a local stack only (TIER_KIND=local)`);
}

/** Why the SMTP catcher cannot be used ("deploy gate"), or undefined. */
export function smtpCatcherProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return settings(env).smtpCatcherUrl
        ? undefined
        : 'deploy gate: no SMTP catcher (REG_SMTP_CATCHER_URL unset): the local notification overlay is not up; @needs:smtp-catcher';
}

/** Why the webhook receiver cannot be hosted ("deploy gate"), or undefined. */
export function webhookReceiverProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return settings(env).webhookHost
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

interface CaughtMessage {
    id: string;
    to: string[];
    from: string;
    subject: string;
    /** The HTML part (the e-mail provider sends HTML only). */
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
        return new MailCatcher(String(settings(env).smtpCatcherUrl).replace(/\/$/, ''));
    }

    /** Every caught message (summaries), oldest first. */
    async list(): Promise<JsonObject[]> {
        const res = await call('GET', `${this.base}/api/v1/messages?limit=500`);
        if (res.status !== 200) throw new Error(`catcher list answered ${res.status}`);
        return ((JSON.parse(res.body) as JsonObject).messages ?? []) as JsonObject[];
    }

    async get(id: string): Promise<CaughtMessage> {
        const res = await call('GET', `${this.base}/api/v1/message/${encodeURIComponent(id)}`);
        if (res.status !== 200) throw new Error(`catcher message ${id} answered ${res.status}`);
        const m = JSON.parse(res.body) as JsonObject;
        return {
            id,
            to: ((m.To ?? []) as JsonObject[]).map((t) => String(t.Address)),
            from: String(objectOf(m.From).Address ?? ''),
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
        const summaries = await pollUntil(
            async () => (await this.list()).filter((m) => String(m.Subject ?? '').includes(marker)),
            (found) => found.length >= count,
            { timeoutMs, intervalMs: 2_000, tolerateErrors: 0, onTimeout: 'return' },
        );
        if (summaries.length < count) throw new Error(`catcher: ${summaries.length} of ${count} message(s) with "${marker}" after ${timeoutMs} ms`);
        return Promise.all(summaries.map((s) => this.get(String(s.ID))));
    }
}

// ------------------------------------------------------------------ the webhook receiver (runner-hosted)

interface ReceivedRequest {
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
            server.listen(0, settings(env).webhookBind, () => resolve());
        });
        return new WebhookReceiver(server, (server.address() as AddressInfo).port, settings(env).webhookHost, requests, mode);
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
        const hits = await pollUntil(
            async () => this.requests.filter((r) => r.path.includes(marker)),
            (found) => found.length >= count,
            { timeoutMs, intervalMs: 1_000, tolerateErrors: 0, onTimeout: 'return' },
        );
        if (hits.length < count) throw new Error(`webhook receiver: ${hits.length} of ${count} request(s) for "${marker}" after ${timeoutMs} ms`);
        return hits;
    }

    async close(): Promise<void> {
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
}
