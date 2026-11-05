/**
 * secrets — the Basic-credential passwords of the timestamping block, derived, never stored.
 *
 * `basicPassword(tspProfileUuid, username)` is derived from `TSA_RUN_SECRET` (HMAC-SHA256), so the setup and a spec that
 * authenticates against the TSP endpoint get the same value. The summary file holds no password, because a Testkube run may
 * publish the state directory. `TSA_RUN_SECRET` is generated per run by `playwright.devblock.config.ts`, kept in the process
 * environment only, never written or printed. A missing or short value is an error, never a fallback.
 */
import * as crypto from 'crypto';

export const RUN_SECRET_VARIABLE = 'TSA_RUN_SECRET';

/** A fresh run secret. */
export const newRunSecret = (): string => crypto.randomBytes(32).toString('base64url');

/**
 * Makes sure the process environment holds this run's secret: sets a fresh one only when none is there (empty counts as none), keeps a value
 * already present. The runner process calls it first; every worker process it spawns inherits the value, and a worker that loads the config
 * again finds it set, so setup, specs, retries and the global teardown all derive from the same secret. Returns the value in use.
 */
export function ensureRunSecret(env: NodeJS.ProcessEnv = process.env): string {
    if (!env[RUN_SECRET_VARIABLE]) env[RUN_SECRET_VARIABLE] = newRunSecret();
    return env[RUN_SECRET_VARIABLE]!;
}

function runSecret(env: NodeJS.ProcessEnv): string {
    const value = env[RUN_SECRET_VARIABLE];
    if (!value || value.length < 32) {
        throw new Error(`${RUN_SECRET_VARIABLE} is not set (playwright.devblock.config.ts generates it for every run): the Basic-credential passwords are derived from it, never stored`);
    }
    return value;
}

/** The password of the Basic credential `username` on TSP profile `tspProfileUuid`, in this run. */
export function basicPassword(tspProfileUuid: string, username: string, env: NodeJS.ProcessEnv = process.env): string {
    const mac = crypto.createHmac('sha256', runSecret(env)).update(`tsp-basic:${tspProfileUuid.toLowerCase()}:${username}`).digest('base64url');
    return `Ts${mac.slice(0, 24)}`;
}
