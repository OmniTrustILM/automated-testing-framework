/**
 * ledger — the created-objects ledger of the REG-* and API-* suites and the references it hands out.
 *
 * - Ledger (<REG_STATE_DIR>/created-objects.jsonl): one `created` line per object the run made, written right after the
 *   create call and before any assertion, and one `deleted` line when the run-end teardown removed it. The ledger is
 *   the only proof of ownership (`ledger/ownership.ts`): a helper that changes or deletes an object needs its `created` line
 *   of this run. Every line carries `tier`, a hash of BASE_URL's host: the teardown refuses lines recorded
 *   on another tier. Objects the platform made on the run's behalf (a `certKey_<CN>` key, a certificate a discovery
 *   onboarded as new) are `derived` lines with `createdAfter`, taken from the SERVER's clock (`createdAfterMarker`: the
 *   Date header of the create response, or a server timestamp, minus a margin); they are deleted only when
 *   the platform's creation time is not earlier.
 * - Ref kinds: `recordCreated` returns an `OwnRef`; the RA profile / authority of REG_RA_PROFILE_NAME (local stack) are `CreateOnlyRef`s.
 *   Mutation helpers accept only `OwnRef` (a compile-time aid; the runtime guard `assertOwnLive` decides).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../Logger';
import { regressionStateDir } from '../run/runId';
import { tierIdentity } from '../tier/kind';
import { runId } from './runState';

const logger = new Logger('Ledger');

/** The created-objects ledger shared by both suites (all runs; lines carry their runId). */
export const ledgerFile = (): string => path.join(regressionStateDir(), 'created-objects.jsonl');

export interface Ref {
    uuid: string;
    name: string;
}

/** An object this run created and recorded (what `recordCreated` returns). Mutation helpers accept only this. */
export interface OwnRef extends Ref {
    kind: 'own';
}

/** An existing object the run may only use as a parent (REG_RA_PROFILE_NAME and its authority, local stack). */
export interface CreateOnlyRef extends Ref {
    kind: 'issue-only';
}

export const isIssueOnly = (ref: Ref | OwnRef | CreateOnlyRef): ref is CreateOnlyRef => (ref as CreateOnlyRef).kind === 'issue-only';
export const issueOnly = (ref: Ref): CreateOnlyRef => ({ uuid: ref.uuid, name: ref.name, kind: 'issue-only' });

export interface KeyRef extends OwnRef {
    keyItems?: { privateUuid?: string; publicUuid?: string };
}

// ---------------------------------------------------------------- server time

/** Safety margin below a server timestamp: the Date header has one-second resolution and the platform may stamp an
 * object while it still processes the request. */
const CREATED_AFTER_MARGIN_MS = 2_000;

/** The server's clock from a response's `Date` header (Playwright lower-cases header names), or undefined. */
export function serverDate(headers: Record<string, string> | undefined): Date | undefined {
    const raw = headers?.date ?? headers?.Date;
    const t = raw ? Date.parse(raw) : NaN;
    return Number.isNaN(t) ? undefined : new Date(t);
}

/**
 * `createdAfter` for a derived object: a SERVER timestamp (the Date header of the create response, or a server-side
 * time such as a discovery's startTime) minus the margin and the request's own duration. Never the runner's clock,
 * which may be skewed against the server.
 */
export function createdAfterMarker(serverTime: Date | string, requestMs = 0, marginMs = CREATED_AFTER_MARGIN_MS): string {
    const t = typeof serverTime === 'string' ? Date.parse(serverTime) : serverTime.getTime();
    if (Number.isNaN(t)) throw new Error(`createdAfterMarker: "${String(serverTime)}" is not a timestamp`);
    return new Date(t - marginMs - Math.max(0, requestMs)).toISOString();
}

/** How far ahead of the runner's clock `keepingBound` lies: more than any clock skew between a runner and a server. */
export const KEEPING_BOUND_AHEAD_MS = 24 * 3600 * 1000;

/**
 * The `createdAfter` of a derived object whose server time is unknown: a day ahead of the runner's clock, so the object
 * (made before now, on whatever clock) is never created at or after it and the teardown keeps it.
 */
