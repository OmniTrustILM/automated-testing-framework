/**
 * notificationCatchers — the delivery receivers of the local-stack notification rows: `MailCatcher` (a Mailpit-class SMTP catcher's HTTP
 * read API) and `WebhookReceiver` (a runner-hosted HTTP server); `@local`
 * only, messages matched by a run-prefixed marker, never by position.
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

export function smtpCatcherProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return settings(env).smtpCatcherUrl
        ? undefined
        : 'deploy gate: no SMTP catcher (REG_SMTP_CATCHER_URL unset): the local notification overlay is not up; @needs:smtp-catcher';
}

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


interface CaughtMessage {
    id: string;
    to: string[];
    from: string;
    subject: string;
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

    async clear(): Promise<void> {
        const res = await call('DELETE', `${this.base}/api/v1/messages`);
        if (res.status >= 300) throw new Error(`catcher clear answered ${res.status}`);
    }

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


interface ReceivedRequest {
    method: string;
    path: string;
    headers: Record<string, string>;
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

    url(marker = 'hook'): string {
        return `http://${this.host}:${this.port}/${marker}`;
    }

    all(): ReceivedRequest[] {
        return [...this.requests];
    }

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
