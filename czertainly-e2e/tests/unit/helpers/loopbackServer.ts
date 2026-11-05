/**
 * loopbackServer — a fake HTTP server on the loopback interface for the unit tests. `loopbackServer(answer)` listens on
 * 127.0.0.1 with a random port, records every request (method, path as received, body, headers) and answers what
 * `answer` returns (default 200 `{}`).
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
    noDate?: boolean;
    headers?: Record<string, string>;
}

export interface LoopbackServer {
    origin: string;
    port: number;
    /** Every request, in order. */
    arrived: Arrived[];
    mutations(): Arrived[];
    reset(): void;
    close(): Promise<void>;
}

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
