/**
 * ownership — the guard that keeps every mutation and delete on objects this run created.
 * Only a ledger line of this run and tier proves ownership; a name prefix alone does not. Messages carry type and uuid, never a name.
 * An existing object used only as a parent (REG_RA_PROFILE_NAME and its authority) is never changed.
 */
import type { APIRequestContext } from '@playwright/test';
import * as fs from 'fs';
import { Logger } from '../../Logger';
import { parseFlag } from '../run/flags';
import { LedgerLine, ledgerFile, parseLedger } from './ledger';
import { currentRunId } from '../run/runId';
import { tierIdentity } from '../tier/kind';
import { idNamedTypesOf, liveReadSpecsOf, type LiveReadSpec } from '../resourceTypes';
import { settings } from '../run/settings';
import { rowsOf } from '../json';
import type { JsonObject } from '../json';


/**
 * Why the guard refused: `ownership` (not this run's object), `derived`, `not-guarded` (raw context) or `request`
 * (path, origin, body or bulk not allowed). The live guard proof asserts `ownership` specifically.
 */
export type RefusalKind = 'ownership' | 'derived' | 'not-guarded' | 'request';

export class OwnObjectViolation extends Error {
    readonly uuid?: string;
    constructor(
        readonly helper: string,
        ref: { uuid?: string },
        readonly reason: string,
        readonly type?: string,
        readonly kind: RefusalKind = 'ownership',
    ) {
        super(`${helper}: refusing to touch ${type ?? 'object'} ${ref.uuid ?? '(no uuid)'}: ${reason}. ` +
            'Only objects with a ledger "created" line of this run (and a live run-prefixed name) may be changed or deleted.');
        this.name = 'OwnObjectViolation';
        this.uuid = ref.uuid;
    }
}

export class LiveObjectMissing extends Error {
    constructor(readonly type: string, readonly uuid: string, detail: string) {
        super(`${type} ${uuid}: route or object missing (${detail})`);
        this.name = 'LiveObjectMissing';
    }
}

export interface OwnershipOptions {
    runId?: string;
    lines?: LedgerLine[];
    file?: string;
    tier?: string;
    /** Unit-test seam. */
    env?: NodeJS.ProcessEnv;
}

export function restrictedUsername(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return settings(env).restrictedUsername?.toLowerCase();
}

let cache: { file: string; size: number; mtimeMs: number; lines: LedgerLine[] } | undefined;

export function resetLedgerCacheForTests(): void {
    cache = undefined;
}

export function cachedLedger(file: string = ledgerFile()): LedgerLine[] {
    if (!fs.existsSync(file)) return [];
    const st = fs.statSync(file);
    if (!cache || cache.file !== file || cache.size !== st.size || cache.mtimeMs !== st.mtimeMs) {
        cache = { file, size: st.size, mtimeMs: st.mtimeMs, lines: parseLedger(fs.readFileSync(file, 'utf8')) };
    }
    return cache.lines;
}

export interface Ownership {
    own: boolean;
    reason: string;
    line?: LedgerLine;
}

/** `<run id>-…` or `<run id>.…` (DNS names); for `users` only, also the fixed REG_RESTRICTED_USERNAME. */
export function carriesRunPrefix(name: string, runId: string = currentRunId(), type?: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (name.startsWith(`${runId}-`) || name.startsWith(`${runId}.`)) return true;
    if (type !== 'users') return false;
    const ded = restrictedUsername(env);
    return ded !== undefined && name.trim().toLowerCase() === ded;
}

