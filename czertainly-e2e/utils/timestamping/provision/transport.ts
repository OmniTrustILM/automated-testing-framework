/**
 * transport — the admin requests of the timestamping setup (the shared transport of utils/devBlocks/provision/transport.ts, with the logger
 * named).
 * `TierError` becomes the `unavailable` reason and the setup test passes; `SetupError` (401 / 403, or 400 / 422 on a write) fails it.
 */
import type { GuardedApi } from '../../regression/guard/types';
import { Admin as SharedAdmin } from '../../devBlocks/provision/transport';

export { TierError, SetupError, failureOf, pathPattern } from '../../devBlocks/provision/transport';
export type { Method, Answer } from '../../devBlocks/provision/transport';

export class Admin extends SharedAdmin {
    constructor(api: GuardedApi) {
        super(api, { loggerName: 'TimestampingSetup', guardLabel: 'timestamping setup' });
    }
}

/** The waits' defaults; the unit tests use 0 ms pauses. */
export interface PollSettings {
    certificateAttempts: number;
    certificateIntervalMs: number;
    linkageAttempts: number;
    linkageIntervalMs: number;
    validationAttempts: number;
    validationIntervalMs: number;
}

export const DEFAULT_POLL: PollSettings = {
    // CERT_POLL_ATTEMPTS / CERT_POLL_INTERVAL
    certificateAttempts: 20,
    certificateIntervalMs: 1_000,
    // wait_for_issuer_linkage: 10 × 0.5 s
    linkageAttempts: 10,
    linkageIntervalMs: 500,
    // wait_for_certificate_validation: 20 × 0.5 s
    validationAttempts: 20,
    validationIntervalMs: 500,
};
