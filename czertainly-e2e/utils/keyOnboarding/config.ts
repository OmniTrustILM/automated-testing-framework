/**
 * config — the environment contract of the key onboarding block.
 *
 * Reads the KO_* settings with the developers' defaults and says where the setup leaves its summary (under REG_STATE_DIR,
 * never inside the clone).
 *
 * The block needs a PKCS#11 connector with the key-listing feature, a SoftHSM token behind its proxy sidecar, and docker on
 * the runner. A missing value makes the setup `unavailable` with the variable's name; nothing is guessed.
 */
import * as path from 'path';
import { currentRunId, regressionStateDir } from '../regression/run/runId';

export interface KeyOnboardingConfig {
    /** The PKCS#11 cryptography-provider connector (v2) as core reaches it; found by URL, never registered here. */
    pkcs11ConnectorUrl: string;
    /** The credential-provider v2 connector (secret interface) the run's vault instance is created on. */
    vaultConnectorUrl: string;
    /** The connector's config profile and the label of the token on it. */
    pkcs11Profile: string;
    pkcs11Token: string;
    /** The token's user PIN (no default: the block is unavailable without it). */
    tokenPin?: string;
    /** The running SoftHSM sidecar whose token the block plants key pairs on. */
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

/** The run's summary: `<REG_STATE_DIR>/<run id>.key-onboarding.json`. */
export function summaryFile(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(regressionStateDir(env), `${currentRunId(env)}.key-onboarding.json`);
}
