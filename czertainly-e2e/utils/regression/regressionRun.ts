/**
 * regressionRun — run identity, shared run state and the created-objects ledger for the REG-* and API-* suites.
 *
 * - RUN_ID / regName: every object the suite creates is named `<RUN_ID>-<suffix>`. The run id is [a-z0-9-] and
 *   suffixes are too (names valid in ACME directory URLs and DNS labels), except where a test needs another character on
 *   purpose (REG-CFG-05.2 names an own RA profile `<RUN_ID>-ra space-<stamp>` to prove the activation refusal); ownership
 *   rests on the `<RUN_ID>-` prefix, never on the suffix's alphabet. The configs set REG_RUN_ID (`runEnv.ts`) before
 *   this module loads.
 * - Run state (<REG_STATE_DIR>/<RUN_ID>.json, outside the clone): the CFG specs write what they created through the UI, and the
 *   USE specs read it, so a full run builds one chain (credential → authority → RA profile → ACME …) instead of
 *   one per spec. A spec run on its own finds no state and creates its prerequisites through the API. The file is
 *   written atomically (temp file + rename); a corrupt file is reported, not silently replaced.
 * - Ledger (<REG_STATE_DIR>/created-objects.jsonl): one `created` line per object the run made, written right after the
 *   create call and before any assertion, and one `deleted` line when the run-end teardown removed it. The ledger is
 *   the only proof of ownership (`ownObjects.ts`): a helper that changes or deletes an object needs its `created` line
 *   of this run. Every line carries `tier`, a hash of BASE_URL's host (review R15): the teardown refuses lines recorded
 *   on another tier. Objects the platform made on the run's behalf (a `certKey_<CN>` key, a certificate a discovery
 *   onboarded as new) are `derived` lines with `createdAfter`, taken from the SERVER's clock (`createdAfterFrom`: the
 *   Date header of the create response, or a server timestamp, minus a margin; review R17); they are deleted only when
 *   the platform's creation time is not earlier.
 * - Ref kinds (review R7c): `recordCreated` returns an `OwnRef`; the RA profile / authority of REG_RA_PROFILE_NAME (local
 *   stack) are `IssueOnlyRef`s. Mutation helpers accept only `OwnRef` (a compile-time aid; the runtime guard
 *   `assertOwnLive` decides).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../Logger';
import { currentRunId, regressionStateDir } from './runId';
import { tierIdentity } from './tier';

const logger = new Logger('RegressionRun');

export const RUN_ID = currentRunId();

export const regName = (suffix: string): string => `${RUN_ID}-${suffix}`;

// Run state and ledger never live inside the repository clone: REG_STATE_DIR, else ~/.ilm-qa/regression-state.
const stateDir = (): string => regressionStateDir();
const statePath = (): string => path.join(stateDir(), `${RUN_ID}.json`);

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
export interface IssueOnlyRef extends Ref {
    kind: 'issue-only';
}

export const isIssueOnly = (ref: Ref | OwnRef | IssueOnlyRef): ref is IssueOnlyRef => (ref as IssueOnlyRef).kind === 'issue-only';
export const issueOnly = (ref: Ref): IssueOnlyRef => ({ uuid: ref.uuid, name: ref.name, kind: 'issue-only' });

export interface KeyRef extends OwnRef {
    keyItems?: { privateUuid?: string; publicUuid?: string };
}

export interface BuildInfo {
    version?: string;
    branch?: string;
    commitId?: string;
    /** false when /v1/info could not be read or carried no branch: the run treats the build as baseline. */
    markerReadable: boolean;
}

