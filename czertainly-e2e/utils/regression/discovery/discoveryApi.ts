/**
 * discoveryApi — own network discoveries of both generations through the guarded API: finds the healthy v1 and v2 discovery
 * connector (a missing one is a named deploy gate) and creates, probes, controls and reads discoveries.
 * Targets are only the run's own TLS target or RFC 5737 documentation ranges; every run is recorded before any assertion.
 */

import { waitForDiscoveryCompletion } from '../../discoveryUtils';
import type { WaitForDiscoveryOptions } from '../../discoveryUtils';
import { Logger } from '../../Logger';
import { connectorVersion, healthByVersion, listConnectors } from '../platform/connectorApi';
import { GuardedApi } from '../guard/types';
import { checkOwnership } from '../ledger/ownership';
import { recordDerivedKeyOf } from '../issuedRecords';
import { createdAfterMarker, OwnRef, recordDerived } from '../ledger/ledger';
import { ownName } from '../ledger/runState';
import { pollUntil } from '../wait';
import { sendJson } from '../events/workflowRequests';
import { ApiAnswer } from '../apiReads';
import { createOwn, probeCollectionCreate } from '../ownCrud';
import { settings } from '../run/settings';
import type { JsonObject } from '../json';

const logger = new Logger('DiscoveryApi');

export type Generation = 'v1' | 'v2';
export const IP_KIND = 'IP-Hostname';

export interface DiscoveryConnector {
    uuid: string;
    name: string;
    generation: Generation;
    kind?: string;
    interfaceUuid?: string;
    unhealthy?: string;
}

export interface DiscoveryTier {
    v1?: DiscoveryConnector;
    v2?: DiscoveryConnector;
    problems: { v1?: string; v2?: string };
}

/**
 * The tier's IP discovery registrations, read-only; health is read live and by version (an unhealthy registration is reported, not used).
 * REG_DISCOVERY_V1_CONNECTOR / _V2_CONNECTOR pick one when several exist.
 */
export async function findDiscoveryConnectors(api: GuardedApi, env: NodeJS.ProcessEnv = process.env): Promise<DiscoveryTier> {
    const tier: DiscoveryTier = { problems: {} };
    const rows = await listConnectors(api);
    const raw = await api.get('/api/v1/connectors');
    const listing = raw.ok() ? ((await raw.json()) as JsonObject[]) : [];
    const wanted: Record<Generation, string | undefined> = { v1: settings(env).discoveryV1Connector, v2: settings(env).discoveryV2Connector };
    const why: string[] = [];
    for (const row of rows) {
        if (row.status !== 'connected') continue;
        const { version, detail } = await connectorVersion(api, row.uuid);
        if (!version || !detail) continue;
        const listed = listing.find((c) => c.uuid === row.uuid) ?? {};
        const groups = (detail.functionGroups ?? listed.functionGroups ?? []) as JsonObject[];
        const discoveryInterface = ((detail.interfaces ?? []) as JsonObject[]).find((i) => i.code === 'discovery');
        const kind = ((groups.find((g) => g.functionGroupCode === 'discoveryProvider' && ((g.kinds ?? []) as string[]).includes(IP_KIND))?.kinds ?? []) as string[]).find((k) => k === IP_KIND);
        let candidate: DiscoveryConnector | undefined;
        if (version === 1 && kind) candidate = { uuid: row.uuid, name: row.name, generation: 'v1', kind };
        else if (version === 2 && discoveryInterface) candidate = { uuid: row.uuid, name: row.name, generation: 'v2', interfaceUuid: String(discoveryInterface.uuid) };
        if (!candidate) continue;
        if (wanted[candidate.generation] && wanted[candidate.generation] !== candidate.name) continue;
        if (tier[candidate.generation]) continue;
        if (candidate.generation === 'v2') {
            const res = await api.get(`/api/v1/discoveries/${candidate.uuid}/resources`);
            const resources = res.ok() ? ((await res.json()) as JsonObject[]).map((r) => String(r.resource)) : [];
            if (!resources.includes('certificates')) {
                why.push(`${candidate.name}: no certificates resource`);
                continue;
            }
        }
        const health = await healthByVersion(api, row);
        if (!health.healthy) tier.problems[candidate.generation] = `${candidate.name}: ${health.why}`;
        else tier[candidate.generation] = candidate;
    }
    for (const g of ['v1', 'v2'] as const) {
        if (!tier[g] && !tier.problems[g]) tier.problems[g] = `no connected ${g.toUpperCase()} IP discovery registration${why.length ? ` (${why.join('; ')})` : ''}`;
    }
    return tier;
}

