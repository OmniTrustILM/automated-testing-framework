/**
 * ownership — the guard that keeps every mutation and delete on objects this run created (own objects only).
 *
 * WHAT: the proof of ownership and the refusals built on it. Ownership is decided in two layers:
 * 1. `assertOwn` (ledger, synchronous): the uuid has a `created` line of THIS run and no later `deleted` line, and the
 *    line's name carries the run prefix (`<run id>-`, or `<run id>.` for a DNS name). Two runs, or a hand-made object
 *    that happens to carry a prefix, can never borrow ownership: the prefix is checked on top, never alone.
 * 2. `assertOwnLive` (asynchronous): assertOwn, then the LIVE object is read and, for a named type, its live
 *    name must carry the run prefix too, so a ledger line that points at the wrong uuid (a copy-paste, a reused id)
 *    cannot reach a foreign object. With a known tier identity the line must have been recorded on the same tier.
 *    It is the last step before every destructive or mutating call: the teardown handlers, the own-object helpers of
 *    apiReads.ts and the guard (guard/createGuard.ts) use it.
 *
 * Named types and the field read (`LIVE_READS`) and id-named types (`ID_NAMED`) are derived from the resource-type
 * registry (resourceTypes.ts: each entry says how its ownership is proven). A named type reads the live object and its
 * `name` (users: `username`, own certificates: `commonName`) must carry the run prefix. An id-named type (the platform names
 * the object by an id, REG-USE-05 records an ACME account as `<run id>-acme-account-<accountId>`) has no live name to check and
 * rests on the ledger line alone, as do `k8s:<kind>` lines. A type that is neither in LIVE_READS nor in ID_NAMED is refused (a
 * typo in a type name must never fall back to ledger-only proof). The name that must carry the run prefix is the LEDGER
 * line's: a name a caller passes in is never consulted.
 *
 * Derived objects (`certKey_<CN>`, certificates a discovery onboarded as new) carry no prefix; they are owned through
 * their `derived` line with `createdAfter` and are deleted only when the platform's creation time is not earlier
 * (`derivedDeletable`) and nobody adopted them (the certificate handler checks owner, groups, locations, RA profile and
 * request first).
 *
 * An RA profile named by REG_RA_PROFILE_NAME (local stack) is an issue-only parent: it has no ledger line, so the guard
 * refuses to activate protocols on it or change it.
 *
 * The dedicated second identity: the ILM user the suite creates for the
 * identity-provider account REG_RESTRICTED_USERNAME carries that fixed name, never the run prefix. For a `users` line
 * ONLY, `carriesRunPrefix` also accepts a name equal to REG_RESTRICTED_USERNAME (trimmed, case-insensitive) — on top
 * of the ledger `created` line of THIS run and tier, like every other name. The value is read from the process
 * environment with an injectable seam (`OwnershipOptions.env`); unset or empty, the second form never matches.
 * Key items: `keyItems` lines are read live under their parent key (`parents.key`); their live `name` is
 * the key's run-prefixed name.
 *
 * Messages carry the type and the uuid only, never the name of a refused object: reports may be shared, and
 * names stay in the local state files.
 *
 * WHY: the suite runs against shared tiers that hold other people's objects. A prefix on a name is not proof (a hand-made
 *      object can carry one), so only a ledger line of this run and tier, written when the object was created, lets a
 *      change or a delete through, and a second read of the live object catches a ledger line that points at the wrong uuid.
 * HOW: `assertOwn` reads the ledger lines; `assertOwnLive` adds the live read and the name check; `checkOwnership` is the
 *      same decision as a value for callers that decide instead of throw; `derivedDeletable` is the age rule of a derived
 *      object, which errs toward keeping when a time is missing or unreadable; `mayDeleteOwn` reads the delete switch.
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
 * Why the guard refused: `ownership` — the object is not this run's (no / deleted ledger line, other
 * tier, no run prefix, foreign live name, ledger type mismatch); `derived` — a derived object outside the teardown;
 * `not-guarded` — a mutating helper got a raw context; `request` — the request itself is not checkable or not allowed
 * (path, origin, body format, platform endpoint, bulk without an explicit list). The live guard proof asserts
 * `ownership` specifically (a refusal for the brand or the path would hide a broken ownership check).
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

/** The live object is not there (404 on its detail URL, or not in its list): a missing route or a missing object. */
export class LiveObjectMissing extends Error {
    constructor(readonly type: string, readonly uuid: string, detail: string) {
        super(`${type} ${uuid}: route or object missing (${detail})`);
        this.name = 'LiveObjectMissing';
    }
}

