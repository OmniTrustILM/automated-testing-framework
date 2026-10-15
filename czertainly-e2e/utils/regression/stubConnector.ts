/**
 * stubConnector — an in-test HTTP stub of a Connector NG (v2) for REG-CONN-13 (`@local`, `@phaseB`): it answers the
 * mandatory interfaces (`/v2/info`, `/v2/health`, `/v2/metrics`), an attributes v2 interface whose single callback
 * ECHOES the request body it receives, and records every request, so a test can assert that the free-form JSON core
 * forwards through `POST /v2/connectors/{uuid}/callback` reaches the connector byte-for-byte (Jackson 2 pin, core#2472;
 * A4 r15). Fault injection (`answerWith`) serves the error-map rows later (P-ERRMAP, B5).
 *
 * Network: the server listens on 127.0.0.1 (random port; `REG_STUB_BIND_HOST=0.0.0.0` for a docker bridge). Core, in its container, reaches it through the
 * advertised host (`REG_STUB_ADVERTISED_HOST`, default the Docker host-gateway alias `host.docker.internal`): a
 * registration URL, not a tier host. Registration is an ADMIN create (`POST /v2/connectors`, ends `connected`, A4 r2),
 * recorded under `connectors`, deleted by the run-end teardown; approve / register are platform-denied and not used.
 * Spec-side: the `http` module is used here only to SERVE (the lint's raw-network rule is for specs; helpers may serve).
 */
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { GuardedApi } from './guardedApi';
import { apiJson } from './regressionApi';
import { OwnRef, recordCreated, regName, RUN_ID } from './regressionRun';

type Json = Record<string, any>;

export interface StubRequest {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
    json?: unknown;
}

export interface StubAnswer {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
}

export const CALLBACK_ATTRIBUTE = { uuid: '7d4f1a3e-2b6c-4e8f-9a1d-3c5e7f9b1d2a', name: 'data_echo' } as const;

/** The `/v2/info` document of the stub (interfaces: info, health, metrics, attributes; one functional `authority`-free stub needs a functional interface: `discovery`). */
export function infoDocument(name: string, port: number): Json {
    return {
        name,
        version: '0.0.0-qa',
        description: `ilm#448 regression stub ${RUN_ID}`,
        metadata: { port },
        interfaces: [
            { code: 'info', version: 'v2', category: 'MANDATORY' },
            { code: 'health', version: 'v2', category: 'MANDATORY' },
            { code: 'metrics', version: 'v1', category: 'MANDATORY', features: ['openMetrics'] },
            { code: 'attributes', version: 'v2', category: 'COMMON' },
            { code: 'discovery', version: 'v2', category: 'FUNCTIONAL', features: [] },
        ],
    };
}

export class StubConnector {
    readonly requests: StubRequest[] = [];
    private server?: http.Server;
    private port = 0;
    private faults = new Map<string, StubAnswer>();
    readonly name: string;

    constructor(suffix = 'stub') {
        this.name = regName(suffix);
    }

    /** Answer a path with a fixed status / body from now on (fault injection); `undefined` clears it. */
    answerWith(path: string, answer?: StubAnswer): void {
        if (answer) this.faults.set(path, answer);
        else this.faults.delete(path);
    }

    /** The callback requests received so far (what core forwarded), parsed. */
    callbacks(): StubRequest[] {
        return this.requests.filter((r) => r.method === 'POST' && /\/v2\/attributes\/callback$/.test(r.url.split('?')[0]));
    }