export interface RunState {
    runId: string;
    /** Tier identity (hash of BASE_URL's host) the state was written on. */
    tier?: string;
    credential?: OwnRef;
    authority?: OwnRef | IssueOnlyRef;
    raProfile?: (OwnRef | IssueOnlyRef) & { authorityUuid: string };
    acmeProfile?: OwnRef & { identifier: string };
    acmeActivatedOn?: string; // RA profile uuid the run's ACME profile was activated on
    group?: OwnRef;
    role?: OwnRef;
    user?: OwnRef;
    approvalProfile?: OwnRef;
    token?: OwnRef;
    tokenProfile?: OwnRef;
    key?: KeyRef;
    keyCertificate?: OwnRef;
    caCertificate?: OwnRef;
    scepProfile?: OwnRef;
    cmpProfile?: OwnRef;
    acmeVariants?: OwnRef[];
    trigger?: OwnRef;
    rule?: OwnRef;
    condition?: OwnRef;
    action?: OwnRef;
    execution?: OwnRef;
    notificationInstance?: OwnRef;
    notificationProfile?: OwnRef;
    discovery?: OwnRef;
    scheduledJob?: OwnRef;
    entity?: OwnRef;
    location?: OwnRef;
    vaultInstance?: OwnRef;
    vaultProfile?: OwnRef;
    secret?: OwnRef;
    complianceProfile?: OwnRef;
    stubConnector?: OwnRef;
    restrictedUser?: OwnRef;
    /** Manifest of the inventory seeds (SEED-A / B / C), written by inventorySeed (B1+). */
    inventorySeed?: Record<string, unknown>;
    /** GET /v1/info, cached once it was READ (build.ts never caches a failed read). */
    buildInfo?: BuildInfo;
}

/** RunState keys whose value is a single Ref (what nameFor can name). */
export type RefKind = { [K in keyof RunState]-?: NonNullable<RunState[K]> extends Ref ? K : never }[keyof RunState];

export function readState(): RunState {
    let text: string;
    try {
        text = fs.readFileSync(statePath(), 'utf8');
    } catch {
        return { runId: RUN_ID }; // no state yet
    }
    try {
        return JSON.parse(text) as RunState;
    } catch {
        logger.warn(`run state ${path.basename(statePath())} is corrupt (unreadable JSON); continuing with an empty state, ` +
            'the ledger still holds every object of the run');
        return { runId: RUN_ID };
    }
}

