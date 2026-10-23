/**
 * context — what every provisioning step shares: the admin transport, the configuration, the waits, the run's names
 * and the one way a step records what it created.
 *
 * WHAT: `SETUP_LEDGER_SPEC` (the `spec` of every ledger line the setup writes), `SetupContext`, `recordOwn` (the
 * ledger line of a create, written right after the create answered), `objectName` (run-prefixed names, unique per
 * setup attempt), `generatedSecret` (per-run passwords and token codes) and `step` (a TierError names its step).
 * WHY: the block teardown selects exactly the lines whose spec starts with `timestamping/`; the run-end teardown's
 * live-name check accepts only `<run id>-…` names; a Playwright retry of the setup project must never reuse a name of
 * its first attempt (EJBCA binds a key and an end-entity name once, the username follows the CN).
 * HOW: plain helpers, no requests. `objectName`, `newStamp` and `step` are re-exported from `utils/devBlocks/provision/names.ts`;
 * `uuidOf` binds its logger name.
 */
import * as crypto from 'crypto';
import { newStamp, objectName, step, uuidOf as sharedUuidOf } from '../../devBlocks/provision/names';
import type { Logger } from '../../Logger';
import { LedgerLine, OwnRef, recordCreated, Ref } from '../../regression/ledger/ledger';
import type { TimestampingConfig } from '../config';
import type { Admin, PollSettings } from './transport';

/** The ledger `spec` of every line the timestamping setup writes (the block teardown selects `timestamping/…`). */
export const SETUP_LEDGER_SPEC = 'timestamping/setup';

export interface SetupContext {
    admin: Admin;
    cfg: TimestampingConfig;
    env: NodeJS.ProcessEnv;
    poll: PollSettings;
    /** Four base36 characters, the same in every name of one setup attempt. */
    stamp: string;
    log: Logger;
}

export { newStamp, objectName, step };

/** A generated secret (Basic credential password, token code): never a literal in the source, kept only in the summary. */
export const generatedSecret = (): string => `Ts${crypto.randomBytes(18).toString('base64url')}`;

/**
 * The ledger line of an object the setup created, right after its create answered (before any enable, wait or
 * assertion: a line written after a wait is lost when the wait times out).
 */
export function recordOwn(type: string, ref: Ref, note: string, parents?: LedgerLine['parents'], serverAt?: Date): OwnRef {
    return recordCreated(type, ref, { spec: SETUP_LEDGER_SPEC, note, ...(parents ? { parents } : {}), ...(serverAt ? { serverAt } : {}) });
}

/** The uuid of a create answer, or a TierError (`require_uuid`). */
export const uuidOf = (body: unknown, what: string): string => sharedUuidOf(body, what, 'TimestampingSetup');
