/**
 * connectorApi — live connector health and read-only connector probes for the REG-* / API-* specs (B1: REG-DEP-01.a…d,
 * the CA choice of `ensureRaProfile`, the API-GEN-32 connector sentinel).
 *
 * WHY: the stored connector status (`connected`) says nothing about whether the connector answers now. On the shared
 * tiers the MS-ADCS-NG connector was `connected` while its health answered 503 (Phase 1 §10b), and REG-DEP-01 passed
 * on the stored status (a false pass). Health therefore is read LIVE and BY VERSION: a v1 connector answers
 * `GET /v1/connectors/{uuid}/health` with a `HealthDto` (`status` = `ok` | `nok` | `unknown`), a v2 connector answers
 * `GET /v2/connectors/{uuid}/health` with a `HealthInfo` (`status` = `UP` | `DEGRADED` | `DOWN` | `OUT_OF_SERVICE` |
 * `UNKNOWN`); a v2-only connector answers 404 on the v1 path (Phase 2 §C), so the version comes from the connector
 * detail (`GET /v2/connectors/{uuid}` → `version` = `v1` | `v2`, interfaces ConnectorVersion codes).
 * `utils/connectorUtils.checkConnectorHealth` (v1 only) stays as it is for the smoke suite.
 *
 * Everything here is a GET (deny by default, review Q2: the lint scans this module like the specs): connector health is
 * an ordinary read for the guard (author decision after fix pass 5), and so are the attribute-definition reads. The
 * anonymous probes take the `request` fixture (no credentials, no cookie): liveness / readiness / health / info.
 * Messages name connectors by their registration name (product names such as `EJBCA-NG-Connector`), never a host.
 */
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { hasRunFamilyPrefix } from './runId';

type Json = Record<string, any>;

export type ConnectorVersion = 1 | 2;

/** `v1` / `v2` (the interfaces ConnectorVersion codes, any case), or the numbers 1 / 2; anything else is undefined. */
export function parseConnectorVersion(value: unknown): ConnectorVersion | undefined {
    if (value === 1 || value === 2) return value;
    if (typeof value !== 'string') return undefined;
    const m = /^\s*v?([12])\s*$/i.exec(value);
    return m ? (Number(m[1]) as ConnectorVersion) : undefined;
}

/** The health path of a connector version. */
export const healthPath = (uuid: string, version: ConnectorVersion): string => `/api/v${version}/connectors/${uuid}/health`;

export interface HealthVerdict {
    healthy: boolean;
    /** The `status` the body carried (`ok`, `UP`, …), when there was one. */
    status?: string;
    /** One line: why healthy or not ("live health 503", "v2 status DOWN", …). */
    why: string;
}

/**
 * The health oracle of REG-DEP-01.d (pure): v1 → HTTP 200 and `status` = `ok`; v2 → HTTP 200 and `status` = `UP`.
 * A non-200 answer, a body without the status, or any other status value is unhealthy.
 */
export function judgeHealth(version: ConnectorVersion, httpStatus: number, body: unknown): HealthVerdict {
    const status = typeof (body as Json | null)?.status === 'string' ? String((body as Json).status) : undefined;
    if (httpStatus !== 200) return { healthy: false, status, why: `live health ${httpStatus}` };
    const wanted = version === 1 ? 'ok' : 'UP';
    if (status === wanted) return { healthy: true, status, why: `v${version} status ${status}` };
    return { healthy: false, status, why: status ? `v${version} status ${status} (expected ${wanted})` : `v${version} health body without a status` };
}

export interface ConnectorRow {
    uuid: string;
    name: string;
    /** The STORED status (`connected`, `waitingForApproval`, `failed`, `offline`). */
    status?: string;
}

/** `GET /api/v1/connectors` (every registered connector, v1 and v2 records). */
export async function listConnectors(api: APIRequestContext): Promise<ConnectorRow[]> {
    const res = await api.get('/api/v1/connectors');
    if (!res.ok()) throw new Error(`GET /api/v1/connectors answered ${res.status()}`);
    const rows = (await res.json()) as Json[];
    return rows.map((r) => ({ uuid: String(r.uuid), name: String(r.name), status: r.status }));
}

export async function findConnector(api: APIRequestContext, name: string): Promise<ConnectorRow | undefined> {
    return (await listConnectors(api)).find((c) => c.name === name);
}

export interface VersionResult {
    version?: ConnectorVersion;
    /** HTTP status of the detail read. */
    detailStatus: number;
    detail?: Json;
}

/** The connector's version from its v2 detail (`version`); undefined when the detail cannot be read or has none. */
export async function connectorVersion(api: APIRequestContext, uuid: string): Promise<VersionResult> {
    const res = await api.get(`/api/v2/connectors/${uuid}`);
    if (!res.ok()) return { detailStatus: res.status() };
    const detail = (await res.json()) as Json;
    return { version: parseConnectorVersion(detail.version), detailStatus: res.status(), detail };
}