export function checkOwnership(ref: { uuid: string; name?: string }, opts: OwnershipOptions = {}): Ownership {
    const runId = opts.runId ?? currentRunId();
    const lines = opts.lines ?? cachedLedger(opts.file);
    let created: LedgerLine | undefined;
    let deletedAfter = false;
    for (const l of lines) {
        if (l.uuid !== ref.uuid || l.runId !== runId) continue;
        if (l.event === 'created') {
            created = l;
            deletedAfter = false;
        } else if (l.event === 'deleted' && created) deletedAfter = true;
    }
    if (!created) return { own: false, reason: `no ledger "created" line of run ${runId}` };
    if (deletedAfter) return { own: false, reason: 'the ledger records it as deleted already', line: created };
    if (opts.tier !== undefined && created.tier !== opts.tier) {
        return { own: false, reason: created.tier ? 'recorded on another tier (tier identity differs)' : 'the line has no tier identity (written before the field existed)', line: created };
    }
    if (created.derived) {
        if (!created.createdAfter) return { own: false, reason: 'derived line without createdAfter', line: created };
        return { own: true, reason: `derived (created after ${created.createdAfter})`, line: created };
    }
    // The ledger's own name decides; a caller-supplied name never rescues a line without the prefix.
    if (!carriesRunPrefix(created.name, runId, created.type, opts.env)) {
        return { own: false, reason: `name does not start with ${runId}- (or ${runId}. for a DNS name${created.type === 'users' ? '; or REG_RESTRICTED_USERNAME for a users line' : ''})`, line: created };
    }
    return { own: true, reason: 'created by this run', line: created };
}

export function isOwnObject(ref: { uuid: string; name?: string }, opts: OwnershipOptions = {}): boolean {
    return checkOwnership(ref, opts).own;
}

export function assertOwn(ref: { uuid: string; name?: string }, helper: string, opts: OwnershipOptions = {}): LedgerLine {
    const o = checkOwnership(ref, opts);
    if (!o.own) throw new OwnObjectViolation(helper, ref, o.reason, o.line?.type);
    return o.line!;
}


export interface LiveRead {
    url: (api: APIRequestContext, uuid: string, line: LedgerLine) => Promise<string | undefined> | string | undefined;
    name: (body: JsonObject) => string | undefined;
}

const parentOf = (line: LedgerLine, key: string): string | undefined => {
    const v = line.parents?.[key];
    return Array.isArray(v) ? v[0] : v;
};

const stringField = (body: JsonObject | undefined, field: string): string | undefined => {
    const value = body?.[field];
    return typeof value === 'string' ? value : undefined;
};

const byName = (url: (u: string) => string, field = 'name'): LiveRead => ({ url: (_api, u) => url(u), name: (b) => stringField(b, field) });

const scoped = (parentKey: string, listUrl: string, listParentField: string, detail: (parent: string, u: string) => string): LiveRead => ({
    async url(api, uuid, line) {
        let parent = parentOf(line, parentKey);
        if (!parent) {
            const res = await api.get(listUrl);
            if (!res.ok()) throw new Error(`GET ${listUrl} answered ${res.status()}`);
            const body = (await res.json()) as JsonObject[] | JsonObject;
            const rows: JsonObject[] = Array.isArray(body) ? body : rowsOf(body.items);
            parent = stringField(rows.find((r) => r.uuid === uuid), listParentField);
        }
        return parent ? detail(parent, uuid) : undefined;
    },
    name: (b) => stringField(b, 'name'),
});

const fillUrl = (template: string, values: { uuid: string; parent?: string }): string =>
    template.replace(/\{(uuid|parent)\}/g, (_match, key: 'uuid' | 'parent') => values[key] ?? '');

export function liveReadOf(spec: LiveReadSpec): LiveRead {
    switch (spec.kind) {
        case 'detail':
            return byName((u) => fillUrl(spec.url, { uuid: u }), spec.nameField);
        case 'parent':
            return { url: (_api, u, line) => { const parent = parentOf(line, spec.parent); return parent ? fillUrl(spec.url, { uuid: u, parent }) : undefined; }, name: (b) => stringField(b, spec.nameField ?? 'name') };
        case 'parent-or-list':
            return scoped(spec.parent, spec.listUrl, spec.listParentField, (parent, u) => fillUrl(spec.url, { uuid: u, parent }));
    }
}

export const liveReadsOf = (specs: Record<string, LiveReadSpec>): Record<string, LiveRead> =>
    Object.fromEntries(Object.entries(specs).map(([type, spec]) => [type, liveReadOf(spec)]));

export const LIVE_READS: Record<string, LiveRead> = liveReadsOf(liveReadSpecsOf());

/** Types whose objects have no name of their own (named by an id): ledger proof only; `k8s:` types too. */
export const ID_NAMED: ReadonlySet<string> = idNamedTypesOf();

