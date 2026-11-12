/**
 * context — what every step of the key onboarding setup shares: the admin transport, the configuration, the waits,
 * the docker runner, the name stamp, and the one way a step records what it created.
 *
 * WHAT: `SETUP_LEDGER_SPEC` (the `spec` of every ledger line the setup writes), `SetupContext`, `recordOwn` (the ledger
 * line of a create, written right after the create answered) and the waits' defaults.
 * WHY: the block teardown selects exactly the lines whose spec starts with `key-onboarding/`; the run-end teardown's
 * live-name check accepts only `<run id>-…` names. The transport, the error kinds, the name stamp and the step wrapper
 * are shared with the timestamping setup (`utils/devBlocks/provision`); `uuidOf` binds this block's logger name.
 * HOW: plain helpers, no requests.
 */
import { uuidOf as sharedUuidOf } from '../../devBlocks/provision/names';
import type { Logger } from '../../Logger';
import { LedgerLine, OwnRef, recordCreated, Ref } from '../../regression/ledger/ledger';
import type { Admin } from '../../devBlocks/provision/transport';
import type { KeyOnboardingConfig } from '../config';
import type { DockerRunner } from './docker';

/** The ledger `spec` of every line the key onboarding setup writes (the block teardown selects `key-onboarding/…`). */
export const SETUP_LEDGER_SPEC = 'key-onboarding/setup';

/** Attempts and pauses of the waits (the unit tests use 0 ms pauses). */
export interface PollSettings {
    /** The PIN secret becoming active and enabled: the source suite waited 15 s, reading every 500 ms. */
    secretAttempts: number;
    secretIntervalMs: number;
}

export const DEFAULT_POLL: PollSettings = { secretAttempts: 30, secretIntervalMs: 500 };

export interface SetupContext {
    admin: Admin;
    cfg: KeyOnboardingConfig;
    env: NodeJS.ProcessEnv;
    poll: PollSettings;
    docker: DockerRunner;
    /** Four base36 characters, the same in every name and label of one setup attempt. */
    stamp: string;
    log: Logger;
}

/**
 * The ledger line of an object the setup created, right after its create answered (before any enable, wait or
 * assertion: a line written after a wait is lost when the wait times out).
 */
export function recordOwn(type: string, ref: Ref, note: string, parents?: LedgerLine['parents'], serverAt?: Date): OwnRef {
    return recordCreated(type, ref, { spec: SETUP_LEDGER_SPEC, note, ...(parents ? { parents } : {}), ...(serverAt ? { serverAt } : {}) });
}

/** The uuid of a create answer, or a TierError (the warning is logged as `KeyOnboardingSetup`). */
export const uuidOf = (body: unknown, what: string): string => sharedUuidOf(body, what, 'KeyOnboardingSetup');
