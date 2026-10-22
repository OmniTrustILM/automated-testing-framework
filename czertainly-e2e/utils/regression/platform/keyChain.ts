/**
 * keyChain — the run's token, enabled profile and key, created once and reused.
 *
 * WHAT: Provides ensureKeyChain, which returns the run's own token, enabled token profile and key (or a named skip reason when the tier has no cryptography connector of the wanted version).
 * WHY: Many specs need a working key and must not each create a token and profile; one chain per run keeps the tier clean and the ledger short.
 * HOW: Idempotent through the run state (token, tokenProfile, key); a second call with another family or suffix adds one more key on the same token and profile.
 */

import { Family, PROFILE_USAGES, Usage } from './cryptoAlgorithmCases';
import type { GuardedApi } from '../guard/types';
import { readRunState, updateRunState } from '../ledger/runState';
import { KeyChain, createOwnKey, enableOwnKey } from './keys';
import { findCryptoConnector, providerOf, createOwnToken, createOwnTokenProfile, enableOwnTokenProfile } from './tokens';


export interface ChainOptions {
    family?: Family;
    suffix?: string;
    /** Interface version of the token (2 default; 1 when asked). */
    version?: 1 | 2;
    usages?: readonly Usage[];
    /** Enable the key right after creation (the chain's default key is ACTIVE + enabled). */
    enableKey?: boolean;
}

/**
 * The run's token → enabled profile → key (own objects, recorded; idempotent per run through RunState `token`,
 * `tokenProfile`, `key`; a second call with another family or suffix adds one more key on the same token and profile).
 * Returns undefined (no throw) when the tier has no cryptography connector of the version: the caller skips.
 */
export async function ensureKeyChain(api: GuardedApi, spec: string, opts: ChainOptions = {}): Promise<KeyChain | { skip: string }> {
    const version = opts.version ?? 2;
    const connector = await findCryptoConnector(api, version);
    if (!connector) return { skip: `no connected software cryptography connector of interface v${version} is registered on this tier (REG_CRYPTO_CONNECTOR_V${version})` };
    const state = readRunState();
    let token = state.token;
    let tokenProfile = state.tokenProfile;
    if (!token || !tokenProfile) {
        token = await createOwnToken(api, spec, 'tok', { connector });
        tokenProfile = await createOwnTokenProfile(api, spec, 'tp', { token, usages: opts.usages ?? PROFILE_USAGES, enabled: false });
        await enableOwnTokenProfile(api, token, tokenProfile);
        updateRunState({ token, tokenProfile });
    }
    const family = opts.family ?? 'rsa-2048';
    const wantsDefault = !opts.suffix && family === 'rsa-2048';
    let key = wantsDefault ? state.key : undefined;
    if (!key) {
        const made = await createOwnKey(api, spec, opts.suffix ?? `key-${family}`, { chain: { token, tokenProfile }, family });
        key = { uuid: made.uuid, name: made.name, kind: 'own', keyItems: made.keyItems };
        if (opts.enableKey ?? true) await enableOwnKey(api, key);
        if (wantsDefault) updateRunState({ key });
    }
    return { connector, provider: providerOf(connector), token, tokenProfile, key };
}

export const isSkip = <T>(r: T | { skip: string }): r is { skip: string } => typeof (r as { skip?: unknown }).skip === 'string';
