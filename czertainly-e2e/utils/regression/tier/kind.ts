/**
 * tier/kind — which kind of environment a run talks to: `tierKind()` (TIER_KIND=local is a disposable local stack, anything else a shared
 * tier), `freezeTierEnv` and `tierIdentity()` (a hash of BASE_URL's host, never the host).
 */
import * as crypto from 'crypto';
import { settings } from '../run/settings';

export type TierKind = 'local' | 'shared';

export function tierKind(env: NodeJS.ProcessEnv = process.env): TierKind {
    return settings(env).tierKind === 'local' ? 'local' : 'shared';
}

export function isLocalTier(env: NodeJS.ProcessEnv = process.env): boolean {
    return tierKind(env) === 'local';
}


/**
 * Called by both configs after their env file is loaded: pins TIER_KIND,
 * AUTH_MODE and REG_RA_PROFILE_NAME (dotenv never overrides a set variable).
 */
export function freezeTierEnv(env: NodeJS.ProcessEnv = process.env): void {
    env.TIER_KIND = tierKind(env);
    env.AUTH_MODE = settings(env).authMode;
    env.REG_RA_PROFILE_NAME = env.REG_RA_PROFILE_NAME ?? '';
}

export function tierIdentity(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const baseUrl = settings(env).baseUrl;
    if (!baseUrl) return undefined;
    try {
        const host = new URL(baseUrl).host.toLowerCase();
        return crypto.createHash('sha256').update(host).digest('hex').slice(0, 12);
    } catch {
        return undefined;
    }
}