export interface HealthResult extends HealthVerdict {
    name: string;
    uuid: string;
    storedStatus?: string;
    version?: ConnectorVersion;
    /** HTTP status of the health read (0: not read, the version was unknown). */
    httpStatus: number;
    body?: unknown;
    elapsedMs: number;
}

async function bodyOf(res: APIResponse): Promise<unknown> {
    const text = await res.text();
    try {
        return text ? JSON.parse(text) : undefined;
    } catch {
        return text;
    }
}

/**
 * Live health of one connector by its version (REG-DEP-01.d, the CA choice): the version from the v2 detail, then the
 * health path of THAT version. An unknown version is unhealthy ("version unknown"), never a guess.
 */
export async function healthByVersion(api: APIRequestContext, connector: ConnectorRow): Promise<HealthResult> {
    const started = Date.now();
    const { version, detailStatus } = await connectorVersion(api, connector.uuid);
    const base = { name: connector.name, uuid: connector.uuid, storedStatus: connector.status, version };
    if (!version) {
        return { ...base, healthy: false, why: `version unknown (connector detail answered ${detailStatus})`, httpStatus: 0, elapsedMs: Date.now() - started };
    }
    const res = await api.get(healthPath(connector.uuid, version));
    const body = await bodyOf(res);
    return { ...base, ...judgeHealth(version, res.status(), body), httpStatus: res.status(), body, elapsedMs: Date.now() - started };
}

/** One line for a failure message: "connector X: stored connected, live health 503". */
export function describeHealth(h: HealthResult): string {
    return `connector ${h.name}: stored ${h.storedStatus ?? 'unknown'}, ${h.why}`;
}

export type AliveResult = HealthResult | { name: string; missing: true };

/** Health of every named connector (a name that is not registered is `missing`). */
export async function connectorsAlive(api: APIRequestContext, names: string[]): Promise<AliveResult[]> {
    const all = await listConnectors(api);
    const out: AliveResult[] = [];
    for (const name of names) {
        const c = all.find((x) => x.name === name);
        out.push(c ? await healthByVersion(api, c) : { name, missing: true });
    }
    return out;
}

/**
 * Polls `healthByVersion` until healthy; fails fast when the version cannot be read (a 404 on the wrong version is
 * never retried into a pass) and with the last verdict at the timeout (phase-05 §6.2).
 */
