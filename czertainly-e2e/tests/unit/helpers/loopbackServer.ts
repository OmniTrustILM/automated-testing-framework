/**
 * loopbackServer — a fake HTTP server on the loopback interface for the unit tests.
 *
 * `loopbackServer(answer)` listens on 127.0.0.1 with a random port, records every request (method, path as received, body,
 * headers) and answers what `answer` returns (default 200 `{}`). Requests go through a real Playwright APIRequestContext,
 * so the tests assert what actually reached the wire. `reset()` clears the record between tests, `close()` stops it.
 */
import * as http from 'http';
import type { AddressInfo } from 'net';

export interface Arrived {
    method: string;
    /** The request target as the server received it (path + query; a fragment is never sent). */
    url: string;
    body: string;
    headers: http.IncomingHttpHeaders;
}

export interface Answer {
    status: number;
    body?: unknown;
    /** Send no `Date` header (Node adds one by default). */
    noDate?: boolean;
    /** Extra response headers (e.g. a `location` for the redirect tests). */
    headers?: Record<string, string>;
}

export interface LoopbackServer {
    /** `http://127.0.0.1:<port>` */
    origin: string;
    port: number;
    /** Every request, in order. */
    arrived: Arrived[];
    /** The requests that are neither GET nor HEAD. */
    mutations(): Arrived[];
    reset(): void;
    close(): Promise<void>;
}

/** Starts the server; `answer` decides per request (default: 200 `{}`). */
export async function loopbackServer(answer: (req: Arrived) => Answer | undefined = () => undefined): Promise<LoopbackServer> {
    const arrived: Arrived[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const a: Arrived = { method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8'), headers: req.headers };
            arrived.push(a);
            const out = answer(a) ?? { status: 200, body: {} };
            res.statusCode = out.status;
            if (out.noDate) res.sendDate = false;
            res.setHeader('content-type', 'application/json');
            for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
            res.end(out.body === undefined ? '' : JSON.stringify(out.body));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    return {
        origin: `http://127.0.0.1:${port}`,
        port,
        arrived,
        mutations: () => arrived.filter((a) => a.method !== 'GET' && a.method !== 'HEAD'),
        reset: () => {
            arrived.length = 0;
        },
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
