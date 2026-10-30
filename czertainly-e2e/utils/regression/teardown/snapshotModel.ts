/**
 * snapshotModel — what a tier snapshot is made of: its shapes, the resource definitions and the marks.
 *
 * Provides `TierSnapshot` / `ResourceSnapshot` / `ItemMark`, the shape of a resource definition (`ResourceDef`: how a resource
 * is read and marked; the definitions themselves are in the registry, utils/regression/resourceTypes.ts), the pure name and mark
 * helpers (`isRunNamed`, the key marks) and `canonicalJson`.
 *
 * The reads (snapshot.ts) and the comparison (compare.ts) share this vocabulary, so it lives in one module without any I/O. The
 * long description of the whole proof is the header of nonInterference.ts.
 */
import { hasRunFamilyPrefix } from '../run/runId';

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
export const PAGE = 100;

/** Resources whose before snapshot must be readable: without them the proof is not a proof. */
export const REQUIRED_RESOURCES: readonly string[] = ['certificates', 'raProfiles', 'authorities', 'acmeProfiles', 'roles', 'users', 'groups', 'keys', 'tokens'];

export interface ResourceDef {
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
    /**
     * The foreign objects among the rows read, by uuid. Default: every row whose name is not run-named, marked by its name,
     * description and `marker`. Keys: one row per key ITEM, grouped by key.
     */
    foreign?: (def: ResourceDef, rows: Json[]) => Record<string, ItemMark>;
    /**
     * A large collection whose object spans several rows: which objects have a row on a window cut (their mark is read from
     * the detail instead) and what that detail's mark is (undefined: the detail shows a run-named part, the object is the run's own).
     */
    windowCuts?: { find: (rows: PositionedRow[], total: number) => Set<string>; markOf: (detail: Json) => ItemMark | undefined };
    /**
     * The range the ledger explains for the change of the total, from the counts of this resource. Default: exactly what the
     * run created minus what it deleted, plus what other tools created and minus what they deleted. Keys count key items.
     */
    delta?: (counts: AccountingCounts) => [low: number, high: number];
}

/** A row of a windowed read with its position in the newest-first list. */
export interface PositionedRow {
    row: Json;
    pos: number;
}

/** The ledger counts one resource's accounting rule reads (`ResourceDef.delta`), since the before snapshot. */
export interface AccountingCounts {
    /** This run's objects of the resource created / deleted (derived objects included). */
    created: number;
    deleted: number;
    /** The same without the derived objects (an object the platform made on its own, e.g. a `certKey_` key). */
    createdOwn: number;
    deletedOwn: number;
    /** Objects other tools created (proven new) / deleted inside the run window. */
    foreignNew: number;
    foreignGone: number;
    /** The created and proven-new counts of another resource (keys count the key items an own certificate brings). */
    of(type: string): { created: number; foreignNew: number };
}

export const enabledMarker = (i: Json) => `enabled=${i.enabled}`;
export const certMarker = (i: Json) => `${i.state}${i.archived ? '|archived' : ''}`;
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
export const keyWrapperOf = (row: Json): string => String(row.keyWrapperUuid ?? row.uuid);

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
export function keysChangedDuringRun(rows: PositionedRow[], total: number): Set<string> {
    const start = Math.max(0, total - OLDEST_ROWS_CHECKED);
    const out = new Set<string>();
    if (start <= NEWEST_ROWS_SAMPLED) return out;
    for (const { row, pos } of rows) if (pos === NEWEST_ROWS_SAMPLED - 1 || pos === start) out.add(keyWrapperOf(row));
    return out;
}

/** Keys: one search row per key ITEM; grouped by wrapper, a key is foreign when none of its items carries a run prefix. */
export function foreignKeyRows(def: ResourceDef, rows: Json[]): Record<string, ItemMark> {
    const uuidOf = def.uuid ?? ((i: Json) => i.uuid);
    const byKey = new Map<string, Json[]>();
    for (const i of rows) byKey.set(uuidOf(i), [...(byKey.get(uuidOf(i)) ?? []), i]);
    const out: Record<string, ItemMark> = {};
    for (const [uuid, keyRows] of byKey) {
        if (!keyRows.some((r) => isRunNamed(String(def.name(r) ?? '')))) out[uuid] = keyMarksFromRows(keyRows);
    }
    return out;
}

/**
 * Keys on a window cut are re-read by detail; the detail shows every item, so a run-named item outside the windows makes the key the run's
 * own.
 */
export const keyWindowCuts: NonNullable<ResourceDef['windowCuts']> = {
    find: keysChangedDuringRun,
    markOf: (detail) => (((detail.items as Json[] | undefined) ?? []).some((it) => isRunNamed(String(it?.name ?? ''))) ? undefined : keyMarksFromDetail(detail)),
};

/**
 * The change of the keys total the ledger explains, as a range (keys count key items): an own key brings one or two items, an own
 * certificate up to one `certKey_<CN>` item, a derived key line is one such item. Other tools: a key line brings or takes one or
 * two key items, a certificate up to one `certKey_` item.
 */
export const keyItemsDelta: NonNullable<ResourceDef['delta']> = (c) => {
    const deletedDerived = c.deleted - c.deletedOwn;
    const certificates = c.of('certificates');
    return [
        c.createdOwn - 2 * c.deletedOwn - deletedDerived + c.foreignNew - 2 * c.foreignGone,
        2 * c.createdOwn + certificates.created - c.deletedOwn - deletedDerived + 2 * c.foreignNew + certificates.foreignNew - c.foreignGone,
    ];
};

/** Transient discovery statuses are not compared. */
const TRANSIENT_DISCOVERY_STATUSES: readonly string[] = ['inProgress', 'processing'];
export const discoveryMarker = (i: Json) => (TRANSIENT_DISCOVERY_STATUSES.includes(i.status) ? undefined : i.status);

/** `{ description }` when the item carries a string description, else nothing. */
export function descriptionOf(item: Json): { description?: string } {
    return typeof item?.description === 'string' ? { description: item.description } : {};
}

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
