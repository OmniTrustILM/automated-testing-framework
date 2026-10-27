/**
 * transport — the admin requests of the timestamping setup and the two kinds of failure it tells apart.
 *
 * WHAT: `Admin` sends every admin request of the preflight and the provisioner through the GUARDED context (`/api` is
 * prefixed here, callers write `/v1/...` like timestamping-setup.sh does), remembers the server's Date header of the
 * first response after `markProvisioningStart()`, and polls with attempt counts instead of fixed sleeps.
 * - `TierError`: the TIER cannot provide what a step needs (a 404 or 5xx answer, an attribute or profile the connector
 *   does not offer, a wait that runs out). It becomes the summary's `unavailable` reason or a family's entry in
 *   `missingFamilies`, and the setup test passes.
 * - `SetupError`: the setup itself is wrong (401 / 403 on any request: the admin identity is broken; 400 / 422 on a
 *   POST, PUT or PATCH: the setup sent a body core refuses). It propagates, and the setup test fails.
 * WHY: a refused body or a broken identity must never pass green as "this tier lacks timestamping".
 * HOW: the generic parts live in `utils/devBlocks/provision/transport.ts`; this file re-exports them and instantiates `Admin` with the
 * timestamping setup's logger name. GET goes through `api.get`, every other method through `api.fetch` of the guarded context (the guard judges and
 * sends it; on a proven local stack `localStack` lifts the ownership rule and the platform deny-list only). A reason
 * carries the method, the path with every uuid replaced by `{id}` and the status, never the answer's body (it may echo
 * fragments of the request); the body goes to the log only.
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
