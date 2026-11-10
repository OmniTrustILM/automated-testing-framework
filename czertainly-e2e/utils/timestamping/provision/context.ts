/**
 * context — what every provisioning step shares: the admin transport, the configuration, the waits, the run's names and `recordOwn`. No
 * requests.
 * A Playwright retry of the setup must never reuse a name of its first attempt (EJBCA binds a key and an end-entity name once).
 */
import * as crypto from 'crypto';
import { newStamp, objectName, step, uuidOf as sharedUuidOf } from '../../devBlocks/provision/names';
import type { Logger } from '../../Logger';
import { LedgerLine, OwnRef, recordCreated, Ref } from '../../regression/ledger/ledger';
import type { TimestampingConfig } from '../config';
import type { Admin, PollSettings } from './transport';

export const SETUP_LEDGER_SPEC = 'timestamping/setup';

export interface SetupContext {
    /** The strict guarded transport: every request of the setup goes through it. */
    admin: Admin;
    /**
     * Over a `localStack` guard, present only on a proven local stack: marks the issuing root CA trusted and serves the v1 software
     * provider's token callback.
     */
    localAdmin?: Admin;
    cfg: TimestampingConfig;
    env: NodeJS.ProcessEnv;
    poll: PollSettings;
    stamp: string;
    log: Logger;
}

export { newStamp, objectName, step };

/** A generated secret (the token code): never a literal in the source, never stored. */
export const generatedSecret = (): string => `Ts${crypto.randomBytes(18).toString('base64url')}`;

/** Written right after the create answered: a line written after a wait is lost when the wait times out. */
export function recordOwn(type: string, ref: Ref, note: string, parents?: LedgerLine['parents'], serverAt?: Date): OwnRef {
    return recordCreated(type, ref, { spec: SETUP_LEDGER_SPEC, note, ...(parents ? { parents } : {}), ...(serverAt ? { serverAt } : {}) });
}

export const uuidOf = (body: unknown, what: string): string => sharedUuidOf(body, what, 'TimestampingSetup');