export const keepingBound = (now: number = Date.now()): string => new Date(now + KEEPING_BOUND_AHEAD_MS).toISOString();

// ---------------------------------------------------------------- ledger

export type LedgerEvent = 'created' | 'deleted';

/**
 * One ledger line. `type` is the API resource (certificates, raProfiles, acmeProfiles, roles, …: the same names the
 * non-interference snapshot uses). `parents` holds what a later operation on the object needs (e.g. `authority` and
 * `raProfile` of a certificate, `authority` of an RA profile, `raProfiles` an ACME profile was activated on).
 * `serverAt` is the server's Date header of the create response, when the creator had it.
 */
export interface LedgerLine {
    at: string;
    runId: string;
    type: string;
    name: string;
    uuid: string;
    spec: string;
    note?: string;
    parents?: Record<string, string | string[]>;
    derived?: boolean;
    createdAfter?: string;
    serverAt?: string;
    /** Tier identity (tier/kind.ts `tierIdentity`); lines without it were written before the field existed. */
    tier?: string;
    /**
     * The platform's own key of an object it does not key by a uuid: `oidEntries` — the OID. The line's `uuid`
     * is then `oidEntryLedgerUuid(key)` (ledgerKeyProblem), so ownership and `deleted` lines work by uuid as for any type.
     */
    key?: string;
    event: LedgerEvent;
    /**
     * Set by parseLedger when the line carried no `event` (lines of other QA tools, written before the field existed):
     * `event` is then the default `created`, and non-interference reads such a line by its note (teardown/nonInterference.ts
     * `foreignEventOf`). Never written.
     */
    eventImplied?: true;
}

// ---------------------------------------------------------------- ledger shapes

const CANONICAL_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** A Kubernetes object's ledger id: `<namespace>/<name>` (DNS-1123 label / subdomain, lower case). */
const K8S_ID = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?\/[a-z0-9]([-.a-z0-9]*[a-z0-9])?$/;

/**
 * Why a ledger line's `uuid` has the wrong shape for its type, or undefined: a canonical uuid (8-4-4-4-12
 * hex) for every ILM type, `<namespace>/<name>` for a `k8s:<kind>` line. The ledger is the proof of ownership; an id
 * that is padded, lenient, base64 or carries a path (`x/../settings`) never enters it, and is never read from it.
 */
export function ledgerUuidProblem(type: string, uuid: unknown): string | undefined {
    if (typeof uuid !== 'string') return 'the id is not a string';
    if (typeof type === 'string' && type.startsWith('k8s:')) return K8S_ID.test(uuid) ? undefined : 'a k8s ledger id must be <namespace>/<name>';
    return CANONICAL_UUID.test(uuid) ? undefined : 'the id is not a canonical uuid';
}

/** Why a line's `parents` have the wrong shape, or undefined: each value a canonical uuid or a list of them. */
export function parentsProblem(parents: unknown): string | undefined {
    if (parents === undefined) return undefined;
    if (!parents || typeof parents !== 'object' || Array.isArray(parents)) return 'parents must be an object';
    for (const v of Object.values(parents)) {
        const list = Array.isArray(v) ? v : [v];
        if (!list.length || !list.every((x) => typeof x === 'string' && CANONICAL_UUID.test(x))) return 'every parent must be a canonical uuid (or a list of them)';
    }
    return undefined;
}

/**
 * An OID (`CustomOidEntry` is keyed by its OID string, core dao/entity/oid/CustomOidEntry.java:21-23): dotted decimal arcs,
 * first arc 0-2, no leading zeros, at most 64 arcs of at most 20 digits. Nothing else can reach a path segment.
 */
const OID_PATTERN = /^[0-2](?:\.(?:0|[1-9][0-9]{0,19})){1,63}$/;