export interface OwnershipOptions {
    runId?: string;
    /** Ledger lines to judge against (tests); default: the ledger file, read through the cache. */
    lines?: LedgerLine[];
    file?: string;
    /** When set, the created line must carry this tier identity. */
    tier?: string;
    /** The environment REG_RESTRICTED_USERNAME is read from; default: the process's. Unit-test seam. */
    env?: NodeJS.ProcessEnv;
}

/** REG_RESTRICTED_USERNAME, trimmed and lower-cased, or undefined when unset / empty. */
export function restrictedUsername(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return settings(env).restrictedUsername?.toLowerCase();
}

let cache: { file: string; size: number; mtimeMs: number; lines: LedgerLine[] } | undefined;

/** Forget the cached ledger (unit tests that rewrite a ledger file within one mtime tick). */
export function resetLedgerCacheForTests(): void {
    cache = undefined;
}

/** The ledger, re-read only when its size or mtime changed (workers append to it during the run). */
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
    /** The `created` line that proves ownership (present when own). */
    line?: LedgerLine;
}

/**
 * `<run id>-…` (every suite name) or `<run id>.…` (a DNS identifier such as the ACME profile's `<run id>.example.test`).
 * For `type === 'users'` ONLY, also the dedicated identity's fixed name (REG_RESTRICTED_USERNAME, trimmed,
 * case-insensitive; never for roles, groups or any other type, never when the variable is unset or empty).
 */
export function carriesRunPrefix(name: string, runId: string = currentRunId(), type?: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (name.startsWith(`${runId}-`) || name.startsWith(`${runId}.`)) return true;
    if (type !== 'users') return false;
    const ded = restrictedUsername(env);
    return ded !== undefined && name.trim().toLowerCase() === ded;
}

/** Why a ref is or is not this run's object (ledger only). */
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
    // The ledger's own name decides: a caller-supplied ref.name can never rescue a line without the prefix.
    // A `users` line may carry the dedicated identity's name instead (the line of this run is still required).
    if (!carriesRunPrefix(created.name, runId, created.type, opts.env)) {
        return { own: false, reason: `name does not start with ${runId}- (or ${runId}. for a DNS name${created.type === 'users' ? '; or REG_RESTRICTED_USERNAME for a users line' : ''})`, line: created };
    }
    return { own: true, reason: 'created by this run', line: created };
}

export function isOwnObject(ref: { uuid: string; name?: string }, opts: OwnershipOptions = {}): boolean {
    return checkOwnership(ref, opts).own;
}

/** Throws OwnObjectViolation unless the ref is this run's object (ledger); returns its `created` line. */
export function assertOwn(ref: { uuid: string; name?: string }, helper: string, opts: OwnershipOptions = {}): LedgerLine {
    const o = checkOwnership(ref, opts);
    if (!o.own) throw new OwnObjectViolation(helper, ref, o.reason, o.line?.type);
    return o.line!;
}

// ------------------------------------------------------------------ live check

export interface LiveRead {
    /** Detail URL of the object; may read a list first (parent-scoped detail URLs). undefined = not in its list. */
    url: (api: APIRequestContext, uuid: string, line: LedgerLine) => Promise<string | undefined> | string | undefined;
    /** The live name that must carry the run prefix. */
    name: (body: JsonObject) => string | undefined;
}

const parentOf = (line: LedgerLine, key: string): string | undefined => {
    const v = line.parents?.[key];
    return Array.isArray(v) ? v[0] : v;
};

/** A member of a parsed object when it is text. */
const stringField = (body: JsonObject | undefined, field: string): string | undefined => {
    const value = body?.[field];
    return typeof value === 'string' ? value : undefined;
};

