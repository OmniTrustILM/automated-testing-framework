/**
 * nonInterference — API-GEN-33: the automated proof of the own-objects rule on a shared tier (a run changes only what it created).
 *
 * `snapshotTier(api)` records, per resource, the total and the objects whose name does NOT carry a run prefix
 * (`qa-reg-` / `qa-api-`), each with its name, its description (when the list carries one) and a marker of its
 * mutable state; the platform-level event associations and the system jobs are stored as canonical JSON.
 * `compareSnapshots(before, after)` then asserts:
 *   1. every stored foreign object is still there with an unchanged name, description and marker (roles,
 *      groups, authorities, credentials, connectors and other markerless resources were blind to a rename or an edit);
 *   2. platform event associations and system jobs are identical;
 *   3. net accounting per resource: `after.total - before.total` equals what the run's ledger explains
 *      (own and derived objects created since the before snapshot minus own objects deleted since then), within
 *      NET_TOLERANCE (REG_NET_TOLERANCE, default 0: any unexplained change is a violation). Keys count key items, so
 *      their expected change is a range (an own key brings one or two items, an own certificate up to one
 *      `certKey_<CN>` item);
 *   4. a REQUIRED resource (certificates, RA profiles, authorities, ACME profiles, roles, users, groups, keys, tokens)
 *      that could not be read before the run leaves the proof incomplete: that is a violation, not a note;
 *   5. both snapshots were taken on the same tier (tier identity).
 * A violation is a finding for a human, who rules out concurrent activity on the shared tier: this is a proof, not a lock.
 *
 * Other QA tools on the same tier (after an incident in which a manual-test session's own cleanup deleted
 * its own certificate and key while the API run was in flight). The comparison reads the SHARED ledger: lines of every
 * other run id (qa-man, qa-cand, another qa-reg run, …), each with its `at` INSIDE the run window
 * [before.takenAt, after.takenAt] (`foreignWindowLines`). Such a line explains (one note, never a violation):
 *   - a stored foreign object that is gone, when the line records ITS deletion (same resource type through
 *     FOREIGN_TYPE_ALIASES, same uuid): an explicit `deleted` event, or an event-less line of an older tool whose note
 *     starts with `DELETED` (`foreignEventOf`);
 *   - the change of a total, and only by objects proven NEW: a deletion counts only for a stored foreign object that is
 *     gone; a creation only for an object that has no deletion line of its own inside the window and is proven to have
 *     been created during the run. In a collection read whole: not stored before, stored after. In a large collection
 *     whose detail carries a creation time (keys): a detail read (`confirmForeignCreates`) with a creation time at or
 *     after before.takenAt. In a large collection without one (certificates, discoveries): in the AFTER newest sample
 *     and absent from the BEFORE newest sample (`newestUuids`). Existing alone proves nothing (an object from the middle
 *     of a large collection is not new). Each uuid counts once, so the lines never explain more change than these objects.
 * Fail-closed: a line without a parseable `at`, outside the window, of this run, naming one of this run's own uuids (its
 * ledger lines or the objects the teardown deleted; compared case-insensitively), without a run id, of a type without a
 * snapshot resource, with an event-less note that mentions a deletion anywhere but its start, or that the parser
 * dropped (unreadable, wrong shape) explains nothing. On a tier with a known identity, a line carrying another tier
 * explains nothing, and a line without a tier explains only in the older event-less shape of the other QA tools; when
 * such a tier-less line is used, the note says so. A tier-less line is attributed by its uuid and resource type only
 * (the manual-test tool writes no tier): a uuid is unique across tiers, but nothing else ties the line to this tier.
 * Anything not explained stays a violation.
 *
 * Markers: the list DTOs carry no `updated` field (interfaces origin/main 71d7f73b), only notification profiles a
 * `version`. Everywhere else the marker is the state a forbidden mutation would change: `enabled` (disable), a
 * certificate's `state` / `archived` (revoke, archive), a key's item states (destroy, disable), `ignoreTrigger`, a
 * discovery's terminal status. Volatile fields (connector or token status, fire times) are left out on purpose, and so
 * are the transient discovery statuses `inProgress` / `processing`: a foreign discovery that finishes during the run
 * is not a change the run made.
 *
 * Large collections (certificates, keys, discoveries) are not walked: the snapshot stores the total, the
 * OLDEST window (200, the tail of the newest-first list) and the NEWEST sample (100, the head: the objects most likely
 * to be touched by mistake). In the after snapshot a stored uuid that left both is re-read by its detail URL
 * (`recheck`), so a deletion is never mistaken for drift.
 *
 * Keys (an incident fix): the key search lists one row per key ITEM whose `name` is the item's name, while
 * `GET /v1/keys/{uuid}` names the WRAPPER (core CryptographicKeyItem.mapToSummaryDto vs KeyDetailDto). A key is therefore
 * identified by its wrapper uuid (`keyWrapperUuid`) and marked the same way from rows and from the detail: `name` = its
 * item names, `marker` = its item states (`keyMarksFromRows` / `keyMarksFromDetail`); the wrapper's own name is stored as
 * `wrapper` only when the detail was read and compared only when both snapshots carry it. A key whose rows straddle a
 * window cut (one item on the boundary row of the newest sample or of the oldest window) would get a partial mark from
 * the rows, so such a key is always re-read by its detail (`keysChangedDuringRun`), in the before and the after snapshot alike.
 *
 * Not snapshotted (explicit gap list, `SNAPSHOT_GAPS`): see below; each has a reason.
 *
 * Messages, notes and attachments carry the resource type and the uuid only, never a foreign object's name;
 * names stay in the snapshot files in the local state directory, which `purgeOldSnapshots` clears after 14 days.
 */
import { APIRequestContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../Logger';
import { LedgerLine, runIdPrefix } from '../ledger/ledger';
import { currentRunId, hasRunFamilyPrefix } from '../run/runId';
import { tierIdentity } from '../tier/kind';

const logger = new Logger('NonInterference');

type Json = Record<string, any>;

export interface ItemMark {
    name: string;
    /** The list item's description, when it carries one (compared like the name). */
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
    /** Large collections: the uuids (lower case; keys: wrapper uuids) of EVERY row of the newest sample, own or foreign. */
    newestUuids?: string[];
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

export const OLDEST_ROWS_CHECKED = 200;
export const NEWEST_ROWS_SAMPLED = 100;
const PAGE = 100;

/** Resources whose before snapshot must be readable: without them the proof is not a proof. */
const REQUIRED_RESOURCES: readonly string[] = ['certificates', 'raProfiles', 'authorities', 'acmeProfiles', 'roles', 'users', 'groups', 'keys', 'tokens'];

/** What the snapshot does not cover, and why (an explicit gap list instead of a silent one). */
export const SNAPSHOT_GAPS: Readonly<Record<string, string>> = {
    acmeAccounts: 'no name to tell own from foreign; an account changes only through its own ACME client or its profile',
    approvals: 'requests of certificates; their decisions are covered by the certificate state marker',
    savedViews: 'per-user UI state, no shared impact',
    oidEntries: 'list endpoint is a search keyed by OID (platform settings rows are @local)',
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
    /** The creation time a detail read answers (a large collection whose new objects are proven by it). */
    detailCreated?: (detail: Json) => string | undefined;
}

const enabled = (i: Json) => `enabled=${i.enabled}`;
const certMarker = (i: Json) => `${i.state}${i.archived ? '|archived' : ''}`;
const keyItemsMarker = (items: Json[]) => items.map((x) => `${x.state}/${x.enabled}`).sort().join(',');
const keyItemsName = (items: Json[]) => items.map((x) => String(x.name ?? '')).sort().join(',');

/**
 * A name the run family made: a run-prefixed name, or the key core derives from a run certificate
 * (`certKey_<CN>` / `altCertKey_<CN>`, CertificateServiceImpl.uploadCertificateKey) — never foreign.
 */
export function isRunNamed(name: string | undefined): boolean {
    if (!name) return false;
    const m = /^(?:certKey_|altCertKey_)(.+)$/.exec(name); // core CertificateServiceImpl: "certKey_" + CN, "altCertKey_" + CN
    return hasRunFamilyPrefix(name) || (!!m && hasRunFamilyPrefix(m[1]));
}

/** The wrapper uuid a key search row belongs to (`keyWrapperUuid`; the row's own `uuid` is the item's). */
const keyWrapperOf = (row: Json): string => String(row.keyWrapperUuid ?? row.uuid);

/** The mark of one key from its search rows (the items the windows showed): item names + item states, no wrapper name. */
export function keyMarksFromRows(rows: Json[]): ItemMark {
    return { name: keyItemsName(rows), ...descriptionOf(rows[0]), marker: keyItemsMarker(rows) };
}

/** The same mark from `GET /v1/keys/{uuid}` (all items), plus the wrapper's own name. */
export function keyMarksFromDetail(detail: Json): ItemMark {
    const items: Json[] = Array.isArray(detail?.items) ? detail.items : [];
    return { name: keyItemsName(items), ...descriptionOf(detail), marker: keyItemsMarker(items), wrapper: String(detail?.name ?? '') };
}

/**
 * Wrapper uuids whose rows touch a cut of the windows: the last row of the newest sample (position NEWEST_ROWS_SAMPLED - 1)
 * or the first row of the oldest window (position `start`), when the two do not meet (`start > NEWEST_ROWS_SAMPLED`). The items
 * of one key sit next to each other in the newest-first list (same creation time), so a key with a further item just
 * outside the windows has a row on the boundary; its mark is taken from the detail instead.
 */
export function keysChangedDuringRun(rows: Array<{ row: Json; pos: number }>, total: number): Set<string> {
    const start = Math.max(0, total - OLDEST_ROWS_CHECKED);
    const out = new Set<string>();
    if (start <= NEWEST_ROWS_SAMPLED) return out;
    for (const { row, pos } of rows) if (pos === NEWEST_ROWS_SAMPLED - 1 || pos === start) out.add(keyWrapperOf(row));
    return out;
}
/** Transient discovery statuses are not compared. */
const TRANSIENT_DISCOVERY_STATUSES: readonly string[] = ['inProgress', 'processing'];
const discoveryMarker = (i: Json) => (TRANSIENT_DISCOVERY_STATUSES.includes(i.status) ? undefined : i.status);

export const RESOURCES: ResourceDef[] = [
    {
        type: 'certificates', read: 'search', path: '/api/v1/certificates', itemsKey: 'certificates', body: { includeArchived: true }, large: true,
        name: (i) => i.commonName ?? '', marker: certMarker, detail: (u) => `/api/v1/certificates/${u}`, detailMarker: certMarker,
    },
    {
        // One row per key ITEM (its name is the item's); grouped by wrapper, marked by keyMarksFromRows / keyMarksFromDetail.
        // KeyDetailDto.creationTime (interfaces model/core/cryptography/key/KeyDetailDto.java:26-28) proves a key new.
        type: 'keys', read: 'search', path: '/api/v1/keys', itemsKey: 'cryptographicKeys', large: true, detailCreated: (d) => (typeof d?.creationTime === 'string' ? d.creationTime : undefined),
        name: (i) => i.name ?? '', uuid: keyWrapperOf, detail: (u) => `/api/v1/keys/${u}`, detailMark: keyMarksFromDetail,
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

/** Total, the newest NEWEST_ROWS_SAMPLED rows (head) and the oldest OLDEST_ROWS_CHECKED rows (tail) of a newest-first search. */
async function readWindows(api: APIRequestContext, def: ResourceDef): Promise<ReadRows> {
    const { total } = await searchPage(api, def, 1, 1);
    const start = Math.max(0, total - OLDEST_ROWS_CHECKED);
    const lastPage = Math.ceil(total / PAGE);
    const pages = new Set<number>();
    for (let p = 1; p <= Math.min(lastPage, Math.ceil(NEWEST_ROWS_SAMPLED / PAGE)); p++) pages.add(p);
    for (let p = Math.floor(start / PAGE) + 1; p <= lastPage; p++) pages.add(p);
    const positioned: Array<{ row: Json; pos: number }> = [];
    for (const page of [...pages].sort((a, b) => a - b)) {
        const { items: rows } = await searchPage(api, def, page, PAGE);
        rows.forEach((row, i) => {
            const pos = (page - 1) * PAGE + i;
            if (pos < NEWEST_ROWS_SAMPLED || pos >= start) positioned.push({ row, pos });
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
            if (!rows.some((r) => isRunNamed(String(def.name(r) ?? '')))) out[uuid] = keyMarksFromRows(rows);
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

/** `{ description }` when the item carries a string description, else nothing. */
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
            for (const uuid of keysChangedDuringRun(read.positioned, total)) {
                if (!foreign[uuid]) continue;
                const d = await detailOf(uuid);
                delete foreign[uuid];
                if (!d) notes.push(`${def.type}: ${uuid} vanished between the search and its detail read; not compared`);
                // The detail shows every item: a key with a run-named item outside the windows is the run's own.
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
                // The detail's own name (and description) is compared too; a detail without one keeps the stored value.
                const liveName = def.name(body);
                foreign[uuid] = {
                    name: typeof liveName === 'string' && liveName !== '' ? liveName : mark.name,
                    ...(mark.description !== undefined ? descriptionOf(body) : {}),
                    marker: def.detailMarker?.(body),
                };
            }
        }
        const uuidOf = def.uuid ?? ((i: Json) => i.uuid);
        const newestUuids = def.large && read.positioned
            ? [...new Set(read.positioned.filter((p) => p.pos < NEWEST_ROWS_SAMPLED).map((p) => String(uuidOf(p.row)).toLowerCase()))]
            : undefined;
        return { total, foreign, ...(def.large ? { window: OLDEST_ROWS_CHECKED, newest: NEWEST_ROWS_SAMPLED, newestUuids } : {}), ...(notes.length ? { notes } : {}) };
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

/** The required resources a snapshot could not read. */
export function unreadableRequired(snap: TierSnapshot): string[] {
    return REQUIRED_RESOURCES.filter((t) => !snap.resources[t] || snap.resources[t].error);
}

// ------------------------------------------------------------------ other QA tools (shared ledger)

/**
 * The ledger types other QA tools write (shared ledger, read 2026-10-16: qa-man, qa-cand, …) that name a snapshot
 * resource under another spelling. A snapshot resource type names itself; every other type explains nothing.
 */
const FOREIGN_TYPE_ALIASES: Readonly<Record<string, string>> = {
    certificate: 'certificates', key: 'keys', cryptographicKeys: 'keys', raProfile: 'raProfiles', authority: 'authorities',
    role: 'roles', discovery: 'discoveries', customAttribute: 'customAttributes', trigger: 'triggers', workflowTriggers: 'triggers',
    rule: 'rules', condition: 'conditions', action: 'actions', workflowActions: 'actions', execution: 'executions',
    workflowExecutions: 'executions', approvalProfile: 'approvalProfiles', scheduledJob: 'scheduledJobs',
};

/** The snapshot resource a ledger type of another tool names, or undefined. */
export function foreignResourceType(type: unknown): string | undefined {
    if (typeof type !== 'string') return undefined;
    if (RESOURCES.some((d) => d.type === type)) return type;
    return Object.hasOwn(FOREIGN_TYPE_ALIASES, type) ? FOREIGN_TYPE_ALIASES[type] : undefined;
}

/** An event-less line of an older tool records a deletion when its note STARTS with this (`DELETED (own)`, `DELETED → …`). */
const FOREIGN_DELETION_NOTE = /^DELETED\b/;
/** Any other mention of a removal in an event-less note leaves the line ambiguous ("uploaded; will be bulk-deleted"). */
const REMOVAL_WORDS = /delet|remov/i;

/**
 * What a line of ANOTHER run records: `created`, `deleted`, or undefined (explains nothing). A line with an explicit
 * event is read by it; an event-less line (`eventImplied`) by its note: `DELETED…` at the start is a deletion, a note
 * mentioning a deletion or removal anywhere else is ambiguous, any other note (or none) a creation.
 */
export function foreignEventOf(line: Pick<LedgerLine, 'event' | 'note' | 'eventImplied'>): 'created' | 'deleted' | undefined {
    if (!line.eventImplied) return line.event === 'created' || line.event === 'deleted' ? line.event : undefined;
    const note = typeof line.note === 'string' ? line.note : '';
    if (FOREIGN_DELETION_NOTE.test(note)) return 'deleted';
    if (REMOVAL_WORDS.test(note)) return undefined;
    return 'created';
}

export interface ForeignLine {
    /** The snapshot resource type. */
    type: string;
    uuid: string;
    event: 'created' | 'deleted';
    /** The QA tool family of the line's run id (`qa-man`, …; never the run id itself). */
    family: string;
    /** The line carries no tier identity while the snapshots do (accepted only in the older event-less shape). */
    tierless?: boolean;
}

/**
 * The lines of other runs inside the run window [since, until] (epoch ms) that can explain something, or none when the
 * window itself is not known. `ownUuids`: the uuids of this run's own lines (never explained by another tool).
 */
export function foreignWindowLines(ledger: readonly LedgerLine[], runId: string, since: number, until: number, tier?: string, ownUuids: ReadonlySet<string> = new Set()): ForeignLine[] {
    if (!Number.isFinite(since) || !Number.isFinite(until) || until < since) return [];
    const own = new Set([...ownUuids].map((u) => u.toLowerCase()));
    const out: ForeignLine[] = [];
    for (const l of ledger) {
        if (typeof l.runId !== 'string' || !l.runId || l.runId === runId) continue;
        if (typeof l.uuid !== 'string' || own.has(l.uuid.toLowerCase())) continue;
        const at = typeof l.at === 'string' ? Date.parse(l.at) : NaN;
        if (!Number.isFinite(at) || at < since || at > until) continue;
        if (tier && l.tier && l.tier !== tier) continue;
        // A line without a tier on a tier with a known identity: only the older event-less shape of the other QA tools.
        const tierless = !!tier && !l.tier;
        if (tierless && !l.eventImplied) continue;
        const type = foreignResourceType(l.type);
        const event = foreignEventOf(l);
        if (!type || !event) continue;
        out.push({ type, uuid: l.uuid.toLowerCase(), event, family: runIdPrefix(l), ...(tierless ? { tierless: true } : {}) });
    }
    return out;
}

/** The uuids of this run (its ledger lines and the objects its teardown deleted), lower-cased. */
function ownUuidsOf(ledger: readonly LedgerLine[], runId: string, ownDeleted: ReadonlyArray<{ uuid: string }> = []): Set<string> {
    return new Set([...ledger.filter((l) => l.runId === runId).map((l) => l.uuid), ...ownDeleted.map((d) => d.uuid)].filter((u) => typeof u === 'string').map((u) => u.toLowerCase()));
}

/**
 * Objects other QA tools created inside the window in a LARGE collection whose detail carries a creation time (keys):
 * each is read by its detail URL, and the ones that answer 200 with a creation time at or after before.takenAt are
 * returned as `<type>:<uuid>` for `CompareOptions.confirmedCreated`. Anything else (404, an error, no or an older
 * creation time) confirms nothing; existing alone is no proof that an object is new.
 */
export async function confirmForeignCreates(api: APIRequestContext, before: TierSnapshot, after: TierSnapshot, opts: Pick<CompareOptions, 'ledger' | 'runId' | 'ownDeleted'> = {}): Promise<string[]> {
    const runId = opts.runId ?? before.runId;
    const ledger = opts.ledger ?? [];
    const lines = foreignWindowLines(ledger, runId, Date.parse(before.takenAt), Date.parse(after.takenAt), before.tier, ownUuidsOf(ledger, runId, opts.ownDeleted));
    const deleted = new Set(lines.filter((f) => f.event === 'deleted').map((f) => `${f.type}:${f.uuid}`));
    const out: string[] = [];
    for (const f of lines) {
        const def = RESOURCES.find((d) => d.type === f.type);
        const key = `${f.type}:${f.uuid}`;
        if (f.event !== 'created' || !def?.large || !def.detail || !def.detailCreated || deleted.has(key) || out.includes(key)) continue;
        const b = before.resources[f.type];
        const a = after.resources[f.type];
        if (!b || b.error || !a || a.error || b.foreign[f.uuid]) continue;
        try {
            const r = await call(api, 'GET', def.detail(f.uuid));
            const created = r.status === 200 ? Date.parse(String(def.detailCreated(r.body ?? {}) ?? '')) : NaN;
            if (Number.isFinite(created) && created >= Date.parse(before.takenAt)) out.push(key);
        } catch {
            // unreadable: confirms nothing
        }
    }
    return out;
}

// ------------------------------------------------------------------ compare (pure)

/** REG_NET_TOLERANCE: allowed unexplained change of a total (default 0; raise it only on a busy tier, and say so). */
export function allowedNetChange(env: NodeJS.ProcessEnv = process.env): number {
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
    /** `<type>:<uuid>` of other tools' creates in a large collection confirmed by a detail read (`confirmForeignCreates`). */
    confirmedCreated?: readonly string[];
}

export interface CompareResult {
    violations: string[];
    /** Resources that could not be compared, the accounting tolerance, and own deletions that explain a missing object. */
    notes: string[];
}

export function compareSnapshots(before: TierSnapshot, after: TierSnapshot, opts: CompareOptions = {}): CompareResult {
    const runId = opts.runId ?? before.runId;
    const tolerance = opts.tolerance ?? allowedNetChange();
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
    // Other QA tools: their lines inside [before.takenAt, after.takenAt], keyed by resource type and uuid.
    const foreign = foreignWindowLines(opts.ledger ?? [], runId, since, Date.parse(after.takenAt), before.tier, ownUuidsOf(opts.ledger ?? [], runId, opts.ownDeleted));
    const tierless = new Set(foreign.filter((f) => f.tierless).map((f) => `${f.type}:${f.uuid}`));
    const foreignBy = (event: 'created' | 'deleted') => {
        const m = new Map<string, Map<string, string>>();
        for (const f of foreign) if (f.event === event) m.set(f.type, (m.get(f.type) ?? new Map()).set(f.uuid, f.family));
        return m;
    };
    const foreignDeleted = foreignBy('deleted');
    const foreignCreated = foreignBy('created');
    const confirmed = new Set(opts.confirmedCreated ?? []);
    /** The family of a line, marked when the line carries no tier identity. */
    const familyOf = (m: Map<string, Map<string, string>>, type: string, uuid: string): string =>
        `${m.get(type)!.get(uuid)}${tierless.has(`${type}:${uuid}`) ? ', a line without tier identity' : ''}`;
    /** Stored foreign objects of `type` that are gone and whose deletion another tool recorded inside the window. */
    const foreignGone = (type: string): string[] => {
        const b = before.resources[type];
        const a = after.resources[type];
        if (!b || b.error || !a || a.error) return [];
        return [...(foreignDeleted.get(type)?.keys() ?? [])].filter((u) => b.foreign[u] && !a.foreign[u]);
    };
    /**
     * Objects another tool created inside the window, proven new: no deletion line of their own inside the window, and
     * - a collection read whole: not stored before, stored after;
     * - a large collection with a creation time on the detail: confirmed by `confirmForeignCreates`;
     * - any other large collection: in the after newest sample, absent from the before newest sample.
     */
    const foreignNew = (type: string): string[] => {
        const b = before.resources[type];
        const a = after.resources[type];
        if (!b || b.error || !a || a.error) return [];
        const def = RESOURCES.find((d) => d.type === type);
        const proven = (u: string): boolean => {
            if (!def?.large) return !b.foreign[u] && !!a.foreign[u];
            if (def.detailCreated) return confirmed.has(`${type}:${u}`);
            // An empty before sample of a non-empty collection is a failed read, not evidence: it fails closed.
            const beforeSampled = !!b.newestUuids && (b.newestUuids.length > 0 || b.total === 0);
            return beforeSampled && !!a.newestUuids && a.newestUuids.includes(u) && !b.newestUuids!.includes(u);
        };
        return [...(foreignCreated.get(type)?.keys() ?? [])].filter((u) => !foreignDeleted.get(type)?.has(u) && proven(u));
    };
    const explained: string[] = [];
    const explainedTotals: string[] = [];

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
                else if (foreignDeleted.get(type)?.has(uuid.toLowerCase())) explained.push(`${type} ${uuid} deleted (${familyOf(foreignDeleted, type, uuid.toLowerCase())})`);
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
        // Net accounting. Keys count key items: an own key brings one or two, an own certificate up to one
        // certKey_<CN> item; a derived key line is one such item.
        let lo: number;
        let hi: number;
        // Other tools: a key line brings or takes one or two key items, a certificate up to one certKey_ item.
        const created = foreignNew(type);
        const fNew = created.length;
        const fGone = foreignGone(type).length;
        if (fNew) explainedTotals.push(`${type} +${fNew} created (${[...new Set(created.map((u) => familyOf(foreignCreated, type, u)))].sort().join(', ')})`);
        if (type === 'keys') {
            lo = createdOwnKeys - 2 * deletedOwnKeys - deletedDerivedKeys + fNew - 2 * fGone;
            hi = 2 * createdOwnKeys + createdSince('certificates') - deletedOwnKeys - deletedDerivedKeys + 2 * fNew + foreignNew('certificates').length - fGone;
        } else {
            lo = hi = createdSince(type) - deletedSince(type) + fNew - fGone;
        }
        const delta = a.total - b.total;
        if (delta < lo - tolerance || delta > hi + tolerance) {
            const expected = lo === hi ? `${lo >= 0 ? '+' : ''}${lo}` : `${lo}..+${hi}`;
            violations.push(`${type}: total ${b.total} -> ${a.total} (${delta >= 0 ? '+' : ''}${delta}), the ledger explains ${expected}` +
                (tolerance ? ` ±${tolerance}` : ''));
        }
    }
    if (explained.length || explainedTotals.length) {
        notes.push(`explained by other QA tools' ledger lines inside the run window: ${[...explained, ...explainedTotals].join('; ')}`);
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

export function writeSnapshot(snap: TierSnapshot, file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, file);
}

export function readSnapshot(file: string): TierSnapshot | undefined {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as TierSnapshot;
    } catch {
        return undefined;
    }
}

/**
 * Removes one snapshot file (missing is fine): the setup drops a stale before-snapshot of the same run id (specs
 * may not write or remove files themselves, the lint's fs-write rule).
 */
export function deleteSnapshot(file: string): void {
    fs.rmSync(file, { force: true });
}

const SNAPSHOT_MAX_AGE_DAYS = 14;

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
