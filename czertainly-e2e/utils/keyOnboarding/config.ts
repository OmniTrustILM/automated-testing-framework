/**
 * config — the KO_* settings of the key onboarding block and where the setup leaves its summary (under REG_STATE_DIR).
 * A missing value makes the setup `unavailable` with the variable's name; nothing is guessed.
 */
import * as path from 'path';
import { currentRunId, regressionStateDir } from '../regression/run/runId';

export interface KeyOnboardingConfig {
    /** The PKCS#11 cryptography-provider connector (v2) as core reaches it; found by URL, never registered here. */
    pkcs11ConnectorUrl: string;
    vaultConnectorUrl: string;
    pkcs11Profile: string;
    pkcs11Token: string;
    /** No default: the block is unavailable without it. */
    tokenPin?: string;
    sidecarContainer: string;
}

export function keyOnboardingConfig(env: NodeJS.ProcessEnv = process.env): KeyOnboardingConfig {
    return {
        pkcs11ConnectorUrl: env.KO_PKCS11_CONNECTOR_URL ?? 'http://localhost:8290',
        vaultConnectorUrl: env.KO_VAULT_CONNECTOR_URL ?? 'http://localhost:8200',
        pkcs11Profile: env.KO_PKCS11_PROFILE ?? 'softhsm',
        pkcs11Token: env.KO_PKCS11_TOKEN ?? 'softhsm',
        tokenPin: env.KO_TOKEN_PIN || undefined,
        sidecarContainer: env.KO_SIDECAR_CONTAINER ?? 'pkcs11-sidecar-softhsm',
    };
}

export function summaryFile(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(regressionStateDir(env), `${currentRunId(env)}.key-onboarding.json`);
}
