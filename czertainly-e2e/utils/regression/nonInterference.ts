/**
 * nonInterference — API-GEN-33: the automated proof of decision Q1 on a shared tier (a run changes only what it created).
 *
 * `snapshotTier(api)` records, per resource, the total and the objects whose name does NOT carry a run prefix
 * (`qa-reg-` / `qa-api-`), each with its name, its description (when the list carries one) and a marker of its
 * mutable state; the platform-level event associations and the system jobs are stored as canonical JSON.
 * `compareSnapshots(before, after)` then asserts:
 *   1. every stored foreign object is still there with an unchanged name, description and marker (review Q10: roles,
 *      groups, authorities, credentials, connectors and other markerless resources were blind to a rename or an edit);
 *   2. platform event associations and system jobs are identical;
 *   3. net accounting per resource (review R11): `after.total - before.total` equals what the run's ledger explains
 *      (own and derived objects created since the before snapshot minus own objects deleted since then), within
 *      NET_TOLERANCE (REG_NET_TOLERANCE, default 0: any unexplained change is a violation). Keys count key items, so
 *      their expected change is a range (an own key brings one or two items, an own certificate up to one
 *      `certKey_<CN>` item);
 *   4. a REQUIRED resource (certificates, RA profiles, authorities, ACME profiles, roles, users, groups, keys, tokens)
 *      that could not be read before the run leaves the proof incomplete: that is a violation, not a note (review R9);
 *   5. both snapshots were taken on the same tier (tier identity, review R15).
 * A violation is a finding for a human, who rules out concurrent activity on the shared tier: this is a proof, not a lock.
 *
 * Markers: the list DTOs carry no `updated` field (interfaces origin/main 71d7f73b), only notification profiles a
 * `version`. Everywhere else the marker is the state a forbidden mutation would change: `enabled` (disable), a
 * certificate's `state` / `archived` (revoke, archive), a key's item states (destroy, disable), `ignoreTrigger`, a
 * discovery's terminal status. Volatile fields (connector or token status, fire times) are left out on purpose, and so
 * are the transient discovery statuses `inProgress` / `processing`: a foreign discovery that finishes during the run
 * is not a change the run made (review R12).
 *
 * Large collections (certificates, keys, discoveries) are not walked (Phase 3 §7): the snapshot stores the total, the
 * OLDEST window (200, the tail of the newest-first list) and the NEWEST sample (100, the head: the objects most likely
 * to be touched by mistake, review R11). In the after snapshot a stored uuid that left both is re-read by its detail URL
 * (`recheck`), so a deletion is never mistaken for drift.
 *
 * Keys (incident fix, B1 live run 1): the key search lists one row per key ITEM whose `name` is the item's name, while
 * `GET /v1/keys/{uuid}` names the WRAPPER (core CryptographicKeyItem.mapToSummaryDto vs KeyDetailDto). A key is therefore
 * identified by its wrapper uuid (`keyWrapperUuid`) and marked the same way from rows and from the detail: `name` = its
 * item names, `marker` = its item states (`keyMarkOfRows` / `keyMarkOfDetail`); the wrapper's own name is stored as
 * `wrapper` only when the detail was read and compared only when both snapshots carry it. A key whose rows straddle a
 * window cut (one item on the boundary row of the newest sample or of the oldest window) would get a partial mark from
 * the rows, so such a key is always re-read by its detail (`straddlingKeys`), in the before and the after snapshot alike.
 *
 * Not snapshotted (explicit gap list, `SNAPSHOT_GAPS`): see below; each has a reason.
 *
 * Messages, notes and attachments carry the resource type and the uuid only, never a foreign object's name (review
 * R20); names stay in the snapshot files in the local state directory, which `purgeOldSnapshots` clears after 14 days.
 */
import { APIRequestContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../Logger';
import { LedgerLine } from './regressionRun';
import { currentRunId, hasRunFamilyPrefix } from './runId';
import { tierIdentity } from './tier';

const logger = new Logger('NonInterference');

type Json = Record<string, any>;

export interface ItemMark {
    name: string;
    /** The list item's description, when it carries one (compared like the name, Q10). */
    description?: string;
    marker?: string;
    /** Keys only: the wrapper's name, known when the detail was read; compared when both snapshots carry it. */
    wrapper?: string;
}

export interface ResourceSnapshot {
    total: number;
    /** Foreign (non-prefixed) objects: all of them, or the oldest window plus the newest sample of a large collection. */
    foreign: Record<string, ItemMark>;
    window?: number;
    newest?: number;
    /** The read failed: the resource is reported as not compared (a violation when it is required). */
    error?: string;
    /** What the read could not settle (a key gone between the search and its detail read): reported as notes. */
    notes?: string[];
}

export interface TierSnapshot {
    takenAt: string;
    runId: string;
    /** Tier identity (hash of BASE_URL's host) the snapshot was taken on. */
    tier?: string;
    resources: Record<string, ResourceSnapshot>;
    /** Canonical JSON of GET /v1/settings/events (eventsMapping), or the read error. */
    platformEvents?: string;
    /** Canonical JSON of the system jobs' stable fields (uuid, jobName, jobType, cronExpression, enabled, oneTime). */
    systemJobs?: string;
}

export const OLDEST_WINDOW = 200;
export const NEWEST_SAMPLE = 100;
const PAGE = 100;

/** Resources whose before snapshot must be readable (R9): without them the proof is not a proof. */
export const REQUIRED_RESOURCES: readonly string[] = ['certificates', 'raProfiles', 'authorities', 'acmeProfiles', 'roles', 'users', 'groups', 'keys', 'tokens'];

/** What the snapshot does not cover, and why (R11: an explicit gap list instead of a silent one). */
export const SNAPSHOT_GAPS: Readonly<Record<string, string>> = {
    acmeAccounts: 'no name to tell own from foreign; an account changes only through its own ACME client or its profile',
    approvals: 'requests of certificates; their decisions are covered by the certificate state marker',
    savedViews: 'per-user UI state, no shared impact',
    oidEntries: 'list endpoint is a search keyed by OID, B5 (platform settings rows are @local)',
    platformSettings: 'settings other than event associations are changed only by @local rows',
    tokenProfiles: 'listed per token; a token change is covered by the tokens total',
    scheduledJobsUser: 'user jobs are covered by the scheduledJobs total and enabled marker; only system jobs are compared field by field',
};

interface ResourceDef {
    /** Same name as the ledger `type`, so totals can be explained by ledger lines. */
    type: string;
    /** list: GET array; paged: GET with itemsPerPage / pageNumber; search: POST window of a large collection;
     *  searchAll: POST search walked page by page (small collections). */
    read: 'list' | 'search' | 'paged' | 'searchAll';
    path: string;
    itemsKey?: string;
    body?: Json;
    large?: boolean;
    name: (item: Json) => string;
    uuid?: (item: Json) => string;
    marker?: (item: Json) => string | undefined;
    /** Detail URL of one object (recheck of a stored uuid that left the windows) and the marker read from the detail. */
    detail?: (uuid: string) => string;
    detailMarker?: (detail: Json) => string | undefined;
    /** The whole mark from the detail (keys: the detail is the only full view of a key's items and wrapper name). */
    detailMark?: (detail: Json) => ItemMark;
}

const enabled = (i: Json) => `enabled=${i.enabled}`;
const certMarker = (i: Json) => `${i.state}${i.archived ? '|archived' : ''}`;
const keyItemsMarker = (items: Json[]) => items.map((x) => `${x.state}/${x.enabled}`).sort().join(',');
const keyItemsName = (items: Json[]) => items.map((x) => String(x.name ?? '')).sort().join(',');

/**
 * A name the run family made: a run-prefixed name, or the key core derives from a run certificate
 * (`certKey_<CN>` / `altCertKey_<CN>`, CertificateServiceImpl.uploadCertificateKey) — never foreign (Sonnet F6).
 */
export function isRunNamed(name: string | undefined): boolean {
    if (!name) return false;
    const m = /^(?:certKey_|altCertKey_)(.+)$/.exec(name); // core CertificateServiceImpl: "certKey_" + CN, "altCertKey_" + CN
    return hasRunFamilyPrefix(name) || (!!m && hasRunFamilyPrefix(m[1]));
}

/** The wrapper uuid a key search row belongs to (`keyWrapperUuid`; the row's own `uuid` is the item's). */
export const keyWrapperOf = (row: Json): string => String(row.keyWrapperUuid ?? row.uuid);

/** The mark of one key from its search rows (the items the windows showed): item names + item states, no wrapper name. */
export function keyMarkOfRows(rows: Json[]): ItemMark {
    return { name: keyItemsName(rows), ...descriptionOf(rows[0]), marker: keyItemsMarker(rows) };
}

/** The same mark from `GET /v1/keys/{uuid}` (all items), plus the wrapper's own name. */
export function keyMarkOfDetail(detail: Json): ItemMark {
    const items: Json[] = Array.isArray(detail?.items) ? detail.items : [];
    return { name: keyItemsName(items), ...descriptionOf(detail), marker: keyItemsMarker(items), wrapper: String(detail?.name ?? '') };
}

/**
 * Wrapper uuids whose rows touch a cut of the windows: the last row of the newest sample (position NEWEST_SAMPLE - 1)
 * or the first row of the oldest window (position `start`), when the two do not meet (`start > NEWEST_SAMPLE`). The items
 * of one key sit next to each other in the newest-first list (same creation time), so a key with a further item just
 * outside the windows has a row on the boundary; its mark is taken from the detail instead.
 */
export function straddlingKeys(rows: Array<{ row: Json; pos: number }>, total: number): Set<string> {
    const start = Math.max(0, total - OLDEST_WINDOW);
    const out = new Set<string>();
    if (start <= NEWEST_SAMPLE) return out;
    for (const { row, pos } of rows) if (pos === NEWEST_SAMPLE - 1 || pos === start) out.add(keyWrapperOf(row));
    return out;
}
/** Transient discovery statuses are not compared (R12). */
export const TRANSIENT_DISCOVERY_STATUSES: readonly string[] = ['inProgress', 'processing'];
const discoveryMarker = (i: Json) => (TRANSIENT_DISCOVERY_STATUSES.includes(i.status) ? undefined : i.status);

export const RESOURCES: ResourceDef[] = [
    {
        type: 'certificates', read: 'search', path: '/api/v1/certificates', itemsKey: 'certificates', body: { includeArchived: true }, large: true,
        name: (i) => i.commonName ?? '', marker: certMarker, detail: (u) => `/api/v1/certificates/${u}`, detailMarker: certMarker,
    },
    {
        // One row per key ITEM (its name is the item's); grouped by wrapper, marked by keyMarkOfRows / keyMarkOfDetail.
        type: 'keys', read: 'search', path: '/api/v1/keys', itemsKey: 'cryptographicKeys', large: true,
        name: (i) => i.name ?? '', uuid: keyWrapperOf, detail: (u) => `/api/v1/keys/${u}`, detailMark: keyMarkOfDetail,
    },
    {
        type: 'discoveries', read: 'search', path: '/api/v1/discoveries/list', itemsKey: 'discoveries', large: true,
        name: (i) => i.name ?? '', marker: discoveryMarker, detail: (u) => `/api/v1/discoveries/${u}`, detailMarker: discoveryMarker,
    },
    { type: 'raProfiles', read: 'list', path: '/api/v1/raProfiles', name: (i) => i.name, marker: enabled },
    { type: 'authorities', read: 'list', path: '/api/v1/authorities', name: (i) => i.name },
    { type: 'acmeProfiles', read: 'list', path: '/api/v1/acmeProfiles', name: (i) => i.name, marker: enabled },
    { type: 'scepProfiles', read: 'list', path: '/api/v1/scepProfiles', name: (i) => i.name, marker: enabled },
    { type: 'cmpProfiles', read: 'list', path: '/api/v1/cmpProfiles', name: (i) => i.name, marker: enabled },
    { type: 'roles', read: 'list', path: '/api/v1/roles', name: (i) => i.name },
    { type: 'users', read: 'list', path: '/api/v1/users', name: (i) => i.username, marker: enabled },
    { type: 'groups', read: 'list', path: '/api/v1/groups', name: (i) => i.name },
    { type: 'tokens', read: 'list', path: '/api/v1/tokens', name: (i) => i.name },
    { type: 'credentials', read: 'list', path: '/api/v1/credentials', name: (i) => i.name, marker: enabled },
    { type: 'connectors', read: 'list', path: '/api/v1/connectors', name: (i) => i.name },
    { type: 'customAttributes', read: 'list', path: '/api/v1/attributes/custom', name: (i) => i.name, marker: enabled },
    { type: 'triggers', read: 'list', path: '/api/v1/workflows/triggers', name: (i) => i.name, marker: (i) => `ignore=${i.ignoreTrigger}` },
    { type: 'rules', read: 'list', path: '/api/v1/workflows/rules', name: (i) => i.name },
    { type: 'conditions', read: 'list', path: '/api/v1/workflows/conditions', name: (i) => i.name },
    { type: 'actions', read: 'list', path: '/api/v1/workflows/actions', name: (i) => i.name },
    { type: 'executions', read: 'list', path: '/api/v1/workflows/executions', name: (i) => i.name },
    { type: 'notificationInstances', read: 'list', path: '/api/v1/notificationInstances', name: (i) => i.name },
    { type: 'notificationProfiles', read: 'paged', path: '/api/v1/notificationProfiles', itemsKey: 'notificationProfiles', name: (i) => i.name, marker: (i) => `v${i.version}` },
    { type: 'complianceProfiles', read: 'list', path: '/api/v1/complianceProfiles', name: (i) => i.name },
    { type: 'approvalProfiles', read: 'paged', path: '/api/v1/approvalProfiles', itemsKey: 'approvalProfiles', name: (i) => i.name, marker: enabled },
    { type: 'entities', read: 'searchAll', path: '/api/v1/entities/list', itemsKey: 'entities', name: (i) => i.name },
    { type: 'locations', read: 'searchAll', path: '/api/v1/locations', itemsKey: 'locations', name: (i) => i.name, marker: enabled },
    { type: 'vaultInstances', read: 'searchAll', path: '/api/v1/vaults/list', itemsKey: 'items', name: (i) => i.name },
    { type: 'vaultProfiles', read: 'searchAll', path: '/api/v1/vaultProfiles/list', itemsKey: 'items', name: (i) => i.name, marker: enabled },
    { type: 'secrets', read: 'searchAll', path: '/api/v1/secrets', itemsKey: 'items', name: (i) => i.name, marker: (i) => `${i.state}|enabled=${i.enabled}` },
    { type: 'scheduledJobs', read: 'paged', path: '/api/v1/scheduler/jobs', itemsKey: 'scheduledJobs', name: (i) => i.jobName, marker: enabled },
];

/** JSON with sorted object keys and sorted string arrays (association lists carry no meaningful order). */
export function canonicalJson(value: unknown): string {
    const norm = (v: unknown): unknown => {
        if (Array.isArray(v)) {
            const items = v.map(norm);
            return items.every((x) => typeof x === 'string') ? [...(items as string[])].sort() : items;
        }
        if (v && typeof v === 'object') {
            return Object.fromEntries(Object.keys(v as Json).sort().map((k) => [k, norm((v as Json)[k])]));
        }
        return v;
    };
    return JSON.stringify(norm(value));
}

async function call(api: APIRequestContext, method: 'GET' | 'POST', url: string, data?: unknown): Promise<{ status: number; body: any }> {
    const res = await api.fetch(url, { method, ...(data === undefined ? {} : { data }), failOnStatusCode: false });
    const text = await res.text();
    let body: any;
    try {
        body = text ? JSON.parse(text) : undefined;
    } catch {
        body = undefined;
    }
    return { status: res.status(), body };
}

async function get(api: APIRequestContext, method: 'GET' | 'POST', url: string, data?: unknown): Promise<any> {
    const r = await call(api, method, url, data);
    if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${url} answered ${r.status}`);
    return r.body;
}

async function searchPage(api: APIRequestContext, def: ResourceDef, pageNumber: number, itemsPerPage: number): Promise<{ items: Json[]; total: number; totalPages?: number }> {
    const body = await get(api, 'POST', def.path, { itemsPerPage, pageNumber, filters: [], ...(def.body ?? {}) });
    return { items: body?.[def.itemsKey!] ?? [], total: Number(body?.totalItems ?? 0), totalPages: body?.totalPages };
}

interface ReadRows {
    items: Json[];
    total: number;
    /** Windowed reads only: each row with its position in the newest-first list (the straddle test of keys). */
    positioned?: Array<{ row: Json; pos: number }>;
}

/** Total, the newest NEWEST_SAMPLE rows (head) and the oldest OLDEST_WINDOW rows (tail) of a newest-first search. */
async function readWindows(api: APIRequestContext, def: ResourceDef): Promise<ReadRows> {
    const { total } = await searchPage(api, def, 1, 1);
    const start = Math.max(0, total - OLDEST_WINDOW);
    const lastPage = Math.ceil(total / PAGE);
    const pages = new Set<number>();
    for (let p = 1; p <= Math.min(lastPage, Math.ceil(NEWEST_SAMPLE / PAGE)); p++) pages.add(p);
    for (let p = Math.floor(start / PAGE) + 1; p <= lastPage; p++) pages.add(p);
    const positioned: Array<{ row: Json; pos: number }> = [];
    for (const page of [...pages].sort((a, b) => a - b)) {
        const { items: rows } = await searchPage(api, def, page, PAGE);
        rows.forEach((row, i) => {
            const pos = (page - 1) * PAGE + i;
            if (pos < NEWEST_SAMPLE || pos >= start) positioned.push({ row, pos });
        });
    }
    return { items: positioned.map((p) => p.row), total, positioned };
}

async function readAllPaged(api: APIRequestContext, def: ResourceDef): Promise<{ items: Json[]; total: number }> {
    const items: Json[] = [];
    let total = 0;
    for (let page = 1; page <= 50; page++) {
        const body = await get(api, 'GET', `${def.path}?itemsPerPage=${PAGE}&pageNumber=${page}`);
        const rows: Json[] = body?.[def.itemsKey!] ?? [];
        items.push(...rows);
        total = Number(body?.totalItems ?? items.length);
        if (page >= Number(body?.totalPages ?? 1) || rows.length === 0) break;
    }
    return { items, total };
}

async function readAllSearch(api: APIRequestContext, def: ResourceDef): Promise<{ items: Json[]; total: number }> {
    const items: Json[] = [];
    let total = 0;
    for (let page = 1; page <= 50; page++) {
        const r = await searchPage(api, def, page, PAGE);
        items.push(...r.items);
        total = r.total;
        if (page >= Number(r.totalPages ?? 1) || r.items.length === 0) break;
    }
    return { items, total };
}

function foreignOf(def: ResourceDef, items: Json[]): Record<string, ItemMark> {
    const uuidOf = def.uuid ?? ((i: Json) => i.uuid);
    if (def.type === 'keys') {
        // One row per key item: group by wrapper; a key is foreign when none of its items carries a run prefix.
        const byKey = new Map<string, Json[]>();
        for (const i of items) byKey.set(uuidOf(i), [...(byKey.get(uuidOf(i)) ?? []), i]);
        const out: Record<string, ItemMark> = {};
        for (const [uuid, rows] of byKey) {
            if (!rows.some((r) => isRunNamed(String(def.name(r) ?? '')))) out[uuid] = keyMarkOfRows(rows);
        }
        return out;
    }
    const out: Record<string, ItemMark> = {};
    for (const i of items) {
        const name = String(def.name(i) ?? '');
        if (!isRunNamed(name)) out[String(uuidOf(i))] = { name, ...descriptionOf(i), marker: def.marker?.(i) };
    }
    return out;
}

/** `{ description }` when the item carries a string description (Q10), else nothing. */
function descriptionOf(item: Json): { description?: string } {
    return typeof item?.description === 'string' ? { description: item.description } : {};
}

async function snapshotResource(api: APIRequestContext, def: ResourceDef, recheck?: ResourceSnapshot): Promise<ResourceSnapshot> {
    try {
        const read: ReadRows =
            def.read === 'list'
                ? await get(api, 'GET', def.path).then((list: Json[]) => ({ items: list ?? [], total: (list ?? []).length }))
                : def.read === 'paged'
                  ? await readAllPaged(api, def)
                  : def.read === 'searchAll'
                    ? await readAllSearch(api, def)
                    : await readWindows(api, def);
        const { items, total } = read;
        const foreign = foreignOf(def, items);
        const notes: string[] = [];
        const detailOf = async (uuid: string): Promise<Json | undefined> => {
            const r = await call(api, 'GET', def.detail!(uuid));
            if (r.status === 404) return undefined; // gone: compareSnapshots reports it
            if (r.status < 200 || r.status >= 300) throw new Error(`GET ${def.detail!(uuid)} answered ${r.status}`);
            return r.body ?? {};
        };
        if (def.type === 'keys' && def.detail && read.positioned) {
            // A key with an item on a window cut may have further items outside the windows: its mark comes from the detail.
            for (const uuid of straddlingKeys(read.positioned, total)) {
                if (!foreign[uuid]) continue;
                const d = await detailOf(uuid);
                delete foreign[uuid];
                if (!d) notes.push(`${def.type}: ${uuid} vanished between the search and its detail read; not compared`); // F5
                // The detail shows every item: a key with a run-named item outside the windows is the run's own (F7).
                else if (!((d.items as Json[] | undefined) ?? []).some((it) => isRunNamed(String(it?.name ?? '')))) foreign[uuid] = def.detailMark!(d);
            }
        }
        if (def.large && recheck && def.detail) {
            for (const [uuid, mark] of Object.entries(recheck.foreign)) {
                if (foreign[uuid]) continue;
                const body = await detailOf(uuid);
                if (!body) continue;
                if (def.detailMark) {
                    foreign[uuid] = def.detailMark(body);
                    continue;
                }
                // The detail's own name (and description) is compared too (Q10); a detail without one keeps the stored value.
                const liveName = def.name(body);
                foreign[uuid] = {
                    name: typeof liveName === 'string' && liveName !== '' ? liveName : mark.name,
                    ...(mark.description !== undefined ? descriptionOf(body) : {}),
                    marker: def.detailMarker?.(body),
                };
            }
        }
        return { total, foreign, ...(def.large ? { window: OLDEST_WINDOW, newest: NEWEST_SAMPLE } : {}), ...(notes.length ? { notes } : {}) };
    } catch (e) {
        logger.warn(`${def.type}: ${String(e)}`);
        return { total: -1, foreign: {}, error: String(e).slice(0, 200) };
    }
}

export interface SnapshotOptions {
    /** Only these resource types (the guard proof reads roles only). */
    only?: string[];
    /** The before snapshot: stored uuids that left a large collection's windows are re-read by detail. */
    recheck?: TierSnapshot;
    runId?: string;
    env?: NodeJS.ProcessEnv;
}

export async function snapshotTier(api: APIRequestContext, opts: SnapshotOptions = {}): Promise<TierSnapshot> {
    const resources: Record<string, ResourceSnapshot> = {};
    for (const def of RESOURCES) {
        if (opts.only && !opts.only.includes(def.type)) continue;
        resources[def.type] = await snapshotResource(api, def, opts.recheck?.resources[def.type]);
    }
    const tier = tierIdentity(opts.env);
    const snap: TierSnapshot = { takenAt: new Date().toISOString(), runId: opts.runId ?? currentRunId(opts.env), ...(tier ? { tier } : {}), resources };
    if (!opts.only) {
        try {
            snap.platformEvents = canonicalJson((await get(api, 'GET', '/api/v1/settings/events'))?.eventsMapping ?? {});
        } catch (e) {
            snap.platformEvents = `error: ${String(e).slice(0, 200)}`;
        }
        try {
            const jobs = (await readAllPaged(api, RESOURCES.find((d) => d.type === 'scheduledJobs')!)).items.filter((j) => j.system);
            snap.systemJobs = canonicalJson(
                jobs
                    .map((j) => ({ uuid: j.uuid, jobName: j.jobName, jobType: j.jobType, cronExpression: j.cronExpression, enabled: j.enabled, oneTime: j.oneTime }))
                    .sort((a, b) => String(a.uuid).localeCompare(String(b.uuid))),
            );
        } catch (e) {
            snap.systemJobs = `error: ${String(e).slice(0, 200)}`;
        }
    }
    const counts = Object.entries(resources).map(([t, r]) => `${t} ${r.error ? 'unreadable' : `${r.total}/${Object.keys(r.foreign).length}`}`);
    logger.info(`snapshot (total/foreign stored): ${counts.join(', ')}`);
    return snap;
}

/** The required resources (R9) a snapshot could not read. */
export function unreadableRequired(snap: TierSnapshot): string[] {
    return REQUIRED_RESOURCES.filter((t) => !snap.resources[t] || snap.resources[t].error);
}

// ------------------------------------------------------------------ compare (pure)

/** REG_NET_TOLERANCE: allowed unexplained change of a total (default 0; raise it only on a busy tier, and say so). */
export function netTolerance(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.REG_NET_TOLERANCE;
    if (raw === undefined || raw.trim() === '') return 0;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`REG_NET_TOLERANCE="${raw}" is not a non-negative integer`);
    return n;
}

export interface CompareOptions {
    /** The ledger; own lines of `runId` written at or after before.takenAt explain total changes. */
    ledger?: LedgerLine[];
    runId?: string;
    /** Objects the run-end teardown deleted (counted like ledger `deleted` lines). */
    ownDeleted?: Array<{ type: string; uuid: string }>;
    /** Allowed unexplained change of a total (default: REG_NET_TOLERANCE, else 0). */
    tolerance?: number;
}

export interface CompareResult {
    violations: string[];
    /** Resources that could not be compared, the accounting tolerance, and own deletions that explain a missing object. */
    notes: string[];
}

export function compareSnapshots(before: TierSnapshot, after: TierSnapshot, opts: CompareOptions = {}): CompareResult {
    const runId = opts.runId ?? before.runId;
    const tolerance = opts.tolerance ?? netTolerance();
    const since = Date.parse(before.takenAt);
    const own = (opts.ledger ?? []).filter((l) => l.runId === runId);
    const ownCreated = new Set(own.filter((l) => l.event === 'created').map((l) => l.uuid));
    const ownGone = new Set([...own.filter((l) => l.event === 'deleted').map((l) => l.uuid), ...(opts.ownDeleted ?? []).map((d) => d.uuid)]);
    const recent = own.filter((l) => Date.parse(l.at) >= since);
    const countBy = (lines: Array<{ type: string; uuid: string; derived?: boolean }>, pick: (l: { derived?: boolean }) => boolean = () => true) => {
        const m = new Map<string, Set<string>>();
        for (const l of lines) if (pick(l)) m.set(l.type, (m.get(l.type) ?? new Set()).add(l.uuid));
        return (type: string) => m.get(type)?.size ?? 0;
    };
    const createdLines = recent.filter((l) => l.event === 'created');
    // A `deleted` line (the teardown's, or a spec's) carries no `derived`: the flag comes from the object's `created` line.
    const derivedOf = (uuid: string): boolean | undefined => own.find((l) => l.event === 'created' && l.uuid === uuid)?.derived;
    const deletedLines = [...recent.filter((l) => l.event === 'deleted'), ...(opts.ownDeleted ?? [])].map((d) => ({ type: d.type, uuid: d.uuid, derived: derivedOf(d.uuid) }));
    const createdSince = countBy(createdLines);
    const deletedSince = countBy(deletedLines);
    const createdOwnKeys = countBy(createdLines, (l) => !l.derived)('keys');
    const deletedOwnKeys = countBy(deletedLines, (l) => !l.derived)('keys');
    const deletedDerivedKeys = deletedSince('keys') - deletedOwnKeys;

    const violations: string[] = [];
    const notes: string[] = [];
    if (before.tier && after.tier && before.tier !== after.tier) violations.push('the snapshots were taken on different tiers (tier identity differs)');
    if (tolerance > 0) notes.push(`net accounting tolerance: ±${tolerance} per resource (REG_NET_TOLERANCE)`);
    for (const [type, b] of Object.entries(before.resources)) {
        const a = after.resources[type];
        if (b.error) {
            if (REQUIRED_RESOURCES.includes(type)) violations.push(`${type}: required resource unreadable before the run, the proof is incomplete (${b.error})`);
            else notes.push(`${type}: not compared (before snapshot unreadable: ${b.error})`);
            continue;
        }
        if (!a || a.error) {
            violations.push(`${type}: readable before the run, unreadable after (${a?.error ?? 'missing'})`);
            continue;
        }
        notes.push(...(b.notes ?? []).map((n) => `before: ${n}`), ...(a.notes ?? []).map((n) => `after: ${n}`));
        for (const [uuid, mark] of Object.entries(b.foreign)) {
            const now = a.foreign[uuid];
            if (!now) {
                if (ownCreated.has(uuid) && ownGone.has(uuid)) notes.push(`${type}: ${uuid} is a ledger object of this run, deleted by it`);
                else violations.push(`${type}: pre-existing ${uuid} is gone`);
            } else {
                if (mark.name !== now.name || (mark.wrapper !== undefined && now.wrapper !== undefined && mark.wrapper !== now.wrapper)) {
                    violations.push(`${type}: pre-existing ${uuid} was renamed (name withheld)`);
                }
                if (mark.description !== undefined && now.description !== undefined && mark.description !== now.description) {
                    violations.push(`${type}: pre-existing ${uuid} changed its description (text withheld)`);
                }
                if (mark.marker !== undefined && now.marker !== undefined && mark.marker !== now.marker) {
                    violations.push(`${type}: pre-existing ${uuid} changed ${mark.marker} -> ${now.marker}`);
                }
            }
        }
        // Net accounting (R11). Keys count key items: an own key brings one or two, an own certificate up to one
        // certKey_<CN> item; a derived key line is one such item.
        let lo: number;
        let hi: number;
        if (type === 'keys') {
            lo = createdOwnKeys - 2 * deletedOwnKeys - deletedDerivedKeys;
            hi = 2 * createdOwnKeys + createdSince('certificates') - deletedOwnKeys - deletedDerivedKeys;
        } else {
            lo = hi = createdSince(type) - deletedSince(type);
        }
        const delta = a.total - b.total;
        if (delta < lo - tolerance || delta > hi + tolerance) {
            const expected = lo === hi ? `${lo >= 0 ? '+' : ''}${lo}` : `${lo}..+${hi}`;
            violations.push(`${type}: total ${b.total} -> ${a.total} (${delta >= 0 ? '+' : ''}${delta}), the ledger explains ${expected}` +
                (tolerance ? ` ±${tolerance}` : ''));
        }
    }
    if (before.platformEvents !== undefined) {
        if (before.platformEvents.startsWith('error:')) notes.push(`platform events: not compared (${before.platformEvents})`);
        else if (after.platformEvents !== before.platformEvents) violations.push('platform event associations changed');
    }
    if (before.systemJobs !== undefined) {
        if (before.systemJobs.startsWith('error:')) notes.push(`system jobs: not compared (${before.systemJobs})`);
        else if (after.systemJobs !== before.systemJobs) violations.push('system jobs changed (uuid, name, type, cron, enabled, one-time)');
    }
    return { violations, notes };
}

// ------------------------------------------------------------------ persistence (the before snapshot crosses processes)

export function saveSnapshot(snap: TierSnapshot, file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, file);
}

export function loadSnapshot(file: string): TierSnapshot | undefined {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as TierSnapshot;
    } catch {
        return undefined;
    }
}

/**
 * Removes one snapshot file (missing is fine): the setup drops a stale before-snapshot of the same run id (fix pass 4:
 * specs may not write or remove files themselves, the lint's fs-write rule).
 */
export function removeSnapshot(file: string): void {
    fs.rmSync(file, { force: true });
}

export const SNAPSHOT_MAX_AGE_DAYS = 14;

/** Deletes `*.snapshot-*.json` files in the state directory older than `maxAgeDays` (they hold foreign names). */
export function purgeOldSnapshots(dir: string, now: number = Date.now(), maxAgeDays: number = SNAPSHOT_MAX_AGE_DAYS): string[] {
    if (!fs.existsSync(dir)) return [];
    const limit = now - maxAgeDays * 24 * 3600 * 1000;
    const removed: string[] = [];
    for (const name of fs.readdirSync(dir)) {
        if (!/\.snapshot-[a-z]+\.json$/.test(name)) continue;
        const file = path.join(dir, name);
        if (fs.statSync(file).mtimeMs < limit) {
            fs.rmSync(file, { force: true });
            removed.push(name);
        }
    }
    return removed;
}
