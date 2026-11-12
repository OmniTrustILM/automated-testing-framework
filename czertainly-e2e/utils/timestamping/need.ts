/**
 * need — the `timestamping` need (`@needs:timestamping`, utils/regression/tags.ts): can this tier run the timestamping block at all?
 *
 * WHAT: `timestampingNeedProblem(api)` answers `undefined` when OpenSSL 3 is on the runner and the tier has every connected component
 * the block builds on (credential-provider SoftKeyStore, EJBCA authority provider, software cryptography provider v2, timestamp
 * formatting, vault with a secret interface) plus the authority instance and the vault instance the configuration names; else the
 * named reason the row skips with (`deploy gate: … (@needs:timestamping)`).
 * WHY: the blanket `@local` on every row kept the block off every shared tier. A tier that DevOps equipped should run it; one without the
 * components should skip with a reason that says what to deploy, before any row creates anything (tests/timestamping/SHARED-TIER.md).
 * HOW: reads only, through the guarded context of the `needs` fixture (lists and GETs; the guard allows them on every tier), the same
 * `discoverParents` the setup's preflight uses. A TierError of a read (a 404 or 5xx answer) is the tier's "no", a SetupError (401 / 403) is
 * the identity's and propagates. The answer is remembered per process and tier (the block runs one worker and every row asks): a second
 * row does not read again. The EJBCA profiles and CAs are the setup's preflight to check (it needs callbacks and writes the reason into
 * the summary every row skips with); a `software-v1` or `pkcs11` provider off a proven local stack is refused here too, like there.
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