const byName = (url: (u: string) => string, field = 'name'): LiveRead => ({ url: (_api, u) => url(u), name: (b) => stringField(b, field) });

/** Parent-scoped detail: the parent from the ledger line, else from a list read (read-only). */
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

/** `{uuid}` / `{parent}` filled into a registry URL template. */
const fillUrl = (template: string, values: { uuid: string; parent?: string }): string =>
    template.replace(/\{(uuid|parent)\}/g, (_match, key: 'uuid' | 'parent') => values[key] ?? '');

/** The live read a registry specification (resourceTypes.ts) describes. */
export function liveReadOf(spec: LiveReadSpec): LiveRead {
    switch (spec.kind) {
        case 'detail':
            return byName((u) => fillUrl(spec.url, { uuid: u }), spec.nameField);
        case 'parent':
            return { url: (_api, u, line) => { const parent = parentOf(line, spec.parent); return parent ? fillUrl(spec.url, { uuid: u, parent }) : undefined; }, name: (b) => stringField(b, 'name') };
        case 'parent-or-list':
            return scoped(spec.parent, spec.listUrl, spec.listParentField, (parent, u) => fillUrl(spec.url, { uuid: u, parent }));
    }
}

/** The live reads of every named type, built from the registry's specifications. */
export const liveReadsOf = (specs: Record<string, LiveReadSpec>): Record<string, LiveRead> =>
    Object.fromEntries(Object.entries(specs).map(([type, spec]) => [type, liveReadOf(spec)]));

/** The live read of every named type (registry entries with a live-read ownership). */
export const LIVE_READS: Record<string, LiveRead> = liveReadsOf(liveReadSpecsOf());

/**
 * Types whose objects have no name of their own (the platform names them by an id): ledger proof only. `k8s:<kind>`
 * lines are id-named too (`isIdNamed`).
 */
export const ID_NAMED: ReadonlySet<string> = idNamedTypesOf();

export const isIdNamed = (type: string): boolean => ID_NAMED.has(type) || type.startsWith('k8s:');

export interface LiveOwnership {
    line: LedgerLine;
    /** The live object (absent for an id-named type, which is not read). */
    body?: JsonObject;
    url?: string;
    /** 'list': the detail answered 5xx (known bug) and the object was read from its authoritative full list. */
    via?: 'detail' | 'list';
}

// ------------------------------------------------------------------ the authoritative full list (known bug core#2511)

/** A known product bug the run worked around (logged, and listed in the run's kept report). */
export interface WorkaroundNote {
    bug: string;
    type: string;
    uuid: string;
    note: string;
}

/**
 * Types whose list endpoint answers EVERY object in one unpaged response, consulted ONLY when a detail read answers
 * 5xx: `GET /v1/roles/{uuid}` and `GET /v1/users/{uuid}` answer 500 instead of
 * 404 for a deleted or unknown uuid (known bug core#2511). Core forwards both lists to the auth service, which answers
 * one page of at most 1000 rows (auth `QueryRequestDto`: PageSize 1000 = its maximum); a list of 1000 rows or more may
 * be truncated and proves nothing. A 5xx alone NEVER counts as "gone"; every other type keeps the 404-only rule.
 */
export const FULL_LIST_TYPES: Readonly<Record<string, { listUrl: string; bug: string; cap: number }>> = {
    roles: { listUrl: '/api/v1/roles', bug: 'core#2511', cap: 1000 },
    users: { listUrl: '/api/v1/users', bug: 'core#2511', cap: 1000 },
};

/** The FULL_LIST_TYPES entry of a type: own properties only (`constructor`, `__proto__` … are not types). */
export function fullListOf(type: string | undefined): { listUrl: string; bug: string; cap: number } | undefined {
    return typeof type === 'string' && Object.hasOwn(FULL_LIST_TYPES, type) ? FULL_LIST_TYPES[type] : undefined;
}

/**
 * The row of `uuid` in the authoritative full list of a FULL_LIST_TYPES type, or undefined when the list does not
 * name it. Throws when the list cannot prove anything (no such list, not readable, not an array, at the cap;
 * an empty list, or a row without a string `uuid`, proves nothing either — a broken answer is not absence).
 */
