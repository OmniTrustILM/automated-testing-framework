/** connectorApi — live connector health (by interface version) and read-only connector probes; everything here is a GET. */
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { hasRunFamilyPrefix } from '../run/runId';
import { pollUntil } from '../wait';
import type { JsonObject } from '../json';
import { DEFAULT_ADCS_CONNECTOR, DEFAULT_CREDENTIAL_CONNECTOR, settings } from '../run/settings';

export type ConnectorVersion = 1 | 2;

export function parseConnectorVersion(value: unknown): ConnectorVersion | undefined {
    if (value === 1 || value === 2) return value;
    if (typeof value !== 'string') return undefined;
    const m = /^\s*v?([12])\s*$/i.exec(value);
    return m ? (Number(m[1]) as ConnectorVersion) : undefined;
}

const healthPath = (uuid: string, version: ConnectorVersion): string => `/api/v${version}/connectors/${uuid}/health`;

export interface HealthVerdict {
    healthy: boolean;
    status?: string;
    why: string;
}

/** The health oracle (pure): v1 → 200 and `status` `ok`; v2 → 200 and `status` `UP`; anything else is unhealthy. */
export function judgeHealth(version: ConnectorVersion, httpStatus: number, body: unknown): HealthVerdict {
    const status = typeof (body as JsonObject | null)?.status === 'string' ? String((body as JsonObject).status) : undefined;
    if (httpStatus !== 200) return { healthy: false, status, why: `live health ${httpStatus}` };
    const wanted = version === 1 ? 'ok' : 'UP';
    if (status === wanted) return { healthy: true, status, why: `v${version} status ${status}` };
    return { healthy: false, status, why: status ? `v${version} status ${status} (expected ${wanted})` : `v${version} health body without a status` };
}

export interface ConnectorRow {
    uuid: string;
    name: string;
    status?: string;
}

export async function listConnectors(api: APIRequestContext): Promise<ConnectorRow[]> {
    const res = await api.get('/api/v1/connectors');
    if (!res.ok()) throw new Error(`GET /api/v1/connectors answered ${res.status()}`);
    const rows = (await res.json()) as JsonObject[];
    return rows.map((r) => ({ uuid: String(r.uuid), name: String(r.name), status: typeof r.status === 'string' ? r.status : undefined }));
}

export async function findConnector(api: APIRequestContext, name: string): Promise<ConnectorRow | undefined> {
    return (await listConnectors(api)).find((c) => c.name === name);
}

export interface VersionResult {
    version?: ConnectorVersion;
    detailStatus: number;
    detail?: JsonObject;
}

export async function connectorVersion(api: APIRequestContext, uuid: string): Promise<VersionResult> {
    const res = await api.get(`/api/v2/connectors/${uuid}`);
    if (!res.ok()) return { detailStatus: res.status() };
    const detail = (await res.json()) as JsonObject;
    return { version: parseConnectorVersion(detail.version), detailStatus: res.status(), detail };
}

export interface HealthResult extends HealthVerdict {
    name: string;
    uuid: string;
    storedStatus?: string;
    version?: ConnectorVersion;
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

/** Live health by the connector's version (from the v2 detail); an unknown version is unhealthy, never a guess. */
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

export function describeHealth(h: HealthResult): string {
    return `connector ${h.name}: stored ${h.storedStatus ?? 'unknown'}, ${h.why}`;
}

export type AliveResult = HealthResult | { name: string; missing: true };

export async function connectorsAlive(api: APIRequestContext, names: string[]): Promise<AliveResult[]> {
    const all = await listConnectors(api);
    const out: AliveResult[] = [];
    for (const name of names) {
        const c = all.find((x) => x.name === name);
        out.push(c ? await healthByVersion(api, c) : { name, missing: true });
    }
    return out;
}

/** Polls `healthByVersion` until healthy; fails fast when the version cannot be read. */
export async function waitForHealthy(api: APIRequestContext, connector: ConnectorRow, timeoutMs = 30_000, intervalMs = 2_000): Promise<HealthResult> {
    const h = await pollUntil(
        async () => {
            const result = await healthByVersion(api, connector);
            if (!result.healthy && !result.version) throw new Error(`${describeHealth(result)}: not retried`);
            return result;
        },
        (result) => result.healthy,
        { timeoutMs, intervalMs, tolerateErrors: 0, onTimeout: 'return' },
    );
    if (!h.healthy) throw new Error(`${describeHealth(h)} after ${timeoutMs} ms`);
    return h;
}


export interface ProbeResult {
    ok: boolean;
    what: string;
    httpStatus: number;
    why: string;
}

const nonEmptyAttributeMap = (body: unknown): boolean => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    return Object.values(body as JsonObject).some((kinds) => kinds && typeof kinds === 'object' && Object.values(kinds as JsonObject).some((list) => Array.isArray(list) && list.length > 0));
};

/**
 * One read-only attribute call through the connector. v1: `GET /v1/connectors/{uuid}/attributes` → 200 and a non-empty list.
 * v2: `GET /v2/connectors/{uuid}/info` → 200; then, for a connected authority
 * the run did not create, its raProfile attributes → 200 and a non-empty list.
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
    const onConnector = ((await authorities.json()) as JsonObject[]).find(
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


export const PROBE_PATHS = {
    health: '/api/v1/health',
    liveness: '/api/v1/health/liveness',
    readiness: '/api/v1/health/readiness',
    info: '/api/v1/info',
} as const;

const HEALTH_GROUP_BODY = { status: 'UP' } as const;

export function healthGroupProblems(answer: { status: number; json?: unknown }): string[] {
    const problems: string[] = [];
    if (answer.status !== 200) problems.push(`status ${answer.status}, expected 200`);
    if (JSON.stringify(answer.json) !== JSON.stringify(HEALTH_GROUP_BODY)) problems.push(`body ${JSON.stringify(answer.json)}, expected ${JSON.stringify(HEALTH_GROUP_BODY)}`);
    return problems;
}

export const isHealthGroupUp = (answer: { status: number; json?: unknown }): boolean => healthGroupProblems(answer).length === 0;

export function expectHealthGroupUp(answer: { status: number; json?: unknown; text?: string }, which: string): void {
    expect(healthGroupProblems(answer), `${which}: ${(answer.text ?? JSON.stringify(answer.json) ?? '').slice(0, 200)}`).toEqual([]);
}

export const ACCEPT_JSON = { Accept: 'application/json' } as const;

/*
 * Anonymous GETs are sent by the spec on the `request` fixture (no Authorization, no session cookie), which the deny-by-default
 * lint allows only in a spec. Behind the frontend dev proxy of a local stack the call is not anonymous (annotate, do not assert 401).
 */


const DEFAULT_REQUIRED_CONNECTORS = [DEFAULT_CREDENTIAL_CONNECTOR, DEFAULT_ADCS_CONNECTOR];

export function requiredConnectors(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = settings(env).requiredConnectors;
    const list = (raw ?? DEFAULT_REQUIRED_CONNECTORS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
    return [...new Set(list)];
}

/**
 * REG_BLOCKED_CONNECTORS = `name:reason;name2:reason2`: connectors whose REG-DEP-01.d test is skipped with that reason; an entry without a
 * reason is refused.
 */
export function blockedConnectors(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
    const out = new Map<string, string>();
    const raw = settings(env).blockedConnectors;
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
