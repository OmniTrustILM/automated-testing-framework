/**
 * secrets — the Basic-credential passwords of the timestamping block, derived (HMAC-SHA256) from `TSA_RUN_SECRET`, never stored.
 * The secret is generated per run by `playwright.devblock.config.ts` and kept in the process environment only; a missing or short value is
 * an error, never a fallback.
 */
import * as crypto from 'crypto';

export const RUN_SECRET_VARIABLE = 'TSA_RUN_SECRET';

export const newRunSecret = (): string => crypto.randomBytes(32).toString('base64url');

/** Sets a fresh secret only when none is there (empty counts as none); workers inherit it. Returns the value in use. */
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

export function basicPassword(tspProfileUuid: string, username: string, env: NodeJS.ProcessEnv = process.env): string {
    const mac = crypto.createHmac('sha256', runSecret(env)).update(`tsp-basic:${tspProfileUuid.toLowerCase()}:${username}`).digest('base64url');
    return `Ts${mac.slice(0, 24)}`;
}
