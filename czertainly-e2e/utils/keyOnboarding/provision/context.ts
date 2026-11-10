/**
 * context — what every step of the key onboarding setup shares: `SETUP_LEDGER_SPEC`,
 * `SetupContext`, `recordOwn` and the waits' defaults. No requests.
 */
import { uuidOf as sharedUuidOf } from '../../devBlocks/provision/names';
import type { Logger } from '../../Logger';
import { LedgerLine, OwnRef, recordCreated, Ref } from '../../regression/ledger/ledger';
import type { Admin } from '../../devBlocks/provision/transport';
import type { KeyOnboardingConfig } from '../config';

export const SETUP_LEDGER_SPEC = 'key-onboarding/setup';

export interface PollSettings {
    /** The PIN secret becoming active and enabled. */
    secretAttempts: number;
    secretIntervalMs: number;
}

export const DEFAULT_POLL: PollSettings = { secretAttempts: 30, secretIntervalMs: 500 };

export interface SetupContext {
    admin: Admin;
    cfg: KeyOnboardingConfig;
    env: NodeJS.ProcessEnv;
    poll: PollSettings;
    stamp: string;
    log: Logger;
}

/** Written right after the create answered: a line written after a wait is lost when the wait times out. */
export function recordOwn(type: string, ref: Ref, note: string, parents?: LedgerLine['parents'], serverAt?: Date): OwnRef {
    return recordCreated(type, ref, { spec: SETUP_LEDGER_SPEC, note, ...(parents ? { parents } : {}), ...(serverAt ? { serverAt } : {}) });
}

export const uuidOf = (ctx: Pick<SetupContext, 'admin'>, body: unknown, what: string): string => sharedUuidOf(body, what, 'KeyOnboardingSetup', ctx.admin.secrets);