export async function fullListRow(api: Pick<APIRequestContext, 'get'>, type: string, uuid: string): Promise<JsonObject | undefined> {
    const spec = fullListOf(type);
    if (!spec) throw new Error(`${type} ${uuid}: no authoritative full list (a 5xx detail read is never proof of absence)`);
    const res = await api.get(spec.listUrl);
    if (!res.ok()) throw new Error(`${type} ${uuid}: the authoritative list ${spec.listUrl} answered ${res.status()}`);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) throw new Error(`${type} ${uuid}: ${spec.listUrl} did not answer a list`);
    if (rows.length >= spec.cap) {
        throw new Error(`${type} ${uuid}: ${spec.listUrl} answered ${rows.length} rows (one page holds at most ${spec.cap}); it may be truncated and proves nothing`);
    }
    if (rows.length === 0) throw new Error(`${type} ${uuid}: ${spec.listUrl} answered an empty list; it proves nothing`);
    if (!rows.every((r) => typeof (r as JsonObject | null)?.uuid === 'string')) {
        throw new Error(`${type} ${uuid}: ${spec.listUrl} answered rows without a string uuid; it proves nothing`);
    }
    const wanted = uuid.toLowerCase();
    return (rows as JsonObject[]).find((r) => typeof r?.uuid === 'string' && r.uuid.toLowerCase() === wanted);
}

export interface Absence {
    absent: boolean;
    /** The detail read's status. */
    status: number;
    /** Set when absence was confirmed through the full list after a 5xx detail read. */
    knownBug?: WorkaroundNote;
    /** Why it is not proven absent (status, the list's answer). */
    detail: string;
}

/**
 * One absence check after a delete: the detail answering 404 proves it. A 5xx proves nothing by itself; for a
 * FULL_LIST_TYPES type the authoritative list decides (absent there ⇒ absent, with the known-bug note). Anything
 * else (2xx, other 4xx, a 5xx of another type, an unreadable / capped list) is "not proven absent".
 */
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
    /** Tier identity the line must carry; default tierIdentity(env); null = not checked (no BASE_URL, unit tests). */
    tier?: string | null;
    env?: NodeJS.ProcessEnv;
    /** Called when a known product bug was worked around (default: a console warning). */
    onKnownBug?: (note: WorkaroundNote) => void;
}

const logger = new Logger('OwnObjects');

const warnKnownBug = (n: WorkaroundNote): void => logger.warn(`known bug ${n.bug}: ${n.type} ${n.uuid}: ${n.note}`);

/**
 * assertOwn (ledger, plus the tier identity when BASE_URL is known), then the live object: GET its detail URL
 * (404 → LiveObjectMissing), and for a named, non-derived line the live name must carry the run prefix
 * (→ OwnObjectViolation). Returns the line and the live body. `api` only needs `get` (GET is never guarded).
 * A 5xx detail read of a FULL_LIST_TYPES type (roles, users; known bug core#2511) is decided by the authoritative full
 * list: not listed → LiveObjectMissing; listed → the list row is the live object (its name is checked like the detail's).
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
        // core#2511: the detail answers 5xx for a deleted / unknown role or user. Only the full list decides.
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

/** Own objects are deleted at the end of a run unless API_DELETE_OWN is off (a parsed switch). */
export function mayDeleteOwn(env: NodeJS.ProcessEnv = process.env): boolean {
    return parseFlag(settings(env).deleteOwn, 'API_DELETE_OWN', true);
}

/** A derived object may go only when the platform created it at or after the line's createdAfter. */
export function derivedDeletable(line: Pick<LedgerLine, 'derived' | 'createdAfter'>, creationTime: string | Date | undefined): boolean {
    if (!line.derived) return true;
    if (!line.createdAfter || !creationTime) return false;
    const created = new Date(creationTime).getTime();
    const after = new Date(line.createdAfter).getTime();
    if (Number.isNaN(created) || Number.isNaN(after)) return false;
    return created >= after;
}
