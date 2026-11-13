/**
 * need — the `@needs:key-onboarding` check: `undefined` when the runner can plant and remove key pairs and the tier has the
 * PKCS#11 connector with `keyList` and a credential-provider with a `secret` interface, else the skip reason. Reads only.
 */
import type { GuardedApi } from '../regression/guard/types';
import { Admin, TierError } from '../devBlocks/provision/transport';
import { keyOnboardingConfig, type KeyOnboardingConfig } from './config';
import { discoverConnectors, offlineBlocker, runnerBlocker, type RunnerTools } from './provision/preflight';

const NEED = '@needs:key-onboarding';

const remembered = new Map<string, string | undefined>();

export function resetKeyOnboardingNeedForTests(): void {
    remembered.clear();
}

const gate = (reason: string): string => `deploy gate: ${reason} (${NEED})`;

export async function keyOnboardingNeedProblem(
    api: GuardedApi, env: NodeJS.ProcessEnv = process.env, cfg: KeyOnboardingConfig = keyOnboardingConfig(env), tools: RunnerTools = {},
): Promise<string | undefined> {
    const blocked = offlineBlocker(cfg, env);
    if (blocked) return gate(blocked);
    const key = `${env.BASE_URL ?? ''}|${cfg.mode}|${cfg.pkcs11ConnectorUrl}|${cfg.vaultConnectorUrl}|${cfg.kube.namespace}|${cfg.kube.deployment}`;
    if (remembered.has(key)) return remembered.get(key);
    let reason = await runnerBlocker(cfg, tools, env);
    if (!reason) {
        try {
            const found = await discoverConnectors(new Admin(api, { loggerName: 'KeyOnboardingNeed', guardLabel: 'key onboarding need' }), cfg);
            reason = 'reason' in found ? found.reason : undefined;
        } catch (e) {
            if (!(e instanceof TierError)) throw e;
            reason = `the tier did not answer a read of the key onboarding components (${e.message})`;
        }
    }
    const answer = reason ? gate(reason) : undefined;
    remembered.set(key, answer);
    return answer;
}