export function generationGate(tier: DiscoveryTier, g: Generation): string | undefined {
    return tier[g] ? undefined : `deploy gate: ${tier.problems[g] ?? `no ${g} discovery connector`} (@needs:${g}-discovery)`;
}


const def = (defs: JsonObject[], name: string): JsonObject => {
    const d = defs.find((x) => x.name === name);
    if (!d) throw new Error(`the discovery connector offers no attribute ${name} (offers: ${defs.map((x) => x.name).join(', ')})`);
    return d;
};

/**
 * The run-level attribute definitions of a connector (v1 `attributes/discoveryProvider/<kind>`, v2 `GET
 * /v1/discoveries/{uuid}/attributes`).
 */
export async function runDefinitions(api: GuardedApi, c: DiscoveryConnector): Promise<JsonObject[]> {
    const url = c.generation === 'v1' ? `/api/v1/connectors/${c.uuid}/attributes/discoveryProvider/${c.kind ?? IP_KIND}` : `/api/v1/discoveries/${c.uuid}/attributes`;
    const res = await api.get(url);
    if (!res.ok()) throw new Error(`GET ${url} answered ${res.status()}`);
    return (await res.json()) as JsonObject[];
}

export interface Target {
    hosts: string[];
    ports?: string[];
    parallel?: number;
}

export function v1Attributes(defs: JsonObject[], t: Partial<Target> & { allPorts?: boolean }): JsonObject[] {
    const out: JsonObject[] = [];
    const attr = (name: string, content: JsonObject[]) => {
        const d = def(defs, name);
        out.push({ uuid: d.uuid, name: d.name, contentType: d.contentType, content });
    };
    if (t.hosts) attr('ip', [{ data: t.hosts.join(',') }]);
    if (t.ports) attr('port', [{ data: t.ports.join(',') }]);
    if (t.allPorts !== undefined) attr('allPorts', [{ data: t.allPorts }]);
    if (t.parallel !== undefined) attr('data_parallel_executions', [{ data: t.parallel }]);
    return out;
}

export function v2Attributes(defs: JsonObject[], t: Partial<Target>): JsonObject[] {
    const out: JsonObject[] = [];
    const attr = (name: string, contentType: string, items: unknown[]) => {
        const d = def(defs, name);
        out.push({ version: 'v3', uuid: d.uuid, name: d.name, contentType, content: items.map((data) => ({ contentType, data })) });
    };
    if (t.hosts) attr('data_hosts', 'string', t.hosts);
    if (t.ports) attr('data_ports', 'string', t.ports);
    if (t.parallel !== undefined) attr('data_parallelExecutions', 'integer', [t.parallel]);
    return out;
}

export interface CreateOptions {
    connector: DiscoveryConnector;
    target?: Target;
    triggers?: Array<{ uuid: string }>;
    resources?: string[];
    body?: JsonObject;
    name?: string;
}

export function discoveryBody(c: DiscoveryConnector, name: string, attributes: JsonObject[], o: Pick<CreateOptions, 'triggers' | 'resources' | 'body'> = {}): JsonObject {
    return {
        name,
        connectorUuid: c.uuid,
        ...(c.generation === 'v1' ? { kind: c.kind ?? IP_KIND } : { interfaceUuid: c.interfaceUuid, resources: o.resources ?? ['certificates'] }),
        attributes,
        customAttributes: [],
        ...(o.triggers ? { triggers: o.triggers.map((t) => t.uuid) } : {}),
        ...(o.body ?? {}),
    };
}

export interface OwnDiscovery extends OwnRef {
    generation: Generation;
    connector: DiscoveryConnector;
    body: JsonObject;
}

