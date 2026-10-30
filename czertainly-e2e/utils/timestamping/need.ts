/**
 * need — the `timestamping` need (`@needs:timestamping`, utils/regression/tags.ts): can this tier run the timestamping block?
 *
 * `timestampingNeedProblem(api)` answers `undefined` when OpenSSL 3 is on the runner and the tier has every connected
 * component the block builds on (SoftKeyStore credentials, EJBCA authority, software cryptography v2, timestamp
 * formatting, a vault with a secret interface) plus the configured authority and vault instances. Otherwise it returns the
 * skip reason. Reads only. A failed read (404 or 5xx) is the tier's "no"; a SetupError (401 / 403) propagates.
 * See tests/timestamping/SHARED-TIER.md.
 */
import type { GuardedApi } from '../regression/guard/types';
import { requireTool } from '../regression/requireTool';
import { timestampingConfig, type TimestampingConfig } from './config';
import { discoverParents, offlineBlocker } from './provision/preflight';
import { Admin, TierError } from './provision/transport';

const NEED = '@needs:timestamping';

const remembered = new Map<string, string | undefined>();

/** Forget what was read (unit tests). */
export function resetTimestampingNeedForTests(): void {
    remembered.clear();
}

const gate = (reason: string): string => `deploy gate: ${reason} (${NEED})`;

/** `undefined` when the tier can run the block, else the reason the row skips with. Only reads. */
export async function timestampingNeedProblem(
    api: GuardedApi, env: NodeJS.ProcessEnv = process.env, cfg: TimestampingConfig = timestampingConfig(env), tools: { requireTool: typeof requireTool } = { requireTool },
): Promise<string | undefined> {
    const tool = tools.requireTool('openssl');
    if (tool) return gate(tool);
    const blocked = offlineBlocker(cfg, env);
    if (blocked) return gate(blocked);
    const key = `${env.BASE_URL ?? ''}|${cfg.cryptoProvider}|${cfg.authorityName}|${cfg.vaultInstanceName}`;
    if (remembered.has(key)) return remembered.get(key);
    let reason: string | undefined;
    try {
        const found = await discoverParents(new Admin(api), cfg);
        reason = found.status === 'unavailable' ? gate(found.reason) : undefined;
    } catch (e) {
        if (!(e instanceof TierError)) throw e;
        reason = gate(`the tier did not answer a read of the timestamping components (${e.message})`);
    }
    remembered.set(key, reason);
    return reason;
}
