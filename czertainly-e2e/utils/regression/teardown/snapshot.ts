/**
 * snapshot — reads a tier into a `TierSnapshot` and stores it.
 *
 * WHAT: `snapshotTier` reads every resource of `SNAPSHOT_RESOURCES` (total, foreign objects with their marks, the windows of a large
 * collection, the platform event associations and system jobs), `unreadableRequired` names the required resources it could not read, and
 * `writeSnapshot` / `readSnapshot` / `deleteSnapshot` / `purgeOldSnapshots` carry the before snapshot across processes.
 *
 * WHY: the before snapshot is taken by the `snapshot` project and judged by the run-end teardown, two processes that
 * share only the state directory. Reading is the only I/O of the proof, so it is kept apart from the pure comparison.
 *
 * HOW: GET / POST reads through a context with `fetch` only; a read that fails is recorded on the resource (`error`), never
 * thrown, so the comparison can say "not compared" or "proof incomplete". Messages carry types and uuids only.
 */
import { APIRequestContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../Logger';
import { currentRunId } from '../run/runId';
import { tierIdentity } from '../tier/kind';
import { SNAPSHOT_RESOURCES } from '../resourceTypes';
import {
    canonicalJson, descriptionOf, isRunNamed, ItemMark, NEWEST_ROWS_SAMPLED, OLDEST_ROWS_CHECKED, PAGE, REQUIRED_RESOURCES,
    PositionedRow, ResourceDef, ResourceSnapshot, TierSnapshot,
} from './snapshotModel';
import type { JsonObject } from '../json';

const logger = new Logger('NonInterference');


/** What the reads need of an API context: `fetch` only (the post-delete snapshot reads through a re-authenticating wrapper). */
export type SnapshotReader = Pick<APIRequestContext, 'fetch'>;

export async function call(api: SnapshotReader, method: 'GET' | 'POST', url: string, data?: unknown): Promise<{ status: number; body: any }> {
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

async function get(api: SnapshotReader, method: 'GET' | 'POST', url: string, data?: unknown): Promise<any> {
    const r = await call(api, method, url, data);
    if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${url} answered ${r.status}`);
    return r.body;
}

async function searchPage(api: SnapshotReader, def: ResourceDef, pageNumber: number, itemsPerPage: number): Promise<{ items: JsonObject[]; total: number; totalPages?: number }> {
    const body = await get(api, 'POST', def.path, { itemsPerPage, pageNumber, filters: [], ...(def.body ?? {}) });
    return { items: body?.[def.itemsKey!] ?? [], total: Number(body?.totalItems ?? 0), totalPages: body?.totalPages };
}

interface ReadRows {
    items: JsonObject[];
    total: number;
    /** Windowed reads only: each row with its position in the newest-first list (the straddle test of keys). */
    positioned?: PositionedRow[];
}

// ------------------------------------------------------------------ the readers: one per way a collection is read

/** Total, the newest NEWEST_ROWS_SAMPLED rows (head) and the oldest OLDEST_ROWS_CHECKED rows (tail) of a newest-first search. */
async function readWindows(api: SnapshotReader, def: ResourceDef): Promise<ReadRows> {
    const { total } = await searchPage(api, def, 1, 1);
    const start = Math.max(0, total - OLDEST_ROWS_CHECKED);
    const lastPage = Math.ceil(total / PAGE);
    const pages = new Set<number>();
    for (let p = 1; p <= Math.min(lastPage, Math.ceil(NEWEST_ROWS_SAMPLED / PAGE)); p++) pages.add(p);
    for (let p = Math.floor(start / PAGE) + 1; p <= lastPage; p++) pages.add(p);
    const positioned: PositionedRow[] = [];
    for (const page of [...pages].sort((a, b) => a - b)) {
        const { items: rows } = await searchPage(api, def, page, PAGE);
        rows.forEach((row, i) => {
            const pos = (page - 1) * PAGE + i;
            if (pos < NEWEST_ROWS_SAMPLED || pos >= start) positioned.push({ row, pos });
        });
    }
    return { items: positioned.map((p) => p.row), total, positioned };
}

async function readAllPaged(api: SnapshotReader, def: ResourceDef): Promise<ReadRows> {
    const items: JsonObject[] = [];
    let total = 0;
    for (let page = 1; page <= 50; page++) {
        const body = await get(api, 'GET', `${def.path}?itemsPerPage=${PAGE}&pageNumber=${page}`);
        const rows: JsonObject[] = body?.[def.itemsKey!] ?? [];
        items.push(...rows);
        total = Number(body?.totalItems ?? items.length);
        if (page >= Number(body?.totalPages ?? 1) || rows.length === 0) break;
    }
    return { items, total };
}

async function readAllSearch(api: SnapshotReader, def: ResourceDef): Promise<ReadRows> {
    const items: JsonObject[] = [];
    let total = 0;
    for (let page = 1; page <= 50; page++) {
        const r = await searchPage(api, def, page, PAGE);
        items.push(...r.items);
        total = r.total;
        if (page >= Number(r.totalPages ?? 1) || r.items.length === 0) break;
    }
    return { items, total };
}

async function readList(api: SnapshotReader, def: ResourceDef): Promise<ReadRows> {
    const list: JsonObject[] = await get(api, 'GET', def.path);
    return { items: list ?? [], total: (list ?? []).length };
}

/** How each kind of resource is read (`ResourceDef.read`). */
const READERS: Record<ResourceDef['read'], (api: SnapshotReader, def: ResourceDef) => Promise<ReadRows>> = {
    list: readList,
    paged: readAllPaged,
    searchAll: readAllSearch,
    search: readWindows,
};

// ------------------------------------------------------------------ one resource

/**
 * The foreign objects among the rows (the default: a row whose name is not run-named; a resource may bring its own, `ResourceDef.foreign`).
 */
function foreignOf(def: ResourceDef, rows: JsonObject[]): Record<string, ItemMark> {
    if (def.foreign) return def.foreign(def, rows);
    const uuidOf = def.uuid ?? ((i: JsonObject) => i.uuid);
    const out: Record<string, ItemMark> = {};
    for (const i of rows) {
        const name = String(def.name(i) ?? '');
        if (!isRunNamed(name)) out[String(uuidOf(i))] = { name, ...descriptionOf(i), marker: def.marker?.(i) };
    }
    return out;
}

/** `GET` of one object's detail: its body, or undefined when it is gone (compareSnapshots reports that). */
async function detailOf(api: SnapshotReader, def: ResourceDef, uuid: string): Promise<JsonObject | undefined> {
    const r = await call(api, 'GET', def.detail!(uuid));
    if (r.status === 404) return undefined;
    if (r.status < 200 || r.status >= 300) throw new Error(`GET ${def.detail!(uuid)} answered ${r.status}`);
    return r.body ?? {};
}

/**
 * An object with a row on a window cut may have further parts outside the windows (a key with an item on the cut): its mark
 * comes from the detail, or the object is dropped when the detail shows it is the run's own.
 */
async function rereadWindowCuts(api: SnapshotReader, def: ResourceDef, read: ReadRows, foreign: Record<string, ItemMark>, notes: string[]): Promise<void> {
    const cuts = def.windowCuts!;
    for (const uuid of cuts.find(read.positioned!, read.total)) {
        if (!foreign[uuid]) continue;
        const d = await detailOf(api, def, uuid);
        delete foreign[uuid];
        if (!d) notes.push(`${def.type}: ${uuid} vanished between the search and its detail read; not compared`);
        else {
            const mark = cuts.markOf(d);
            if (mark) foreign[uuid] = mark;
        }
    }
}

/** A stored foreign object that left the windows is read by its detail, so a deletion is never mistaken for drift. */
async function recheckStored(api: SnapshotReader, def: ResourceDef, recheck: ResourceSnapshot, foreign: Record<string, ItemMark>): Promise<void> {
    for (const [uuid, mark] of Object.entries(recheck.foreign)) {
        if (foreign[uuid]) continue;
        const body = await detailOf(api, def, uuid);
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

/** The uuids (lower case) of EVERY row of the newest sample of a large collection, own or foreign. */
function newestUuidsOf(def: ResourceDef, read: ReadRows): string[] | undefined {
    const uuidOf = def.uuid ?? ((i: JsonObject) => i.uuid);
    return def.large && read.positioned
        ? [...new Set(read.positioned.filter((p) => p.pos < NEWEST_ROWS_SAMPLED).map((p) => String(uuidOf(p.row)).toLowerCase()))]
        : undefined;
}

async function snapshotResource(api: SnapshotReader, def: ResourceDef, recheck?: ResourceSnapshot): Promise<ResourceSnapshot> {
    try {
        const read = await READERS[def.read](api, def);
        const foreign = foreignOf(def, read.items);
        const notes: string[] = [];
        if (def.windowCuts && def.detail && read.positioned) await rereadWindowCuts(api, def, read, foreign, notes);
        if (def.large && recheck && def.detail) await recheckStored(api, def, recheck, foreign);
        const newestUuids = newestUuidsOf(def, read);
        return { total: read.total, foreign, ...(def.large ? { window: OLDEST_ROWS_CHECKED, newest: NEWEST_ROWS_SAMPLED, newestUuids } : {}), ...(notes.length ? { notes } : {}) };
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

export async function snapshotTier(api: SnapshotReader, opts: SnapshotOptions = {}): Promise<TierSnapshot> {
    const resources: Record<string, ResourceSnapshot> = {};
    for (const def of SNAPSHOT_RESOURCES) {
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
            const jobs = (await readAllPaged(api, SNAPSHOT_RESOURCES.find((d) => d.type === 'scheduledJobs')!)).items.filter((j) => j.system);
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