export const isIdNamed = (type: string): boolean => ID_NAMED.has(type) || type.startsWith('k8s:');

export interface LiveOwnership {
    line: LedgerLine;
    body?: JsonObject;
    url?: string;
    /** 'list': the detail answered 5xx and the object was read from its full list. */
    via?: 'detail' | 'list';
}


export interface WorkaroundNote {
    bug: string;
    type: string;
    uuid: string;
    note: string;
}

/**
 * Types whose unpaged list is consulted only when the detail read answers 5xx (core#2511: roles and users answer 500
 * instead of 404 for an unknown uuid). A list at the cap may be truncated and proves nothing; a 5xx alone never means "gone".
 */
export const FULL_LIST_TYPES: Readonly<Record<string, { listUrl: string; bug: string; cap: number }>> = {
    roles: { listUrl: '/api/v1/roles', bug: 'core#2511', cap: 1000 },
    users: { listUrl: '/api/v1/users', bug: 'core#2511', cap: 1000 },
};

export function fullListOf(type: string | undefined): { listUrl: string; bug: string; cap: number } | undefined {
    return typeof type === 'string' && Object.hasOwn(FULL_LIST_TYPES, type) ? FULL_LIST_TYPES[type] : undefined;
}

/** Throws when a roles or users list proves nothing (not a list, at the cap, empty, a row without a string uuid); other lists pass. */
export function assertFullList(listUrl: string, rows: unknown, what: string): void {
    const listPath = new URL(listUrl, 'http://list.invalid').pathname.replace(/\/+$/, '');
    const spec = Object.values(FULL_LIST_TYPES).find((s) => s.listUrl === listPath);
    if (!spec) return;
    if (!Array.isArray(rows)) throw new Error(`${what}: ${listUrl} did not answer a list`);
    if (rows.length >= spec.cap) {
        throw new Error(`${what}: ${listUrl} answered ${rows.length} rows (one page holds at most ${spec.cap}); it may be truncated and proves nothing`);
    }
    if (rows.length === 0) throw new Error(`${what}: ${listUrl} answered an empty list; it proves nothing`);
    if (!rows.every((r) => typeof (r as JsonObject | null)?.uuid === 'string')) {
        throw new Error(`${what}: ${listUrl} answered rows without a string uuid; it proves nothing`);
    }
}

/** The row of `uuid` in the full list, or undefined when not named; throws when the list proves nothing (unreadable, capped, empty). */
export async function fullListRow(api: Pick<APIRequestContext, 'get'>, type: string, uuid: string): Promise<JsonObject | undefined> {
    const spec = fullListOf(type);
    if (!spec) throw new Error(`${type} ${uuid}: no authoritative full list (a 5xx detail read is never proof of absence)`);
    const res = await api.get(spec.listUrl);
    if (!res.ok()) throw new Error(`${type} ${uuid}: the authoritative list ${spec.listUrl} answered ${res.status()}`);
    const rows = (await res.json()) as unknown;
    assertFullList(spec.listUrl, rows, `${type} ${uuid}`);
    const wanted = uuid.toLowerCase();
    return (rows as JsonObject[]).find((r) => typeof r?.uuid === 'string' && r.uuid.toLowerCase() === wanted);
}

export interface Absence {
    absent: boolean;
    status: number;
    knownBug?: WorkaroundNote;
    detail: string;
}

/** One absence check after a delete: 404 proves it; a 5xx counts only through the full list; anything else is "not proven absent". */
export async function absenceOf(api: Pick<APIRequestContext, 'get'>, type: string | undefined, uuid: string, detailUrl: string): Promise<Absence> {
    const res = await api.get(detailUrl);
    const status = res.status();
    if (status === 404) return { absent: true, status, detail: 'GET answered 404' };
    const list = fullListOf(type);
    if (status >= 500 && list) {
        try {
            const row = await fullListRow(api, type!, uuid);
            if (!row) {
                return { absent: true, status, detail: `GET answered ${status}; absent from ${list.listUrl}`,
                    knownBug: { bug: list.bug, type: type!, uuid, note: `detail answered ${status} after the delete; absence confirmed through ${list.listUrl}` } };
            }
            return { absent: false, status, detail: `GET answered ${status} and ${list.listUrl} still lists it` };
        } catch (e) {
            return { absent: false, status, detail: `GET answered ${status}; ${(e as Error).message}` };
        }
    }
    return { absent: false, status, detail: status >= 500 ? `GET answered ${status} (a 5xx is never proof of absence)` : `GET still finds it (status ${status})` };
}