/** Merge a patch into the run state; written to a temp file and renamed, so a reader never sees half a file. */
export function updateState(patch: Partial<RunState>): RunState {
    fs.mkdirSync(stateDir(), { recursive: true });
    const next: RunState = { ...readState(), ...patch, runId: RUN_ID, tier: tierIdentity() };
    const tmp = `${statePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, statePath());
    return next;
}

/**
 * Name for a new object of a kind: the run's canonical name while the run has none of that kind yet (so the
 * object becomes the run's and the later flows use it), otherwise a unique variant (re-runs with the same
 * REG_RUN_ID never collide on names).
 */
export function nameFor(kind: RefKind, suffix: string): { name: string; becomesRunObject: boolean } {
    return readState()[kind] ? { name: regName(`${suffix}-${Date.now().toString(36)}`), becomesRunObject: false } : { name: regName(suffix), becomesRunObject: true };
}

// ---------------------------------------------------------------- server time (R17)

/** Safety margin below a server timestamp: the Date header has one-second resolution and the platform may stamp an
 * object while it still processes the request. */
export const CREATED_AFTER_MARGIN_MS = 2_000;

/** The server's clock from a response's `Date` header (Playwright lower-cases header names), or undefined. */
export function serverDateOf(headers: Record<string, string> | undefined): Date | undefined {
    const raw = headers?.date ?? headers?.Date;
    const t = raw ? Date.parse(raw) : NaN;
    return Number.isNaN(t) ? undefined : new Date(t);
}

/**
 * `createdAfter` for a derived object: a SERVER timestamp (the Date header of the create response, or a server-side
 * time such as a discovery's startTime) minus the margin and the request's own duration. Never the runner's clock,
 * which may be skewed against the server.
 */
export function createdAfterFrom(serverTime: Date | string, requestMs = 0, marginMs = CREATED_AFTER_MARGIN_MS): string {
    const t = typeof serverTime === 'string' ? Date.parse(serverTime) : serverTime.getTime();
    if (Number.isNaN(t)) throw new Error(`createdAfterFrom: "${String(serverTime)}" is not a timestamp`);
    return new Date(t - marginMs - Math.max(0, requestMs)).toISOString();
}

// ---------------------------------------------------------------- ledger

export type LedgerEvent = 'created' | 'deleted';

/**
 * One ledger line. `type` is the API resource (certificates, raProfiles, acmeProfiles, roles, …: the same names the
 * non-interference snapshot uses). `parents` holds what a later operation on the object needs (e.g. `authority` and
 * `raProfile` of a certificate, `authority` of an RA profile, `raProfiles` an ACME profile was activated on).
 * `serverAt` is the server's Date header of the create response, when the creator had it (R17).
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
    /** Tier identity (tier.ts `tierIdentity`); lines without it were written before review R15. */
    tier?: string;
    event: LedgerEvent;
}

// ---------------------------------------------------------------- ledger shapes (fix pass 5)

const CANONICAL_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** A Kubernetes object's ledger id: `<namespace>/<name>` (DNS-1123 label / subdomain, lower case). */
const K8S_ID = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?\/[a-z0-9]([-.a-z0-9]*[a-z0-9])?$/;

/**
 * Why a ledger line's `uuid` has the wrong shape for its type, or undefined (fix pass 5): a canonical uuid (8-4-4-4-12
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

function assertLedgerShape(where: string, type: string, uuid: unknown, parents?: unknown): void {
    const problem = ledgerUuidProblem(type, uuid) ?? parentsProblem(parents);
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
    /** The create response's server Date (R17), for objects whose derived children need a createdAfter. */
    serverAt?: Date | string;
}

/** Append a created object to the ledger (type is the API resource, e.g. raProfiles); returns it as an OwnRef. */
export function recordCreated(type: string, ref: Ref, spec: string, note?: string, parents?: LedgerLine['parents'], opts: RecordOptions = {}): OwnRef {
    assertLedgerShape('recordCreated', type, ref.uuid, parents);
    appendLine({
        at: new Date().toISOString(),
        runId: RUN_ID,
        type,
        name: ref.name,
        uuid: ref.uuid,
        spec,
        ...(note ? { note } : {}),
        ...(parents ? { parents } : {}),
        ...(opts.serverAt ? { serverAt: typeof opts.serverAt === 'string' ? opts.serverAt : opts.serverAt.toISOString() } : {}),
        ...tierField(),
        event: 'created',
    });
    logger.info(`created ${type} ${ref.name} (${ref.uuid}) — recorded in the ledger`);
    return { uuid: ref.uuid, name: ref.name, kind: 'own' };
}

/**
 * An object the platform created for the run (certKey_<CN>, a certificate a discovery onboarded as new). It is owned
 * only together with `createdAfter` (from `createdAfterFrom`, server clock): the teardown deletes it only when its
 * creation time is not earlier.
 */
export function recordDerived(type: string, ref: Ref, spec: string, createdAfter: Date | string, note?: string, parents?: LedgerLine['parents'], runId: string = RUN_ID): void {
    assertLedgerShape('recordDerived', type, ref.uuid, parents);
    appendLine({
        at: new Date().toISOString(),
        runId,
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
    assertLedgerShape('recordDeleted', type, ref.uuid);
    appendLine({ at: new Date().toISOString(), runId: RUN_ID, type, name: ref.name, uuid: ref.uuid, spec, ...(note ? { note } : {}), ...tierField(), event: 'deleted' });
    logger.info(`deleted ${type} (${ref.uuid}) — recorded in the ledger`);
}

/**
 * The run-id prefix a skipped line is reported under (B0 micro-pass): the QA tool family of its run id (`qa-man`,
 * `qa-neg`, `qa-reg`, `qa-rev3` …). Anything else — a uuid-shaped or free-form run id — is `(other)`, so the warning
 * never prints the id, uuid, name or run id of a line.
 */
function runIdPrefix(o: { runId?: unknown; run?: unknown } | undefined): string {
    const id = o?.runId ?? o?.run;
    if (typeof id !== 'string' || !id) return '(no run id)';
    const prefix = id.split('-').slice(0, 2).join('-');
    return /^qa-[a-z]{1,8}\d?$/.test(prefix) ? prefix : '(other)';
}

/**
 * Parse ledger text. Lines written before the event field existed count as `created`; lines written by the
 * qa-api-coverage template carry `run` instead of `runId`. Unreadable lines are skipped, and so are lines whose id or
 * parents have the wrong shape (fix pass 5: `ledgerUuidProblem`, `parentsProblem`) — such a line proves nothing.
 */
export function parseLedger(text: string): LedgerLine[] {
    const lines: LedgerLine[] = [];
    // Skipped lines are counted and reported ONCE per read (B0 micro-pass: one warning per skipped line flooded run 4
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
        if (typeof o.type !== 'string' || ledgerUuidProblem(o.type, o.uuid) || parentsProblem(o.parents)) {
            wrongShape++;
            prefixes.add(runIdPrefix(o));
            continue;
        }
        lines.push({ ...o, runId: o.runId ?? o.run ?? '', name: o.name ?? '', spec: o.spec ?? '', at: o.at ?? '', event: o.event ?? 'created' } as LedgerLine);
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
