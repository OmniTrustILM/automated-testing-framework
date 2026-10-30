/**
 * transport — the admin requests of the timestamping setup and the two kinds of failure it tells apart.
 *
 * `Admin` sends every admin request through the GUARDED context, remembers the server's Date header of the first response
 * after `markProvisioningStart()`, and polls with attempt counts.
 *   - `TierError`: the TIER cannot provide what a step needs; it becomes the `unavailable` reason and the setup test passes.
 *   - `SetupError`: the setup itself is wrong (401 / 403, or 400 / 422 on a write); it propagates and the setup test fails.
 * A reason carries the method, the path with uuids replaced by `{id}` and the status, never the answer's body.
 * The generic parts live in utils/devBlocks/provision/transport.ts; this file re-exports them and names the logger.
 */
import type { GuardedApi } from '../../regression/guard/types';
import { Admin as SharedAdmin } from '../../devBlocks/provision/transport';

export { TierError, SetupError, failureOf, pathPattern } from '../../devBlocks/provision/transport';
export type { Method, Answer } from '../../devBlocks/provision/transport';

/** The shared admin transport, named for the timestamping setup (its warnings are logged as `TimestampingSetup`). */
export class Admin extends SharedAdmin {
    constructor(api: GuardedApi) {
        super(api, { loggerName: 'TimestampingSetup', guardLabel: 'timestamping setup' });
    }
}

/** Attempts and pauses of the waits (the defaults are timestamping-setup.sh's; the unit tests use 0 ms pauses). */
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