export async function createOwnDiscovery(api: GuardedApi, spec: string, suffix: string, o: CreateOptions): Promise<OwnDiscovery> {
    const c = o.connector;
    const defs = await runDefinitions(api, c);
    const target = o.target ?? { hosts: [] };
    const attributes = c.generation === 'v1' ? v1Attributes(defs, target) : v2Attributes(defs, target);
    const name = o.name ?? ownName(suffix);
    const { name: _name, ...body } = discoveryBody(c, name, attributes, o);
    const { answer, ...ref } = await createOwn(api, spec, { type: 'discoveries', path: '/api/v1/discoveries', name, body, note: `${c.generation} IP discovery run` });
    return { ...ref, generation: c.generation, connector: c, body: answer.json };
}

export async function probeDiscovery(api: GuardedApi, spec: string, body: JsonObject): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, { type: 'discoveries', path: '/api/v1/discoveries', body, note: 'discovery create probe' });
}


export interface DiscoveryDetail extends JsonObject {
    uuid: string;
    name: string;
    status: string;
    connectorStatus: string;
    message?: string;
    startTime?: string;
    endTime?: string;
    totalCertificatesDiscovered?: number;
    connectorTotalCertificatesDiscovered?: number;
    connectorInterface?: JsonObject | null;
    stoppable?: boolean | null;
    itemsDiscovered?: number | null;
    itemsNewlyDiscovered?: number;
    itemsProcessed?: number;
    itemsFailed?: number;
    progress?: JsonObject | null;
    runMessageCount?: number;
    triggers?: JsonObject[];
    metadata?: JsonObject[];
}

export async function getDiscovery(api: GuardedApi, uuid: string): Promise<DiscoveryDetail> {
    const sent = await sendJson(api, 'GET', `/api/v1/discoveries/${uuid}`);
    if (sent.status !== 200) throw new Error(`GET discovery ${uuid} answered ${sent.status}`);
    return sent.json as DiscoveryDetail;
}

export interface DiscoveryCertificate extends JsonObject {
    uuid: string;
    inventoryUuid?: string | null;
    commonName?: string;
    fingerprint?: string;
    newlyDiscovered: boolean;
    processed: boolean;
    processedError?: string | null;
}

export async function listDiscoveredCertificates(api: GuardedApi, uuid: string, newlyDiscovered?: boolean): Promise<DiscoveryCertificate[]> {
    const rows: DiscoveryCertificate[] = [];
    for (let page = 1; ; page++) {
        const q = `itemsPerPage=100&pageNumber=${page}${newlyDiscovered === undefined ? '' : `&newlyDiscovered=${newlyDiscovered}`}`;
        const sent = await sendJson(api, 'GET', `/api/v1/discoveries/${uuid}/certificates?${q}`);
        if (sent.status !== 200) throw new Error(`GET discovery certificates ${uuid} answered ${sent.status}`);
        rows.push(...((sent.json.certificates ?? []) as DiscoveryCertificate[]));
        if (page >= Number(sent.json.totalPages ?? 0)) break;
    }
    return rows;
}

export async function findDiscoveriesByName(api: GuardedApi, name: string): Promise<JsonObject[]> {
    const sent = await sendJson(api, 'POST', '/api/v1/discoveries/list', {
        itemsPerPage: 100,
        pageNumber: 1,
        filters: [{ fieldSource: 'property', fieldIdentifier: 'DISCOVERY_NAME', condition: 'EQUALS', value: name }],
    });
    if (sent.status !== 200) throw new Error(`POST /v1/discoveries/list answered ${sent.status} ${sent.text.slice(0, 200)}`);
    return (sent.json?.discoveries ?? []) as JsonObject[];
}


export type RunControl = 'stop' | 'resume' | 'cancel';

/** `PATCH /v1/discoveries/{uuid}/{stop|resume|cancel}`: the uuid is an own run or `api.probeUuid()`; any other is refused by the guard. */
export const controlDiscovery = (api: GuardedApi, uuid: string, op: RunControl): Promise<ApiAnswer> => sendJson(api, 'PATCH', `/api/v1/discoveries/${uuid}/${op}`);

export function waitForCompleted(api: GuardedApi, uuid: string, timeoutMs = 120_000, opts: WaitForDiscoveryOptions = {}): Promise<void> {
    return waitForDiscoveryCompletion(api, uuid, timeoutMs, opts);
}

export function waitForStatus(api: GuardedApi, uuid: string, status: string, timeoutMs = 60_000): Promise<void> {
    return waitForDiscoveryCompletion(api, uuid, timeoutMs, { expected: { status }, failOn: status === 'failed' ? [] : ['failed'] });
}

