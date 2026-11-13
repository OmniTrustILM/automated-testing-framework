/**
 * runState — the run's identity and its shared state file.
 * Every object is named `<run id>-<suffix>` and ownership rests on that prefix, so the run id is read once on first import.
 * The state file (<REG_STATE_DIR>/<run id>.json, outside the clone) is written atomically; a corrupt file is reported, not replaced.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../Logger';
import { currentRunId, regressionStateDir } from '../run/runId';
import { uniqueSuffix } from '../text';
import { tierIdentity } from '../tier/kind';
import type { CreateOnlyRef, KeyRef, OwnRef } from './ledger';

const logger = new Logger('RunState');

/** The id of this run, read once on first import; one id per run is a safety property.
 * The configs call prepareRun before this module is first imported; workers inherit the id. */
const RUN_ID = currentRunId();

export function runId(): string {
    return RUN_ID;
}

export const runName = (suffix: string): string => `${RUN_ID}-${suffix}`;

/** The only builder of the name of a NEW object: run prefix, the caller's suffix and a unique suffix (`--repeat-each` safe). */
export const ownName = (suffix: string): string => runName(`${suffix}-${uniqueSuffix()}`);

export const MAX_COMMON_NAME_LENGTH = 64;
export const MAX_DNS_LABEL_LENGTH = 63;
export const MAX_DNS_NAME_LENGTH = 253;

export function checkedCommonName(name: string): string {
    const long = name.split('.').find((label) => label.length > MAX_DNS_LABEL_LENGTH);
    if (long !== undefined) throw new Error(`DNS label is ${long.length} characters, the limit is ${MAX_DNS_LABEL_LENGTH}: shorten the suffix (${long})`);
    if (name.length > MAX_COMMON_NAME_LENGTH) throw new Error(`common name is ${name.length} characters, the limit is ${MAX_COMMON_NAME_LENGTH}: shorten the suffix (${name})`);
    return name;
}

/** The name itself, or a throw naming the limit it breaks: at most 253 characters, each label at most 63 (no 64-character cap). */
export function checkedDnsName(name: string): string {
    const long = name.split('.').find((label) => label.length > MAX_DNS_LABEL_LENGTH);
    if (long !== undefined) throw new Error(`DNS label is ${long.length} characters, the limit is ${MAX_DNS_LABEL_LENGTH}: shorten the suffix (${long})`);
    if (name.length > MAX_DNS_NAME_LENGTH) throw new Error(`DNS name is ${name.length} characters, the limit is ${MAX_DNS_NAME_LENGTH}: shorten the suffix (${name})`);
    return name;
}

export const ownCommonName = (suffix: string, domain = 'example.test'): string => checkedCommonName(`${ownName(suffix)}.${domain}`);

export const runCommonName = (suffix: string, domain = 'example.test'): string => checkedCommonName(`${runName(suffix)}.${domain}`);

const stateDir = (): string => regressionStateDir();
const statePath = (): string => path.join(stateDir(), `${RUN_ID}.json`);

export interface BuildInfo {
    version?: string;
    branch?: string;
    commitId?: string;
}

export interface RunState {
    runId: string;
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
    /** The protocol CA's own chain; its token, token profile and key stay apart from the key specs' chain. */
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
    inventorySeed?: Record<string, unknown>;
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

export function updateRunState(patch: Partial<RunState>): RunState {
    fs.mkdirSync(stateDir(), { recursive: true });
    const next: RunState = { ...readRunState(), ...patch, runId: RUN_ID, tier: tierIdentity() };
    const tmp = `${statePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, statePath());
    return next;
}
