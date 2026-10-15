/**
 * discoveryApi — network discovery through the guarded API for the API-DISC / REG-DISC rows (events-discovery area).
 *
 * Both generations (`@needs:v1-discovery` / `@needs:v2-discovery`): the generation is how the IP discovery connector was
 * REGISTERED (T8 rule 2), so the helpers find a healthy v1 and a healthy v2 registration (`findDiscoveryConnectors`; a missing
 * one is a named deploy gate, never a pass) and build the generation's run attributes from the connector's LIVE definitions:
 * v1 `ip` / `port` / `allPorts` / `data_parallel_executions` (kind `IP-Hostname`), v2 `data_hosts` / `data_ports` /
 * `data_parallelExecutions` (`version: "v3"` content, resources `certificates`).
 *
 * Targets (safety, rules T8 0.1 rule 4 and 6): only the run's own TLS target (`tlsTarget.ts`) or RFC 5737 documentation
 * ranges (`DARK_*`); never SMK-003's "select all" cleanup. Every run the helper creates is recorded in the ledger before any
 * assertion; the certificates it onboarded as NEW are recorded as `derived` lines (server clock `createdAfter`, with the keys
 * the platform linked to them) by `recordOnboarded`, so the run-end teardown deletes exactly those, by uuid.
 *
 * The 422 matrix of stop / resume / cancel / delete is core's `DiscoveryProviderV2Adapter.requireStatus` (T8 rules 27, 54).
 */
import { waitForDiscoveryCompletion } from '../discoveryUtils';
import type { WaitForDiscoveryOptions } from '../discoveryUtils';
import { Logger } from '../Logger';
import { connectorVersion, healthByVersion, listConnectors } from './connectorApi';
import { GuardedApi } from './guardedApi';
import { ownership } from './ownObjects';
import { recordDerivedKeyOf } from './regressionApi';
import { createdAfterFrom, OwnRef, recordCreated, recordDeleted, recordDerived, RUN_ID } from './regressionRun';
import { isOk, Sent, sendJson, wfName } from './workflowApi';

const logger = new Logger('DiscoveryApi');

type Json = Record<string, any>;

export type Generation = 'v1' | 'v2';
export const IP_KIND = 'IP-Hostname';

export interface DiscoveryConnector {
    uuid: string;
    name: string;
    generation: Generation;
    /** v1: the discovery kind (`IP-Hostname`). */
    kind?: string;
    /** v2: the uuid of the connector's discovery interface. */
    interfaceUuid?: string;
    /** Why it cannot be used ("live health 503"), or undefined when it answers its live health. */
    unhealthy?: string;
}

export interface DiscoveryTier {
    v1?: DiscoveryConnector;
    v2?: DiscoveryConnector;
    /** One line per generation that is missing or unhealthy. */
    problems: { v1?: string; v2?: string };
}

/**
 * The tier's IP discovery registrations, read-only: a connected connector with the `discoveryProvider` function group and the
 * kind `IP-Hostname` (generation v1), and a connected connector with a `discovery` interface (generation v2) whose resources
 * offer `certificates`. REG_DISCOVERY_V1_CONNECTOR / REG_DISCOVERY_V2_CONNECTOR name the registrations when several exist.
 * Health is read LIVE and BY VERSION (an unhealthy registration is reported, not used).
 */