/**
 * Polls the run until `completed` and returns every distinct status it showed, in order (a fast run may skip a state between polls). Fails
 * fast on `failed`.
 */
export async function observeUntilCompleted(api: GuardedApi, uuid: string, timeoutMs = 180_000, intervalMs = 1_500): Promise<string[]> {
    const seen: string[] = [];
    const last = await pollUntil(
        async () => {
            const d = await getDiscovery(api, uuid);
            if (seen[seen.length - 1] !== d.status) seen.push(d.status);
            if (d.status === 'failed') throw new Error(`discovery ${uuid} failed: ${d.message ?? ''} (seen ${seen.join(' → ')})`);
            return d.status;
        },
        (status) => status === 'completed',
        { timeoutMs, intervalMs, tolerateErrors: 0, onTimeout: 'return' },
    );
    if (last !== 'completed') throw new Error(`discovery ${uuid} did not complete within ${timeoutMs} ms (seen ${seen.join(' → ')})`);
    return seen;
}

export function metadataNumber(detail: DiscoveryDetail, name: string): number | undefined {
    for (const group of (detail.metadata ?? []) as Array<{ items?: Array<{ name?: string; content?: Array<{ data?: unknown }> }> }>) {
        for (const item of group.items ?? []) {
            if (item.name === name) {
                const v = item.content?.[0]?.data;
                return typeof v === 'number' ? v : Number(v);
            }
        }
    }
    return undefined;
}

export const isSubsequence = (sub: string[], seq: string[]): boolean => {
    let i = 0;
    for (const x of seq) if (x === sub[i]) i += 1;
    return i === sub.length;
};


/**
 * Records the certificates the run onboarded as NEW (and their linked keys) as `derived` ledger lines, so the teardown deletes them when
 * nobody adopted them. Idempotent.
 */
export async function recordOnboarded(api: GuardedApi, spec: string, run: { uuid: string }): Promise<string[]> {
    const detail = await getDiscovery(api, run.uuid);
    const serverStart = detail.startTime;
    if (!serverStart) throw new Error(`discovery ${run.uuid} has no startTime: the derived lines need a server timestamp`);
    const createdAfter = createdAfterMarker(serverStart);
    const rows = await listDiscoveredCertificates(api, run.uuid, true);
    const known = new Set<string>();
    for (const r of rows) {
        const uuid = r.inventoryUuid;
        if (!uuid) continue;
        if (!checkOwnership({ uuid }).own) {
            recordDerived('certificates', { uuid, name: r.commonName ?? `onboarded by discovery ${run.uuid}` }, { spec, createdAfter, note: 'new in the inventory through an own discovery', parents: { discovery: run.uuid } });
        }
        await recordDerivedKeyOf(api, uuid, createdAfter, spec);
        known.add(uuid);
    }
    logger.info(`discovery ${run.uuid}: ${known.size} onboarded certificate(s) recorded as derived`);
    return [...known];
}

export const fingerprintSet = (rows: Array<{ fingerprint?: string }>): string[] =>
    [...new Set(rows.map((r) => String(r.fingerprint ?? '').replace(/[:\s]/g, '').toLowerCase()).filter(Boolean))].sort();

export async function getInventoryCertificate(api: GuardedApi, uuid: string): Promise<JsonObject> {
    const sent = await sendJson(api, 'GET', `/api/v1/certificates/${uuid}`);
    if (sent.status !== 200) throw new Error(`GET certificate ${uuid} answered ${sent.status}`);
    return sent.json as JsonObject;
}

export async function getCertificateHistory(api: GuardedApi, uuid: string): Promise<JsonObject[]> {
    const sent = await sendJson(api, 'GET', `/api/v1/certificates/${uuid}/history`);
    if (sent.status !== 200) throw new Error(`GET certificate history ${uuid} answered ${sent.status}`);
    return (sent.json ?? []) as JsonObject[];
}

export async function countCertificates(api: GuardedApi, filters: JsonObject[]): Promise<number> {
    const sent = await sendJson(api, 'POST', '/api/v1/certificates', { itemsPerPage: 1, pageNumber: 1, filters });
    if (sent.status !== 200) throw new Error(`POST /v1/certificates answered ${sent.status}`);
    return Number(sent.json?.totalItems ?? 0);
}
