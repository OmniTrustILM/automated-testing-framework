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
        return;
    }
    const baseRequest = await playwrightRequest.newContext({
        baseURL: env.baseUrl,
        ignoreHTTPSErrors: true,
    });
    const api = await getAuthenticatedApiContext(baseRequest, env);

    try {
        // PKI chain — only if it was provisioned (SMK-004 path)
        if (state.raProfileUuid && state.authorityUuid) {
            try { await raProfileUtils.deleteRaProfile(api, state.authorityUuid, state.raProfileUuid); }
            catch (e) { logger.warn(`Teardown: deleteRaProfile failed: ${e}`); }
        }
        if (state.authorityUuid) {
            try { await authorityUtils.deleteAuthority(api, state.authorityUuid); }
            catch (e) { logger.warn(`Teardown: deleteAuthority failed: ${e}`); }
        }
        if (state.credentialUuid) {
            try { await credentialUtils.deleteCredential(api, state.credentialUuid); }
            catch (e) { logger.warn(`Teardown: deleteCredential failed: ${e}`); }
        }

        // Connectors WE registered this run — only these, never pre-existing ones
        for (const uuid of state.registeredConnectorUuids) {
            try { await connectorUtils.deleteConnector(api, uuid); }
            catch (e) { logger.warn(`Teardown: deleteConnector ${uuid} failed: ${e}`); }
        }

        deleteSmokeState();
        logger.info(`globalTeardown complete`);
    } finally {
        await api.dispose();
        await baseRequest.dispose();
    }
}
