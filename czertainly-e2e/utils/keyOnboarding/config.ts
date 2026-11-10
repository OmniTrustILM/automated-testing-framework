/**
 * config — the KO_* settings of the key onboarding block and where the setup leaves its summary (under REG_STATE_DIR).
 * Key pairs are planted with docker on a proven local stack and with `kubectl exec` into the sidecar on a shared tier (KO_KUBE_*).
 * A missing value makes the setup `unavailable` with the variable's name; nothing is guessed.
 */
import * as path from 'path';
import { currentRunId, regressionStateDir } from '../regression/run/runId';
import { isLocalTier } from '../regression/tier/kind';

export type PlantingMode = 'docker' | 'cluster';

export interface KubeTarget {
    namespace: string;
    deployment: string;
    container: string;
    module: string;
}

export interface KeyOnboardingConfig {
    /** The PKCS#11 cryptography-provider connector (v2) as core reaches it; found by URL, never registered here. */
    pkcs11ConnectorUrl: string;
    vaultConnectorUrl: string;
    pkcs11Profile: string;
    pkcs11Token: string;
    /** No default: the block is unavailable without it. */
    tokenPin?: string;
    sidecarContainer: string;
    mode: PlantingMode;
    kube: KubeTarget;
}

export function keyOnboardingConfig(env: NodeJS.ProcessEnv = process.env): KeyOnboardingConfig {
    return {
        pkcs11ConnectorUrl: env.KO_PKCS11_CONNECTOR_URL ?? 'http://localhost:8290',
        vaultConnectorUrl: env.KO_VAULT_CONNECTOR_URL ?? 'http://localhost:8200',
        pkcs11Profile: env.KO_PKCS11_PROFILE ?? 'softhsm',
        pkcs11Token: env.KO_PKCS11_TOKEN ?? 'softhsm',
        tokenPin: env.KO_TOKEN_PIN || undefined,
        sidecarContainer: env.KO_SIDECAR_CONTAINER ?? 'pkcs11-sidecar-softhsm',
        mode: isLocalTier(env) ? 'docker' : 'cluster',
        kube: {
            namespace: env.KO_KUBE_NAMESPACE ?? 'ilm',
            deployment: env.KO_KUBE_DEPLOYMENT ?? 'pkcs11-cryptography-provider',
            container: env.KO_KUBE_CONTAINER ?? 'proxy-softhsm',
            module: env.KO_PKCS11_MODULE ?? '/usr/lib/softhsm/libsofthsm2.so',
        },
    };
}

export function summaryFile(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(regressionStateDir(env), `${currentRunId(env)}.key-onboarding.json`);
}

/** While the planting marker exists the token may hold the run's pairs: a removal that cannot run fails the teardown. */
export function plantingMarkerFile(runId: string, env: NodeJS.ProcessEnv = process.env): string {
    return path.join(regressionStateDir(env), `${runId}.key-onboarding.planting`);
}