/** The ledger uuid of an OID entry: a canonical uuid derived from the OID (sha-256, version 8 layout). */
export function oidEntryLedgerUuid(oid: string): string {
    const h = crypto.createHash('sha256').update(`oidEntries:${oid}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Why a line's `key` is wrong for its type, or undefined. An `oidEntries` line that records a creation must
 * carry its OID (OID_PATTERN) and the uuid derived from it; on any line, a `key` that is present must be a string, and on
 * an `oidEntries` line it must match the uuid. Other types carry no key of their own and ignore none: a key there is wrong.
 */
export function ledgerKeyProblem(type: string, uuid: unknown, key: unknown, event: unknown = 'created'): string | undefined {
    if (type !== 'oidEntries') return key === undefined ? undefined : 'only an oidEntries line carries a key';
    if (key === undefined) return event === 'deleted' ? undefined : 'an oidEntries line must carry its OID as key';
    if (typeof key !== 'string' || !OID_PATTERN.test(key)) return 'the key of an oidEntries line is not an OID';
    return uuid === oidEntryLedgerUuid(key) ? undefined : 'the uuid of an oidEntries line is not the one derived from its OID';
}

function assertLedgerShape(where: string, type: string, uuid: unknown, parents?: unknown, key?: unknown, event: LedgerEvent = 'created'): void {
    const problem = ledgerUuidProblem(type, uuid) ?? parentsProblem(parents) ?? ledgerKeyProblem(type, uuid, key, event);
    if (problem) throw new Error(`${where}(${type}): ${problem}; nothing was recorded`);
}

function appendLine(line: LedgerLine): void {
    fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
    fs.appendFileSync(ledgerFile(), `${JSON.stringify(line)}\n`);
}

const tierField = (): { tier?: string } => {
    const t = tierIdentity();
    return t ? { tier: t } : {};
};

export interface RecordOptions {
    /** The spec (or the run step) that created the object: the `spec` of the ledger line. */
    spec: string;
    /** Why the object exists (a short note on the line). */
    note?: string;
    /** The objects a later change or delete needs (`raProfile`, `authority`, `token`, ...). */
    parents?: LedgerLine['parents'];
    /** The create response's server Date, for objects whose derived children need a createdAfter. */
    serverAt?: Date | string;
    /** The platform's own key (`oidEntries`: the OID; the uuid must be `oidEntryLedgerUuid(key)`). */
    key?: string;
}

/** Append a created object to the ledger (type is the API resource, e.g. raProfiles); returns it as an OwnRef. */
export function recordCreated(type: string, ref: Ref, opts: RecordOptions): OwnRef {
    const { spec, note, parents } = opts;
    assertLedgerShape('recordCreated', type, ref.uuid, parents, opts.key);
    appendLine({
        at: new Date().toISOString(),
        runId: runId(),
        type,
        name: ref.name,
        uuid: ref.uuid,
        spec,
        ...(note ? { note } : {}),
        ...(parents ? { parents } : {}),
        ...(opts.serverAt ? { serverAt: typeof opts.serverAt === 'string' ? opts.serverAt : opts.serverAt.toISOString() } : {}),
        ...(opts.key !== undefined ? { key: opts.key } : {}),
        ...tierField(),
        event: 'created',
    });
    logger.info(`created ${type} ${ref.name} (${ref.uuid}) — recorded in the ledger`);
    return { uuid: ref.uuid, name: ref.name, kind: 'own' };
}

/**
 * An object the platform created for the run (certKey_<CN>, a certificate a discovery onboarded as new). It is owned
 * only together with `createdAfter` (from `createdAfterMarker`, server clock): the teardown deletes it only when its
 * creation time is not earlier.
 */
export interface DerivedOptions {
    spec: string;
    /** The server-clock bound from `createdAfterMarker`: the teardown deletes the object only when it was created at or after it. */
    createdAfter: Date | string;
    note?: string;
    parents?: LedgerLine['parents'];
    /** The run the line belongs to (default: this run). */
    runId?: string;
}

export function recordDerived(type: string, ref: Ref, opts: DerivedOptions): void {
    const { spec, createdAfter, note, parents } = opts;
    const ofRun = opts.runId ?? runId();
    assertLedgerShape('recordDerived', type, ref.uuid, parents);
    appendLine({
        at: new Date().toISOString(),
        runId: ofRun,
        type,
        name: ref.name,
        uuid: ref.uuid,
        spec,
        ...(note ? { note } : {}),
        ...(parents ? { parents } : {}),
        derived: true,
        createdAfter: typeof createdAfter === 'string' ? createdAfter : createdAfter.toISOString(),
        ...tierField(),
        event: 'created',
    });
    logger.info(`derived ${type} (${ref.uuid}) — recorded in the ledger`);
}

/**
 * Mark a ledger object as gone: the teardown, a spec that deleted its own object as the behaviour under test, or the
 * `afterAll` of a spec that removed its `k8s:<kind>` objects (the teardown never deletes those; a `k8s:` line without
 * its `deleted` line is reported as a leftover).
 */
export function recordDeleted(type: string, ref: Ref, spec: string, note?: string): void {
    assertLedgerShape('recordDeleted', type, ref.uuid, undefined, undefined, 'deleted');
    appendLine({ at: new Date().toISOString(), runId: runId(), type, name: ref.name, uuid: ref.uuid, spec, ...(note ? { note } : {}), ...tierField(), event: 'deleted' });
    logger.info(`deleted ${type} (${ref.uuid}) — recorded in the ledger`);
}

/**
 * The run-id prefix a skipped line is reported under: the QA tool family of its run id (`qa-man`,
 * `qa-neg`, `qa-reg`, `qa-api` …). Anything else — a uuid-shaped or free-form run id — is `(other)`, so the warning
 * never prints the id, uuid, name or run id of a line.
 */
export function runIdPrefix(o: { runId?: unknown; run?: unknown } | undefined): string {
    const id = o?.runId ?? o?.run;
    if (typeof id !== 'string' || !id) return '(no run id)';
    const prefix = id.split('-').slice(0, 2).join('-');
    return /^qa-[a-z]{1,8}\d?$/.test(prefix) ? prefix : '(other)';
}

/**
 * Parse ledger text. Lines written before the event field existed count as `created`; lines written by the
 * API test template carry `run` instead of `runId`. Unreadable lines are skipped, and so are lines whose id or
 * parents have the wrong shape (`ledgerUuidProblem`, `parentsProblem`) — such a line proves nothing.
 */
export function parseLedger(text: string): LedgerLine[] {
    const lines: LedgerLine[] = [];
    // Skipped lines are counted and reported ONCE per read (one warning per skipped line once flooded a run
    // with 220 lines for 16 lines written by other QA tools); the skip itself (fail-closed) is unchanged.
    let wrongShape = 0;
    let unreadable = 0;
    const prefixes = new Set<string>();
    for (const raw of text.split('\n')) {
        if (!raw.trim()) continue;
        let o: (Partial<LedgerLine> & { run?: string }) | undefined;
        try {
            o = JSON.parse(raw) as Partial<LedgerLine> & { run?: string };
        } catch {
            unreadable++;
            continue;
        }
        if (!o || typeof o !== 'object') {
            unreadable++;
            continue;
        }
        if (!o.uuid || !o.type) continue;
        if (typeof o.type !== 'string' || ledgerUuidProblem(o.type, o.uuid) || parentsProblem(o.parents) || ledgerKeyProblem(o.type, o.uuid, o.key, o.event ?? 'created')) {
            wrongShape++;
            prefixes.add(runIdPrefix(o));
            continue;
        }
        // `eventImplied` is the parser's own mark: a value in the text is never taken over.
        const { eventImplied: _written, ...rest } = o;
        lines.push({
            ...rest, runId: o.runId ?? o.run ?? '', name: o.name ?? '', spec: o.spec ?? '', at: o.at ?? '', event: o.event ?? 'created',
            ...(o.event === undefined ? { eventImplied: true } : {}),
        } as LedgerLine);
    }
    if (wrongShape || unreadable) {
        const parts = [
            ...(wrongShape ? [`${wrongShape} line(s) whose id or parents have the wrong shape (run-id prefixes: ${[...prefixes].sort().join(', ')})`] : []),
            ...(unreadable ? [`${unreadable} unreadable line(s)`] : []),
        ];
        logger.warn(`skipped ${parts.join(' and ')} of the ledger; they prove nothing`);
    }
    return lines;
}

export function readLedger(file: string = ledgerFile()): LedgerLine[] {
    return fs.existsSync(file) ? parseLedger(fs.readFileSync(file, 'utf8')) : [];
}