export async function findDiscoveryConnectors(api: GuardedApi, env: NodeJS.ProcessEnv = process.env): Promise<DiscoveryTier> {
    const tier: DiscoveryTier = { problems: {} };
    const rows = await listConnectors(api);
    const raw = await api.get('/api/v1/connectors');
    const listing = raw.ok() ? ((await raw.json()) as Json[]) : [];
    const wanted: Record<Generation, string | undefined> = { v1: env.REG_DISCOVERY_V1_CONNECTOR?.trim() || undefined, v2: env.REG_DISCOVERY_V2_CONNECTOR?.trim() || undefined };
    const why: string[] = [];
    for (const row of rows) {
        if (row.status !== 'connected') continue;
        const { version, detail } = await connectorVersion(api, row.uuid);
        if (!version || !detail) continue;
        const listed = listing.find((c) => c.uuid === row.uuid) ?? {};
        const groups = (detail.functionGroups ?? listed.functionGroups ?? []) as Json[];
        const discoveryInterface = ((detail.interfaces ?? []) as Json[]).find((i) => i.code === 'discovery');
        const kind = groups.find((g) => g.functionGroupCode === 'discoveryProvider' && (g.kinds ?? []).includes(IP_KIND))?.kinds?.find((k: string) => k === IP_KIND);
        let candidate: DiscoveryConnector | undefined;
        if (version === 1 && kind) candidate = { uuid: row.uuid, name: row.name, generation: 'v1', kind };
        else if (version === 2 && discoveryInterface) candidate = { uuid: row.uuid, name: row.name, generation: 'v2', interfaceUuid: String(discoveryInterface.uuid) };
        if (!candidate) continue;
        if (wanted[candidate.generation] && wanted[candidate.generation] !== candidate.name) continue;
        if (tier[candidate.generation]) continue;
        if (candidate.generation === 'v2') {
            const res = await api.get(`/api/v1/discoveries/${candidate.uuid}/resources`);
            const resources = res.ok() ? ((await res.json()) as Json[]).map((r) => String(r.resource)) : [];
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

/** The named deploy gate of a missing generation (`@needs:v1-discovery` / `@needs:v2-discovery`), or undefined when present. */
export function generationGate(tier: DiscoveryTier, g: Generation): string | undefined {
    return tier[g] ? undefined : `deploy gate: ${tier.problems[g] ?? `no ${g} discovery connector`} (@needs:${g}-discovery)`;
}

// ------------------------------------------------------------------ run attributes from the live definitions

const def = (defs: Json[], name: string): Json => {
    const d = defs.find((x) => x.name === name);
    if (!d) throw new Error(`the discovery connector offers no attribute ${name} (offers: ${defs.map((x) => x.name).join(', ')})`);
    return d;
};

/** The run-level attribute definitions of a connector: v1 `attributes/discoveryProvider/<kind>`, v2 `GET /v1/discoveries/{uuid}/attributes`. */
export async function runDefinitions(api: GuardedApi, c: DiscoveryConnector): Promise<Json[]> {
    const url = c.generation === 'v1' ? `/api/v1/connectors/${c.uuid}/attributes/discoveryProvider/${c.kind ?? IP_KIND}` : `/api/v1/discoveries/${c.uuid}/attributes`;
    const res = await api.get(url);
    if (!res.ok()) throw new Error(`GET ${url} answered ${res.status()}`);
    return (await res.json()) as Json[];
}

export interface Target {
    /** Hosts / ranges / CIDR: v1 one comma-separated `ip` value, v2 one `data_hosts` entry each. */
    hosts: string[];
    /** Ports or ranges (default: the connector's 443). */
    ports?: string[];
    /** 1..100 (default: the connector's 1). */
    parallel?: number;
}

/** v1 request attributes (V2 content items, `ip` required). Fields left undefined are left out (negative cases). */
export function v1Attributes(defs: Json[], t: Partial<Target> & { allPorts?: boolean }): Json[] {
    const out: Json[] = [];
    const attr = (name: string, content: Json[]) => {
        const d = def(defs, name);
        out.push({ uuid: d.uuid, name: d.name, contentType: d.contentType, content });
    };
    if (t.hosts) attr('ip', [{ data: t.hosts.join(',') }]);
    if (t.ports) attr('port', [{ data: t.ports.join(',') }]);
    if (t.allPorts !== undefined) attr('allPorts', [{ data: t.allPorts }]);
    if (t.parallel !== undefined) attr('data_parallel_executions', [{ data: t.parallel }]);
    return out;
}

/** v2 request attributes (`version: "v3"`, one content item per list entry). */
export function v2Attributes(defs: Json[], t: Partial<Target>): Json[] {
    const out: Json[] = [];
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
    suffix: string;
    target?: Target;
    /** Trigger uuids (OWN triggers): applied to the NEW certificates of the run (event `certificate_discovered`). */
    triggers?: Array<{ uuid: string }>;
    /** v2 resources (default `['certificates']`); v1 must not send any. */
    resources?: string[];
    /** Extra / override fields of the request body (a negative case's defect). */
    body?: Json;
    /** Use this name instead of a generated one (a duplicate-name probe). */
    name?: string;
}

/** The request body of a discovery (pure): the generation decides kind / interface / resources. */
export function discoveryBody(c: DiscoveryConnector, name: string, attributes: Json[], o: Pick<CreateOptions, 'triggers' | 'resources' | 'body'> = {}): Json {
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
    body: Json;
}

/** Creates an own discovery (the run starts at once), records it before any assertion; throws on a refusal: a positive step. */
export async function createOwnDiscovery(api: GuardedApi, spec: string, c: DiscoveryConnector, o: CreateOptions): Promise<OwnDiscovery> {
    const defs = await runDefinitions(api, c);
    const target = o.target ?? { hosts: [] };
    const attributes = c.generation === 'v1' ? v1Attributes(defs, target) : v2Attributes(defs, target);
    const name = o.name ?? wfName(o.suffix);
    const sent = await sendJson(api, 'POST', '/api/v1/discoveries', discoveryBody(c, name, attributes, o));
    const uuid = sent.json?.uuid;
    if (!isOk(sent) || typeof uuid !== 'string') throw new Error(`POST /v1/discoveries → ${sent.status} ${sent.text.slice(0, 500)}`);
    const ref = recordCreated('discoveries', { uuid, name }, spec, `${c.generation} IP discovery run`, undefined, { serverAt: sent.headers.date });
    return { ...ref, generation: c.generation, connector: c, body: sent.json };
}

/** A negative probe: POST a body as is; an accepted one (a 2xx the caller expected to be refused) is recorded. */
export async function probeCreateDiscovery(api: GuardedApi, body: Json, spec: string): Promise<Sent> {
    const sent = await sendJson(api, 'POST', '/api/v1/discoveries', body);
    if (isOk(sent) && typeof sent.json?.uuid === 'string' && typeof body.name === 'string' && body.name.startsWith(`${RUN_ID}-`)) {
        recordCreated('discoveries', { uuid: sent.json.uuid, name: body.name }, spec, 'accepted although a refusal was expected');
    }
    return sent;
}

// ------------------------------------------------------------------ reads

export interface DiscoveryDetail extends Json {
    uuid: string;
    name: string;
    status: string;
    connectorStatus: string;
    message?: string;
    startTime?: string;
    endTime?: string;
    totalCertificatesDiscovered?: number;
    connectorTotalCertificatesDiscovered?: number;
    connectorInterface?: Json | null;
    stoppable?: boolean | null;
    itemsDiscovered?: number | null;
    itemsNewlyDiscovered?: number;
    itemsProcessed?: number;
    itemsFailed?: number;
    progress?: Json | null;
    runMessageCount?: number;
    triggers?: Json[];
    metadata?: Json[];
}

export async function getDiscovery(api: GuardedApi, uuid: string): Promise<DiscoveryDetail> {
    const sent = await sendJson(api, 'GET', `/api/v1/discoveries/${uuid}`);
    if (sent.status !== 200) throw new Error(`GET discovery ${uuid} answered ${sent.status}`);
    return sent.json as DiscoveryDetail;
}

export interface DiscoveryCertificate extends Json {
    uuid: string;
    inventoryUuid?: string | null;
    commonName?: string;
    fingerprint?: string;
    newlyDiscovered: boolean;
    processed: boolean;
    processedError?: string | null;
}

/** Every staged certificate of a run (all pages), optionally only NEW (`true`) or EXISTING (`false`) ones. */
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

export async function listDiscoveryItems(api: GuardedApi, uuid: string, query = 'itemsPerPage=100&pageNumber=1'): Promise<Sent> {
    return sendJson(api, 'GET', `/api/v1/discoveries/${uuid}/items?${query}`);
}

export async function listDiscoveryMessages(api: GuardedApi, uuid: string, query = 'itemsPerPage=100&pageNumber=1'): Promise<Sent> {
    return sendJson(api, 'GET', `/api/v1/discoveries/${uuid}/messages?${query}`);
}

/** `POST /v1/discoveries/list` (a read): the rows of one name, for "no run was created" oracles. */
export async function findDiscoveriesByName(api: GuardedApi, name: string): Promise<Json[]> {
    const sent = await sendJson(api, 'POST', '/api/v1/discoveries/list', {
        itemsPerPage: 100,
        pageNumber: 1,
        filters: [{ fieldSource: 'property', fieldIdentifier: 'DISCOVERY_NAME', condition: 'EQUALS', value: name }],
    });
    if (sent.status !== 200) throw new Error(`POST /v1/discoveries/list answered ${sent.status} ${sent.text.slice(0, 200)}`);
    return (sent.json?.discoveries ?? []) as Json[];
}

// ------------------------------------------------------------------ run controls and waits

export type RunControl = 'stop' | 'resume' | 'cancel';

/**
 * `PATCH /v1/discoveries/{uuid}/{stop|resume|cancel}`: the uuid is an OWN run or `api.probeUuid()` (a 404 negative); any other
 * is refused by the guard. A 204 is a legal edge, a 422 names the state ("Discovery <uuid> is <State> and cannot be stopped").
 */
export const controlDiscovery = (api: GuardedApi, uuid: string, op: RunControl): Promise<Sent> => sendJson(api, 'PATCH', `/api/v1/discoveries/${uuid}/${op}`);

/** `DELETE /v1/discoveries/{uuid}` of an own run: 204 for a terminal (or any v1) run, else 422 ("…cancel it first"). */
export const deleteDiscoveryRun = (api: GuardedApi, uuid: string): Promise<Sent> => sendJson(api, 'DELETE', `/api/v1/discoveries/${uuid}`);

/** Waits for the run's terminal `completed` (fails fast on `failed`); the poll is API state, never time. */
export function waitForCompleted(api: GuardedApi, uuid: string, timeoutMs = 120_000, opts: WaitForDiscoveryOptions = {}): Promise<void> {
    return waitForDiscoveryCompletion(api, uuid, timeoutMs, opts);
}

/** Waits for a status (`stopped`, `cancelled`, `inProgress`, …) of `status` only; `connectorStatus` is not checked. */
export function waitForStatus(api: GuardedApi, uuid: string, status: string, timeoutMs = 60_000): Promise<void> {
    return waitForDiscoveryCompletion(api, uuid, timeoutMs, { expected: { status }, failOn: status === 'failed' ? [] : ['failed'] });
}

/**
 * Polls the run until it is `completed` and returns EVERY distinct status it showed (in order): the oracle "inProgress → processing
 * → completed" is a subsequence check, because a fast run may skip a state between two polls. Fails fast on `failed`.
 */
export async function observeUntilCompleted(api: GuardedApi, uuid: string, timeoutMs = 180_000, intervalMs = 1_500): Promise<string[]> {
    const seen: string[] = [];
    const started = Date.now();
    for (;;) {
        const d = await getDiscovery(api, uuid);
        if (seen[seen.length - 1] !== d.status) seen.push(d.status);
        if (d.status === 'completed') return seen;
        if (d.status === 'failed') throw new Error(`discovery ${uuid} failed: ${d.message ?? ''} (seen ${seen.join(' → ')})`);
        if (Date.now() - started > timeoutMs) throw new Error(`discovery ${uuid} did not complete within ${timeoutMs} ms (seen ${seen.join(' → ')})`);
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

/** The value of a named metadata item of a run's detail (v1 `totalUrls` / `successUrls` / `failedUrls`), or undefined. */
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

/** True when `sub` is a subsequence of `seq` (order kept, gaps allowed). */
export const isSubsequence = (sub: string[], seq: string[]): boolean => {
    let i = 0;
    for (const x of seq) if (x === sub[i]) i += 1;
    return i === sub.length;
};

// ------------------------------------------------------------------ what the run onboarded (derived ledger lines)

/**
 * Records the certificates the run onboarded as NEW (and the keys the platform linked to them) as `derived` ledger lines with
 * the SERVER's `createdAfter` (the run's own start time, minus the margin), so the teardown deletes them by uuid when nobody
 * adopted them. EXISTING rows are never recorded. Idempotent. Returns the uuids recorded or already known.
 */
export async function recordOnboarded(api: GuardedApi, spec: string, run: { uuid: string }): Promise<string[]> {
    const detail = await getDiscovery(api, run.uuid);
    const serverStart = detail.startTime;
    if (!serverStart) throw new Error(`discovery ${run.uuid} has no startTime: the derived lines need a server timestamp (R17)`);
    const createdAfter = createdAfterFrom(serverStart);
    const rows = await listDiscoveredCertificates(api, run.uuid, true);
    const known = new Set<string>();
    for (const r of rows) {
        const uuid = r.inventoryUuid;
        if (!uuid) continue;
        if (!ownership({ uuid }).own) {
            recordDerived('certificates', { uuid, name: r.commonName ?? `onboarded by discovery ${run.uuid}` }, spec, createdAfter, 'new in the inventory through an own discovery', { discovery: run.uuid });
        }
        await recordDerivedKeyOf(api, uuid, createdAfter, spec);
        known.add(uuid);
    }
    logger.info(`discovery ${run.uuid}: ${known.size} onboarded certificate(s) recorded as derived`);
    return [...known];
}

/** The SHA-256 fingerprints of a result listing, lowercase hex without separators, sorted and de-duplicated. */
export const fingerprintSet = (rows: Array<{ fingerprint?: string }>): string[] =>
    [...new Set(rows.map((r) => String(r.fingerprint ?? '').replace(/[:\s]/g, '').toLowerCase()).filter(Boolean))].sort();

/** The run's `Discovery Source` / history evidence is read from the inventory certificate (read-only). */
export async function getInventoryCertificate(api: GuardedApi, uuid: string): Promise<Json> {
    const sent = await sendJson(api, 'GET', `/api/v1/certificates/${uuid}`);
    if (sent.status !== 200) throw new Error(`GET certificate ${uuid} answered ${sent.status}`);
    return sent.json as Json;
}

export async function getCertificateHistory(api: GuardedApi, uuid: string): Promise<Json[]> {
    const sent = await sendJson(api, 'GET', `/api/v1/certificates/${uuid}/history`);
    if (sent.status !== 200) throw new Error(`GET certificate history ${uuid} answered ${sent.status}`);
    return (sent.json ?? []) as Json[];
}

/** Count of certificates in the inventory for a filter (a read: `POST /v1/certificates`, search allow-list). */
export async function countCertificates(api: GuardedApi, filters: Json[]): Promise<number> {
    const sent = await sendJson(api, 'POST', '/api/v1/certificates', { itemsPerPage: 1, pageNumber: 1, filters });
    if (sent.status !== 200) throw new Error(`POST /v1/certificates answered ${sent.status}`);
    return Number(sent.json?.totalItems ?? 0);
}

// ------------------------------------------------------------------ scheduled discovery (`@local` only: a schedule runs for everyone)

export interface ScheduleOptions {
    suffix: string;
    /** Quartz cron, SECONDS first (6 or 7 fields), evaluated in UTC. */
    cron: string;
    oneTime: boolean;
    target: Target;
    jobName?: string;
}

export interface OwnJob extends OwnRef {
    /** The discovery name the job creates runs from (`<name>_<timestamp>`). */
    discoveryName: string;
}

/**
 * `POST /v1/discoveries/schedule` (PLATFORM_DENY: only `@local` with `localStack`): core validates the request like a create but
 * persists no discovery, registers the job (`DiscoveryCertificateTask`) and answers 201 with the job uuid. The job is recorded as a
 * `scheduledJobs` ledger line (id-named) before any assertion; the spec deletes its own job in `finally`.
 */
export async function scheduleDiscovery(api: GuardedApi, spec: string, c: DiscoveryConnector, o: ScheduleOptions): Promise<{ job: OwnJob; sent: Sent }> {
    const defs = await runDefinitions(api, c);
    const attributes = c.generation === 'v1' ? v1Attributes(defs, o.target) : v2Attributes(defs, o.target);
    const discoveryName = wfName(o.suffix);
    const jobName = o.jobName ?? wfName(`${o.suffix}-job`);
    const sent = await sendJson(api, 'POST', '/api/v1/discoveries/schedule', {
        jobName,
        cronExpression: o.cron,
        oneTime: o.oneTime,
        request: discoveryBody(c, discoveryName, attributes),
    });
    const uuid = sent.json?.uuid ?? /\/scheduler\/jobs\/([0-9a-f-]{36})/.exec(sent.headers.location ?? '')?.[1];
    if (!isOk(sent) || typeof uuid !== 'string') throw new Error(`POST /v1/discoveries/schedule → ${sent.status} ${sent.text.slice(0, 400)}`);
    const ref = recordCreated('scheduledJobs', { uuid, name: jobName }, spec, `${c.generation} scheduled discovery (${o.oneTime ? 'one-time' : 'recurrent'}), own job`);
    return { job: { ...ref, discoveryName }, sent };
}

export async function getJob(api: GuardedApi, uuid: string): Promise<Json> {
    const sent = await sendJson(api, 'GET', `/api/v1/scheduler/jobs/${uuid}`);
    if (sent.status !== 200) throw new Error(`GET scheduler job ${uuid} answered ${sent.status}`);
    return sent.json as Json;
}

/** The execution history of a job (`started` / `succeeded` / `failed`), oldest first. */
export async function getJobHistory(api: GuardedApi, uuid: string): Promise<Json[]> {
    const sent = await sendJson(api, 'GET', `/api/v1/scheduler/jobs/${uuid}/history?itemsPerPage=100&pageNumber=1`);
    if (sent.status !== 200) throw new Error(`GET scheduler job history ${uuid} answered ${sent.status}`);
    return [...((sent.json?.scheduledJobHistory ?? []) as Json[])].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

/** Deletes an own job (a `@local` spec's `finally`); a 204 is recorded. A job that is executing refuses with 422. */
export async function deleteJob(api: GuardedApi, job: OwnRef, spec: string): Promise<Sent> {
    const sent = await sendJson(api, 'DELETE', `/api/v1/scheduler/jobs/${job.uuid}`);
    if (sent.status === 204 || sent.status === 200 || sent.status === 404) recordDeleted('scheduledJobs', job, spec, 'own scheduled job removed by its spec');
    return sent;
}

/** Runs created from a job: every discovery whose name starts with `<discoveryName>_` (a read). */
export async function runsOfJob(api: GuardedApi, discoveryName: string): Promise<Json[]> {
    const sent = await sendJson(api, 'POST', '/api/v1/discoveries/list', {
        itemsPerPage: 100,
        pageNumber: 1,
        filters: [{ fieldSource: 'property', fieldIdentifier: 'DISCOVERY_NAME', condition: 'STARTS_WITH', value: `${discoveryName}_` }],
    });
    if (sent.status !== 200) throw new Error(`POST /v1/discoveries/list answered ${sent.status}`);
    return (sent.json?.discoveries ?? []) as Json[];
}

/** Records the run a job created as an own discovery (its name carries the own prefix) before the spec asserts on it. */
export function adoptJobRun(run: Json, spec: string): OwnRef {
    return recordCreated('discoveries', { uuid: String(run.uuid), name: String(run.name) }, spec, 'run created by the own scheduled job');
}