    private answer(req: StubRequest): StubAnswer {
        const path = req.url.split('?')[0];
        const fault = this.faults.get(path);
        if (fault) return fault;
        if (path === '/v2/info') return { status: 200, body: infoDocument(this.name, this.port) };
        if (path === '/v2/health' || path === '/v2/health/liveness' || path === '/v2/health/readiness') {
            return { status: 200, body: { status: 'UP', components: { liveness: { status: 'UP' }, readiness: { status: 'UP' } } } };
        }
        if (path === '/v2/metrics' || path === '/v1/metrics') return { status: 200, body: '# HELP qa_stub_up 1\nqa_stub_up 1\n', headers: { 'content-type': 'text/plain; version=0.0.4' } };
        if (path === '/v2/attributes' || path === '/v2/discovery/attributes' || path === '/v2/attributes/discovery') {
            return {
                status: 200,
                body: [{
                    uuid: CALLBACK_ATTRIBUTE.uuid, name: CALLBACK_ATTRIBUTE.name, type: 'data', contentType: 'string', version: 'v3',
                    description: 'echoes the callback request body', properties: { label: 'Echo', required: false, list: true, visible: true },
                    attributeCallback: { dependsOn: [], mappings: [] },
                }],
            };
        }
        if (path === '/v2/attributes/callback' && req.method === 'POST') return { status: 200, body: { received: req.json ?? null, content: [] } };
        return { status: 404, body: { title: 'Not found', status: 404 } };
    }

    async start(): Promise<{ port: number }> {
        this.server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                let json: unknown;
                try {
                    json = body ? JSON.parse(body) : undefined;
                } catch {
                    json = undefined;
                }
                const record: StubRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, json };
                this.requests.push(record);
                const out = this.answer(record);
                res.statusCode = out.status;
                res.setHeader('content-type', typeof out.body === 'string' ? 'text/plain' : 'application/json');
                for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
                res.end(out.body === undefined ? '' : typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
            });
        });
        // 127.0.0.1 by default; `REG_STUB_BIND_HOST=0.0.0.0` when core sits on a docker bridge that cannot reach the loopback (Sonnet F11).
        const bind = process.env.REG_STUB_BIND_HOST || '127.0.0.1';
        if (!/^(127\.0\.0\.1|0\.0\.0\.0|::1|::)$/.test(bind)) throw new Error('REG_STUB_BIND_HOST must be a loopback or the any-address (0.0.0.0): the stub is never bound to a named interface');
        await new Promise<void>((resolve) => this.server!.listen(0, bind, () => resolve()));
        this.port = (this.server!.address() as AddressInfo).port;
        return { port: this.port };
    }

    /** The loopback origin (for the unit tests). */
    get origin(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    /** The URL core registers: the advertised host (docker gateway alias by default) and this port. */
    advertisedUrl(env: NodeJS.ProcessEnv = process.env): string {
        return `http://${env.REG_STUB_ADVERTISED_HOST || 'host.docker.internal'}:${this.port}`;
    }

    async close(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        this.server = undefined;
    }

    /**
     * Registers the stub as an own connector through the ADMIN create (`POST /v2/connectors`, `authType none`,
     * version v2): recorded under `connectors` before any assertion. Core probes `/v2/info` during the create.
     */
    async register(api: GuardedApi, spec: string, env: NodeJS.ProcessEnv = process.env): Promise<OwnRef & { detail: Json }> {
        const created = await apiJson<Json>(api, 'POST', '/api/v2/connectors', {
            name: this.name, url: this.advertisedUrl(env), authType: 'none', authAttributes: [], customAttributes: [], version: 'v2',
        });
        const ref = recordCreated('connectors', { uuid: String(created.uuid), name: this.name }, spec, 'in-test stub connector (admin create, connected)');
        return { ...ref, detail: created };
    }
}

/** A free-form document that exercises every JSON value kind the callback must carry intact (REG-CONN-13). */
export function callbackProbeDocument(): Json {
    return {
        nested: { deeper: { list: [1, 2, { three: 3 }], text: 'ünïcödé — 日本語 🙂', empty: {} } },
        array: ['a', 1, true, null, 1.5, { k: 'v' }],
        nullValue: null,
        unicode: 'žluťoučký kůň',
        largeInteger: 9007199254740991,
        negative: -42,
        isoDate: '2026-10-14T12:34:56.789Z',
        bool: false,
        emptyList: [],
    };
}
