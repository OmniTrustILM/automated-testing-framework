/** snapshotModel — the shapes of a tier snapshot, the resource definitions' vocabulary, name and mark helpers; no I/O. */
import { hasRunFamilyPrefix } from '../run/runId';

type Json = Record<string, any>;

export interface ItemMark {
    name: string;
    description?: string;
    marker?: string;
    wrapper?: string;
}

export interface ResourceSnapshot {
    total: number;
    foreign: Record<string, ItemMark>;
    window?: number;
    newest?: number;
    newestUuids?: string[];
    error?: string;
    notes?: string[];
}

export interface TierSnapshot {
    takenAt: string;
    runId: string;
    tier?: string;
    resources: Record<string, ResourceSnapshot>;
    platformEvents?: string;
    systemJobs?: string;
}

export const OLDEST_ROWS_CHECKED = 200;
export const NEWEST_ROWS_SAMPLED = 100;
export const PAGE = 100;

export const REQUIRED_RESOURCES: readonly string[] = ['certificates', 'raProfiles', 'authorities', 'acmeProfiles', 'roles', 'users', 'groups', 'keys', 'tokens'];

export interface ResourceDef {
    type: string;
    /** list: GET array; paged: GET with paging; search: POST window of a large collection; searchAll: POST search walked page by page. */
    read: 'list' | 'search' | 'paged' | 'searchAll';
    path: string;
    itemsKey?: string;
    body?: Json;
    large?: boolean;
    name: (item: Json) => string;
    uuid?: (item: Json) => string;
    marker?: (item: Json) => string | undefined;
    detail?: (uuid: string) => string;
    detailMarker?: (detail: Json) => string | undefined;
    detailMark?: (detail: Json) => ItemMark;
    detailCreated?: (detail: Json) => string | undefined;
    /**
     * The foreign objects among the rows read, by uuid. Default: every row
     * whose name is not run-named. Keys: one row per key item, grouped by key.
     */
    foreign?: (def: ResourceDef, rows: Json[]) => Record<string, ItemMark>;
    /**
     * A large collection whose object spans several rows: which objects sit on a window cut (their mark comes from the detail) and what
     * that mark is.
     */
    windowCuts?: { find: (rows: PositionedRow[], total: number) => Set<string>; markOf: (detail: Json) => ItemMark | undefined };
    /**
     * The range the ledger explains for the change of the total. Default: created minus deleted, plus other tools' creates minus their
     * deletes. Keys count key items.
     */
    delta?: (counts: AccountingCounts) => [low: number, high: number];
}

export interface PositionedRow {
    row: Json;
    pos: number;
}

export interface AccountingCounts {
    created: number;
    deleted: number;
    createdOwn: number;
    deletedOwn: number;
    foreignNew: number;
    foreignGone: number;
    of(type: string): { created: number; foreignNew: number };
}

export const enabledMarker = (i: Json) => `enabled=${i.enabled}`;
export const certMarker = (i: Json) => `${i.state}${i.archived ? '|archived' : ''}`;
const keyItemsMarker = (items: Json[]) => items.map((x) => `${x.state}/${x.enabled}`).sort().join(',');
const keyItemsName = (items: Json[]) => items.map((x) => String(x.name ?? '')).sort().join(',');

/** A name the run family made: run-prefixed, or the key core derives from a run certificate (`certKey_<CN>`); never foreign. */
export function isRunNamed(name: string | undefined): boolean {
    if (!name) return false;
    const m = /^(?:certKey_|altCertKey_)(.+)$/.exec(name);
    return hasRunFamilyPrefix(name) || (!!m && hasRunFamilyPrefix(m[1]));
}

export const keyWrapperOf = (row: Json): string => String(row.keyWrapperUuid ?? row.uuid);

export function keyMarksFromRows(rows: Json[]): ItemMark {
    return { name: keyItemsName(rows), ...descriptionOf(rows[0]), marker: keyItemsMarker(rows) };
}

export function keyMarksFromDetail(detail: Json): ItemMark {
    const items: Json[] = Array.isArray(detail?.items) ? detail.items : [];
    return { name: keyItemsName(items), ...descriptionOf(detail), marker: keyItemsMarker(items), wrapper: String(detail?.name ?? '') };
}

/**
 * Wrapper uuids whose rows touch a window cut (a key's items sit next to each other, so one just outside has a boundary row); their mark is
 * taken from the detail.
 */
export function keysChangedDuringRun(rows: PositionedRow[], total: number): Set<string> {
    const start = Math.max(0, total - OLDEST_ROWS_CHECKED);
    const out = new Set<string>();
    if (start <= NEWEST_ROWS_SAMPLED) return out;
    for (const { row, pos } of rows) if (pos === NEWEST_ROWS_SAMPLED - 1 || pos === start) out.add(keyWrapperOf(row));
    return out;
}

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

/** Keys on a window cut are re-read by detail: a run-named item outside the windows makes the key the run's own. */
export const keyWindowCuts: NonNullable<ResourceDef['windowCuts']> = {
    find: keysChangedDuringRun,
    markOf: (detail) => (((detail.items as Json[] | undefined) ?? []).some((it) => isRunNamed(String(it?.name ?? ''))) ? undefined : keyMarksFromDetail(detail)),
};

/** The change of the keys total the ledger explains, as a range (keys count key items; an own certificate brings up to one `certKey_` item). */
export const keyItemsDelta: NonNullable<ResourceDef['delta']> = (c) => {
    const deletedDerived = c.deleted - c.deletedOwn;
    const certificates = c.of('certificates');
    return [
        c.createdOwn - 2 * c.deletedOwn - deletedDerived + c.foreignNew - 2 * c.foreignGone,
        2 * c.createdOwn + certificates.created - c.deletedOwn - deletedDerived + 2 * c.foreignNew + certificates.foreignNew - c.foreignGone,
    ];
};

export const TRANSIENT_DISCOVERY_STATUSES: readonly string[] = ['inProgress', 'processing'];
export const discoveryMarker = (i: Json) => (TRANSIENT_DISCOVERY_STATUSES.includes(i.status) ? undefined : i.status);

export function descriptionOf(item: Json): { description?: string } {
    return typeof item?.description === 'string' ? { description: item.description } : {};
}

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
