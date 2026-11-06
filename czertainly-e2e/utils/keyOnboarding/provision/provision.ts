/**
 * provision — the key onboarding setup: preflight, the run's own objects, the planted key pairs and the summary.
 * Only a TierError becomes an `unavailable` reason; a refused body or
 * identity, a programming error or a guard refusal fails the setup test.
 */
import * as fs from 'fs';
import { writeJsonAtomic } from '../../devBlocks/provision/summaryFile';
import * as path from 'path';
import { Logger } from '../../Logger';
import type { GuardedApi } from '../../regression/guard/types';
import { runId } from '../../regression/ledger/runState';
import { newStamp, objectName, step } from '../../devBlocks/provision/names';
import { Admin, TierError } from '../../devBlocks/provision/transport';
import { KeyOnboardingConfig, keyOnboardingConfig, summaryFile } from '../config';
import type { KeyOnboardingSummary } from '../types';
import { DEFAULT_POLL, PollSettings, SETUP_LEDGER_SPEC, SetupContext } from './context';
import { defaultDockerRunner, DockerRunner } from './docker';
import { createPinSecret, createToken, createTokenProfile, createVaultInstance, createVaultProfile } from './objects';
import { plantKeys } from './plant';
import { preflight } from './preflight';

export { SETUP_LEDGER_SPEC };
export { offlineBlocker, runnerBlocker } from './preflight';
export { unplantRunKeys } from './plant';
export { defaultDockerRunner } from './docker';
export type { DockerRunner } from './docker';

const logger = new Logger('KeyOnboardingSetup');

export interface ProvisionOptions {
    cfg?: KeyOnboardingConfig;
    env?: NodeJS.ProcessEnv;
    poll?: Partial<PollSettings>;
    docker?: DockerRunner;
    stamp?: string;
}

/** The summary while a setup attempt runs, so a killed or retried attempt never leaves an older `ready` file behind. */
export const SETUP_NOT_FINISHED = 'setup not finished (the key onboarding setup is running, or an attempt was stopped before it wrote its summary)';

export function unavailableSummary(reason: string): KeyOnboardingSummary {
    return { status: 'unavailable', runId: runId(), at: new Date().toISOString(), reason };
}

export async function provisionKeyOnboarding(api: GuardedApi, opts: ProvisionOptions = {}): Promise<KeyOnboardingSummary> {
    const env = opts.env ?? process.env;
    const cfg = opts.cfg ?? keyOnboardingConfig(env);
    const docker = opts.docker ?? defaultDockerRunner(env);
    const admin = new Admin(api, { loggerName: 'KeyOnboardingSetup', guardLabel: 'key onboarding setup' });
    const found = await preflight(admin, cfg, docker, env);
    if (found.status === 'unavailable') {
        logger.warn(`key onboarding unavailable: ${found.reason}`);
        return unavailableSummary(found.reason);
    }
    const pre = found.prerequisites;
    const ctx: SetupContext = { admin, cfg, env, poll: { ...DEFAULT_POLL, ...opts.poll }, docker, stamp: opts.stamp ?? newStamp(), log: logger };

    admin.markProvisioningStart();
    try {
        const vault = await step('vault instance', () => createVaultInstance(ctx, pre.vault, objectName(ctx, 'ko-vault')));
        const vaultProfile = await step('vault profile', () => createVaultProfile(ctx, vault, objectName(ctx, 'ko-vault-profile')));
        const pin = await step('PIN secret', () => createPinSecret(ctx, vault, vaultProfile, objectName(ctx, 'ko-token-pin')));
        const token = await step('token', () => createToken(ctx, pre, pin, objectName(ctx, 'ko-token')));
        const tokenProfile = await step('token profile', () => createTokenProfile(ctx, token, objectName(ctx, 'ko-token-profile')));
        const planting = await step('planting', () => plantKeys({ docker, sidecarContainer: cfg.sidecarContainer, tokenLabel: cfg.pkcs11Token, pin: cfg.tokenPin ?? '', stamp: ctx.stamp }));

        const serverAt = admin.provisionedAt();
        if (!serverAt) logger.warn('no Date header on the provisioning answers: provisionedAt falls back to the runner clock');
        return {
            status: 'ready',
            runId: runId(),
            provisionedAt: (serverAt ?? new Date()).toISOString(),
            provisioning: {
                token: { name: token.name, uuid: token.uuid },
                tokenProfile: { name: tokenProfile.name, uuid: tokenProfile.uuid },
                planted: planting.planted,
                certifiedCertificate: planting.certifiedCertificate,
            },
        };
    } catch (e) {
        if (!(e instanceof TierError)) throw e;
        logger.warn(`key onboarding provisioning stopped: ${e.message}`);
        return unavailableSummary(`provisioning stopped at ${e.message} (the objects created so far are in the ledger and the key pairs planted so far carry the run prefix; the teardown removes both)`);
    }
}

/** Writes the summary with mode 0600 through a temp file and a rename, so a reader never sees half a file. */
export function writeSummary(summary: KeyOnboardingSummary, env: NodeJS.ProcessEnv = process.env): string {
    const file = summaryFile(env);
    return writeJsonAtomic(file, summary);
}
