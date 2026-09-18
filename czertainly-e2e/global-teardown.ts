/**
 * Playwright globalTeardown for the smoke suite.
 *
 * Default mode: reads .smoke-state.json and deletes everything globalSetup created,
 * in reverse dependency order:
 *   RA Profile → Authority → Credential → registered connectors → state file
 * Only connectors THIS run registered (tracked by globalSetup) are deleted —
 * pre-existing connectors are left untouched so we don't break manual work.
 *
 * Persistent mode (SMOKE_PERSIST=true): skip entirely — leave state file and
 * provisioned entities in place for the next local run to reuse. Dev cleans up
 * manually when done iterating (delete .smoke-state.json + entities in UI/API).
 *
 * No-op if the state file doesn't exist. Each delete is best-effort (try/catch + warn).
 */

import { FullConfig, request as playwrightRequest } from '@playwright/test';
import { loadEnv } from './utils/env';
import { getAuthenticatedApiContext } from './fixtures/testFixtures';
import * as connectorUtils from './utils/connectorUtils';
import * as credentialUtils from './utils/credentialUtils';
import * as authorityUtils from './utils/authorityUtils';
import * as raProfileUtils from './utils/raProfileUtils';
import { readSmokeState, deleteSmokeState } from './utils/smokeState';
import { attemptCleanup, clearCleanupFailures, formatCleanupReport, readCleanupFailures } from './utils/cleanupLedger';
import { Logger } from './utils/Logger';

const logger = new Logger('GlobalTeardown');

export default async function globalTeardown(_config: FullConfig): Promise<void> {
    const env = loadEnv();

    if (env.smokePersist) {
        logger.info('SMOKE_PERSIST=true — preserving state file and provisioned entities for next run.');
        return;
    }

    const state = readSmokeState();
    if (!state) {
        logger.info('No smoke state file — nothing to clean up');
        reportLeftovers();
        return;
    }
    const baseRequest = await playwrightRequest.newContext({
        baseURL: env.baseUrl,
        ignoreHTTPSErrors: true,
    });
    const api = await getAuthenticatedApiContext(baseRequest, env);

    try {
        // Reverse dependency order. Each step names the step above it, so that a refusal caused by
        // an object that is still there is reported as a consequence rather than as a second cause.
        let raProfileGone = true;
        let authorityGone = true;

        // PKI chain — only if it was provisioned (SMK-004 path)
        if (state.raProfileUuid && state.authorityUuid) {
            raProfileGone = await attemptCleanup(
                { resource: 'raProfile', uuid: state.raProfileUuid, name: state.raProfileName },
                () => raProfileUtils.deleteRaProfile(api, state.authorityUuid, state.raProfileUuid),
            );
        }
        if (state.authorityUuid) {
            authorityGone = await attemptCleanup(
                { resource: 'authority', uuid: state.authorityUuid, name: state.authorityName },
                () => authorityUtils.deleteAuthority(api, state.authorityUuid),
                { blockedBy: raProfileGone ? undefined : `raProfile ${state.raProfileUuid}` },
            );
        }
        if (state.credentialUuid) {
            await attemptCleanup(
                { resource: 'credential', uuid: state.credentialUuid, name: state.credentialName },
                () => credentialUtils.deleteCredential(api, state.credentialUuid),
                { blockedBy: authorityGone ? undefined : `authority ${state.authorityUuid}` },
            );
        }

        // Connectors WE registered this run — only these, never pre-existing ones
        for (const uuid of state.registeredConnectorUuids) {
            await attemptCleanup(
                { resource: 'connector', uuid },
                () => connectorUtils.deleteConnector(api, uuid),
                { blockedBy: authorityGone ? undefined : `authority ${state.authorityUuid}` },
            );
        }

        deleteSmokeState();
        logger.info(`globalTeardown complete`);
    } finally {
        await api.dispose();
        await baseRequest.dispose();
    }

    reportLeftovers();
}

/**
 * Prints everything the run could not remove and fails the run if there is anything.
 *
 * Playwright keeps the per-test result lines as they were — a test that passed still reads as
 * passed — but a throwing globalTeardown adds an error of its own and exits non-zero, which is
 * what CI and Testkube act on. That is the point: cleanup is part of the result, and a run that
 * leaks objects into a shared environment has not finished successfully.
 */
function reportLeftovers(): void {
    const failures = readCleanupFailures();
    clearCleanupFailures();
    if (failures.length === 0) return;

    const report = formatCleanupReport(failures);
    logger.error(`Cleanup did not complete:\n${report}`);
    throw new Error(`Cleanup did not complete — the environment still holds objects from this run.\n${report}`);
}
