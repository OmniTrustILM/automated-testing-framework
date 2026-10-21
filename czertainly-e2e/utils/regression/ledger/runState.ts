/**
 * runState — the run's identity and its shared state file.
 *
 * - runId() / runName: every object the suite creates is named `<run id>-<suffix>`. The run id is [a-z0-9-] and
 *   suffixes are too (names valid in ACME directory URLs and DNS labels), except where a test needs another character on
 *   purpose (REG-CFG-05.2 names an own RA profile `<run id>-ra space-<stamp>` to prove the activation refusal); ownership
 *   rests on the `<run id>-` prefix, never on the suffix's alphabet. The configs set REG_RUN_ID (`run/prepareRun.ts`)
 *   before this module loads.
 * - Run state (<REG_STATE_DIR>/<run id>.json, outside the clone): the CFG specs write what they created through the UI, and the
 *   USE specs read it, so a full run builds one chain (credential → authority → RA profile → ACME …) instead of
 *   one per spec. A spec run on its own finds no state and creates its prerequisites through the API. The file is
 *   written atomically (temp file + rename); a corrupt file is reported, not silently replaced.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../Logger';
import { currentRunId, regressionStateDir } from '../run/runId';
import { tierIdentity } from '../tier/kind';
import type { CreateOnlyRef, KeyRef, OwnRef, Ref } from './ledger';

const logger = new Logger('RunState');

/**
 * The id of this run, read once when the module is first imported (the configs call `prepareRun` before that, and the
 * workers inherit it). One id per run is a safety property: callers read it through `runId()`.
 */
const RUN_ID = currentRunId();

/** The id of this run (frozen when this module was first imported). */
export function runId(): string {
    return RUN_ID;
}

export const runName = (suffix: string): string => `${RUN_ID}-${suffix}`;

// Run state and ledger never live inside the repository clone: REG_STATE_DIR, else ~/.ilm-qa/regression-state.
const stateDir = (): string => regressionStateDir();
const statePath = (): string => path.join(stateDir(), `${RUN_ID}.json`);

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
    authority?: OwnRef | CreateOnlyRef;
    raProfile?: (OwnRef | CreateOnlyRef) & { authorityUuid: string };
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
    /** Manifest of the inventory seeds (SEED-A / B / C), written by inventorySeed. */
    inventorySeed?: Record<string, unknown>;
    /** GET /v1/info, cached once it was READ (coreBuild.ts never caches a failed read). */
    buildInfo?: BuildInfo;
}

/** RunState keys whose value is a single Ref (what nameFor can name). */
export type RefKind = { [K in keyof RunState]-?: NonNullable<RunState[K]> extends Ref ? K : never }[keyof RunState];

export function readRunState(): RunState {
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
export function updateRunState(patch: Partial<RunState>): RunState {
    fs.mkdirSync(stateDir(), { recursive: true });
    const next: RunState = { ...readRunState(), ...patch, runId: RUN_ID, tier: tierIdentity() };
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
    return readRunState()[kind] ? { name: runName(`${suffix}-${Date.now().toString(36)}`), becomesRunObject: false } : { name: runName(suffix), becomesRunObject: true };
}