export interface LiveOptions extends Omit<OwnershipOptions, 'tier'> {
    /** Default tierIdentity(env); null = not checked. */
    tier?: string | null;
    env?: NodeJS.ProcessEnv;
    onKnownBug?: (note: WorkaroundNote) => void;
}

const logger = new Logger('OwnObjects');

const warnKnownBug = (n: WorkaroundNote): void => logger.warn(`known bug ${n.bug}: ${n.type} ${n.uuid}: ${n.note}`);

/**
 * assertOwn, then the live object: 404 → LiveObjectMissing; for a named, non-derived line the live name must carry the
 * run prefix. A 5xx detail read of a full-list type is decided by the list.
 */
export async function assertOwnLive(api: APIRequestContext, type: string, ref: { uuid: string; name?: string }, helper: string, opts: LiveOptions = {}): Promise<LiveOwnership> {
    const runId = opts.runId ?? currentRunId(opts.env);
    const tier = opts.tier === null ? undefined : (opts.tier ?? tierIdentity(opts.env));
    const { tier: _ignored, onKnownBug, ...ledgerOpts } = opts;
    const line = assertOwn(ref, helper, { ...ledgerOpts, runId, ...(tier ? { tier } : {}) });
    if (line.type !== type) throw new OwnObjectViolation(helper, ref, `the ledger records it as ${line.type}`, type);
    const reader = Object.hasOwn(LIVE_READS, type) ? LIVE_READS[type] : undefined;
    if (!reader) {
        if (isIdNamed(type)) return { line };
        throw new OwnObjectViolation(helper, ref, `unknown ledger type "${type}" (neither a live-read type nor id-named)`, type);
    }
    const url = await reader.url(api, ref.uuid, line);
    if (!url) throw new LiveObjectMissing(type, ref.uuid, 'not in its list');
    const res = await api.get(url);
    if (res.status() === 404) throw new LiveObjectMissing(type, ref.uuid, 'GET answered 404');
    let body: JsonObject;
    let via: LiveOwnership['via'] = 'detail';
    const list = fullListOf(type);
    if (res.status() >= 500 && list) {
        // core#2511: the detail answers 5xx for an unknown role or user; only the full list decides.
        const row = await fullListRow(api, type, ref.uuid);
        const note = { bug: list.bug, type, uuid: ref.uuid, note: `detail answered ${res.status()}; ${row ? 'read from' : 'absent from'} ${list.listUrl}` };
        (onKnownBug ?? warnKnownBug)(note);
        if (!row) throw new LiveObjectMissing(type, ref.uuid, `GET answered ${res.status()} (known bug ${list.bug}) and ${list.listUrl} does not list it`);
        body = row;
        via = 'list';
    } else {
        if (!res.ok()) throw new Error(`${helper}: GET ${type} ${ref.uuid} answered ${res.status()}`);
        body = (await res.json()) as JsonObject;
    }
    if (!line.derived) {
        const live = reader.name(body);
        if (typeof live !== 'string' || !carriesRunPrefix(live, runId, type, opts.env)) {
            throw new OwnObjectViolation(helper, ref, `its live name does not start with ${runId}- (or ${runId}.${type === 'users' ? '; or REG_RESTRICTED_USERNAME' : ''})`, type);
        }
    }
    return { line, body, url, via };
}

export function mayDeleteOwn(env: NodeJS.ProcessEnv = process.env): boolean {
    return parseFlag(settings(env).deleteOwn, 'API_DELETE_OWN', true);
}

export function derivedDeletable(line: Pick<LedgerLine, 'derived' | 'createdAfter'>, creationTime: string | Date | undefined): boolean {
    if (!line.derived) return true;
    if (!line.createdAfter || !creationTime) return false;
    const created = new Date(creationTime).getTime();
    const after = new Date(line.createdAfter).getTime();
    if (Number.isNaN(created) || Number.isNaN(after)) return false;
    return created >= after;
}