export async function waitForHealthy(api: APIRequestContext, connector: ConnectorRow, timeoutMs = 30_000, intervalMs = 2_000): Promise<HealthResult> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const h = await healthByVersion(api, connector);
        if (h.healthy) return h;
        if (!h.version) throw new Error(`${describeHealth(h)}: not retried`);
        if (Date.now() > end) throw new Error(`${describeHealth(h)} after ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

// ------------------------------------------------------------------ read-only attribute probes (P-CONN)

export interface ProbeResult {
    ok: boolean;
    /** What was read ("GET …/attributes", "v2 info + RA-profile attributes of an authority"). */
    what: string;
    httpStatus: number;
    why: string;
}

const nonEmptyAttributeMap = (body: unknown): boolean => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    return Object.values(body as Json).some((kinds) => kinds && typeof kinds === 'object' && Object.values(kinds as Json).some((list) => Array.isArray(list) && list.length > 0));
};

/**
 * One read-only attribute call through the connector (REG-DEP-01.d, P-CONN probe column; API-GEN-32 connector
 * sentinel): core asks the connector live and answers its attribute definitions.
 * - v1: `GET /v1/connectors/{uuid}/attributes` (every function group and kind) → 200 and at least one non-empty list;
 * - v2: `GET /v2/connectors/{uuid}/info` → 200 and an object; then, when a connected authority that the run did not
 *   create lives on the connector, `GET /v1/authorities/{authority}/attributes/raProfile` → 200 and a non-empty list
 *   (the call that failed with 503 on the shared tiers, Phase 1 §10b).
 * Reads only; nothing is created.
 */
export async function probeAttributes(api: APIRequestContext, connector: ConnectorRow, version: ConnectorVersion): Promise<ProbeResult> {
    if (version === 1) {
        const what = 'GET /v1/connectors/{uuid}/attributes';
        const res = await api.get(`/api/v1/connectors/${connector.uuid}/attributes`);
        const body = await bodyOf(res);
        if (res.status() !== 200) return { ok: false, what, httpStatus: res.status(), why: `attribute probe ${res.status()}` };
        return nonEmptyAttributeMap(body)
            ? { ok: true, what, httpStatus: 200, why: 'attribute definitions listed' }
            : { ok: false, what, httpStatus: 200, why: 'attribute probe answered no attribute definition' };
    }
    const info = await api.get(`/api/v2/connectors/${connector.uuid}/info`);
    const infoBody = await bodyOf(info);
    if (info.status() !== 200 || !infoBody || typeof infoBody !== 'object') {
        return { ok: false, what: 'GET /v2/connectors/{uuid}/info', httpStatus: info.status(), why: `info probe ${info.status()}` };
    }
    const authorities = await api.get('/api/v1/authorities');
    if (!authorities.ok()) return { ok: false, what: 'GET /v1/authorities', httpStatus: authorities.status(), why: `authority list ${authorities.status()}` };
    const onConnector = ((await authorities.json()) as Json[]).find(
        (a) => a.connectorUuid === connector.uuid && a.status === 'connected' && !hasRunFamilyPrefix(String(a.name)),
    );
    if (!onConnector) return { ok: true, what: 'GET /v2/connectors/{uuid}/info', httpStatus: 200, why: 'info answered (no authority on the connector to probe further)' };
    const what = 'GET /v2/connectors/{uuid}/info + GET /v1/authorities/{authority}/attributes/raProfile';
    const ra = await api.get(`/api/v1/authorities/${onConnector.uuid}/attributes/raProfile`);
    const raBody = await bodyOf(ra);
    if (ra.status() !== 200) return { ok: false, what, httpStatus: ra.status(), why: `RA-profile attribute probe ${ra.status()}` };
    return Array.isArray(raBody) && raBody.length > 0
        ? { ok: true, what, httpStatus: 200, why: 'info and RA-profile attribute definitions answered' }
        : { ok: false, what, httpStatus: 200, why: 'RA-profile attribute probe answered an empty list' };
}

// ------------------------------------------------------------------ anonymous probes (REG-DEP-01.a–c)

export const PROBE_PATHS = {
    health: '/api/v1/health',
    liveness: '/api/v1/health/liveness',
    readiness: '/api/v1/health/readiness',
    info: '/api/v1/info',
} as const;

export interface AnonymousProbe {
    status: number;
    /** Parsed JSON body, or undefined when the body is empty or not JSON. */
    json?: unknown;
    text: string;
    contentType: string;
    elapsedMs: number;
}

/** The Accept header of the anonymous probes. */
export const ACCEPT_JSON = { Accept: 'application/json' } as const;

/**
 * Reads the answer of an anonymous GET (REG-DEP-01.a–c, API-GEN-32[health], REG-USE-07.1). The spec sends the GET itself
 * on the `request` fixture (no Authorization header, no session cookie): the deny-by-default lint allows that fixture
 * for a GET written in the spec, never handed to a helper. On a local stack whose BASE_URL is the frontend dev proxy
 * the proxy adds the admin certificate (AUTH_MODE=header), so such a call is not anonymous there (callers annotate
 * instead of asserting 401).
 */
export async function readProbe(res: APIResponse, elapsedMs: number): Promise<AnonymousProbe> {
    const text = await res.text();
    let json: unknown;
    try {
        json = text ? JSON.parse(text) : undefined;
    } catch {
        json = undefined;
    }
    return { status: res.status(), json, text, contentType: res.headers()['content-type'] ?? '', elapsedMs };
}

// ------------------------------------------------------------------ the REG-DEP-01.d connector list (pure)

export const DEFAULT_REQUIRED_CONNECTORS = ['Common-Credential-Connector', 'MS-ADCS-NG-Connector'];

/** REG_REQUIRED_CONNECTORS (comma list) or the default: the credential and the ADCS connector. */
export function requiredConnectors(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = env.REG_REQUIRED_CONNECTORS;
    const list = (raw ?? DEFAULT_REQUIRED_CONNECTORS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
    return [...new Set(list)];
}

/**
 * REG_BLOCKED_CONNECTORS = `name:reason;name2:reason2` (`;` between entries; the reason may hold `:` and `,`): the
 * connectors whose REG-DEP-01.d test is skipped with that reason (an environment blocker with a Blockers row, never a
 * pass). An entry without a reason is refused (a skip always names its reason).
 */
export function blockedConnectors(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
    const out = new Map<string, string>();
    const raw = env.REG_BLOCKED_CONNECTORS;
    if (!raw || !raw.trim()) return out;
    for (const entry of raw.split(';').map((s) => s.trim()).filter(Boolean)) {
        const i = entry.indexOf(':');
        const name = i < 0 ? '' : entry.slice(0, i).trim();
        const reason = i < 0 ? '' : entry.slice(i + 1).trim();
        if (!name || !reason) throw new Error(`REG_BLOCKED_CONNECTORS entry "${entry}" is not name:reason (a skip must name its reason)`);
        out.set(name, reason);
    }
    return out;
}
