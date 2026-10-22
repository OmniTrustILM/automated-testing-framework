/**
 * runState — the run's identity and its shared state file.
 *
 * WHAT: two things every helper needs.
 * - runId() / runName: every object the suite creates is named `<run id>-<suffix>`. The run id is [a-z0-9-] and
 *   suffixes are too (names valid in ACME directory URLs and DNS labels), except where a test needs another character on
 *   purpose (REG-CFG-05.2 names an own RA profile `<run id>-ra space-<stamp>` to prove the activation refusal); ownership
 *   rests on the `<run id>-` prefix, never on the suffix's alphabet. The configs set REG_RUN_ID (`run/prepareRun.ts`)
 *   before this module loads.
 * - Run state (<REG_STATE_DIR>/<run id>.json, outside the clone): the run objects (authority, RA profile, ACME profile,
 *   role, token chain, …) that the `run-setup` project creates once through the API; the specs read them through the
 *   `ensureRun…` helpers, so a full run builds one chain instead of one per spec. A spec run on its own (or with
 *   `--no-deps`) finds no state and its `ensureRun…` call creates the missing object lazily and writes it. The UI specs
 *   never promote what they create: they keep their own objects. The file is written atomically (temp file + rename);
 *   a corrupt file is reported, not silently replaced.
 * - The name builders (`ownName`, `runName`) and the length guards of a name used as a certificate common name
 *   (`checkedCommonName`, at most 64 characters) or as a DNS name (`checkedDnsName`, labels of at most 63, at most 253 in all).
 * WHY: ownership rests on the run prefix of every name, so the id must be one value for the whole run; a name that a CA
 *      refuses for its length would fail a test for a reason that is not the behaviour under test, so the builders refuse
 *      it first and name the limit.
 * HOW: the id is read once when the module is first imported; names are built only through the builders here; the state
 *      file is JSON in a directory outside the clone, written to a temporary file and renamed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../Logger';
import { currentRunId, regressionStateDir } from '../run/runId';
import { uniqueSuffix } from '../text';
import { tierIdentity } from '../tier/kind';
import type { CreateOnlyRef, KeyRef, OwnRef } from './ledger';

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

/**
 * The only builder of the name of a NEW object: run prefix, the caller's suffix and a unique suffix (`uniqueSuffix`:
 * `--repeat-each` safe, [a-z0-9] only), so two creates never collide and the ownership prefix test holds.
 */
export const ownName = (suffix: string): string => runName(`${suffix}-${uniqueSuffix()}`);

/** The longest certificate common name (RFC 5280 upper bound) and the longest DNS label (RFC 1035). */
export const MAX_COMMON_NAME_LENGTH = 64;
export const MAX_DNS_LABEL_LENGTH = 63;
/** The longest DNS name in its text form (RFC 1035). */
export const MAX_DNS_NAME_LENGTH = 253;

/** The name itself, or a throw naming the limit it breaks: a common name of at most 64 characters, each DNS label of at most 63. */
export function checkedCommonName(name: string): string {
    const long = name.split('.').find((label) => label.length > MAX_DNS_LABEL_LENGTH);
    if (long !== undefined) throw new Error(`DNS label is ${long.length} characters, the limit is ${MAX_DNS_LABEL_LENGTH}: shorten the suffix (${long})`);
    if (name.length > MAX_COMMON_NAME_LENGTH) throw new Error(`common name is ${name.length} characters, the limit is ${MAX_COMMON_NAME_LENGTH}: shorten the suffix (${name})`);
    return name;
}

/**
 * The name itself, or a throw naming the limit it breaks: a DNS name (a subject alternative name, an ACME identifier, the
 * host of a URL) of at most 253 characters with each label of at most 63. Unlike a common name it has no 64-character cap.
 */
export function checkedDnsName(name: string): string {
    const long = name.split('.').find((label) => label.length > MAX_DNS_LABEL_LENGTH);
    if (long !== undefined) throw new Error(`DNS label is ${long.length} characters, the limit is ${MAX_DNS_LABEL_LENGTH}: shorten the suffix (${long})`);
    if (name.length > MAX_DNS_NAME_LENGTH) throw new Error(`DNS name is ${name.length} characters, the limit is ${MAX_DNS_NAME_LENGTH}: shorten the suffix (${name})`);
    return name;
}

/** A run-unique name for use as a certificate common name or DNS name: `<own name>.<domain>`, checked against both limits. */
export const ownCommonName = (suffix: string, domain = 'example.test'): string => checkedCommonName(`${ownName(suffix)}.${domain}`);

/** The same for a name that is fixed per run (no unique part): `<run name>.<domain>`. */
export const runCommonName = (suffix: string, domain = 'example.test'): string => checkedCommonName(`${runName(suffix)}.${domain}`);

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
    authority?: OwnRef | CreateOnlyRef;
    raProfile?: (OwnRef | CreateOnlyRef) & { authorityUuid: string };
    acmeProfile?: OwnRef & { identifier: string };
    acmeActivatedOn?: string; // RA profile uuid the run's ACME profile was activated on
    role?: OwnRef;
    approvalProfile?: OwnRef;
    token?: OwnRef;
    tokenProfile?: OwnRef;
    key?: KeyRef;
    keyCertificate?: OwnRef;
    /** The protocol CA's own chain (utils/regression/protocols/protocolCa.ts): its token, token profile and key stay apart from the key specs' chain above. */
    protocolCaToken?: OwnRef;
    protocolCaTokenProfile?: OwnRef;
    protocolCaKey?: KeyRef;
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
    /** Manifest of the inventory seeds (the certificate seed and the two small seeds), written by inventorySeed. */
    inventorySeed?: Record<string, unknown>;
    /** GET /v1/info, cached once it was READ (coreBuild.ts never caches a failed read). */
    buildInfo?: BuildInfo;
}

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
