/**
 * Playwright globalTeardown for SMK-004.
 *
 * Runs ONCE after all tests. Reads .smoke-state.json (written by globalSetup)
 * and deletes the provisioned PKI chain in reverse dependency order:
 *   RA Profile → Authority → Credential → state file
 *
 * No-op if state file doesn't exist (globalSetup skipped or failed before writing).
 * Each delete is best-effort (try/catch + warn) — one failure doesn't block the others.
 */

import { FullConfig, request as playwrightRequest } from '@playwright/test';
import { loadEnv } from './utils/env';
import { getAuthenticatedApiContext } from './fixtures/testFixtures';
import * as credentialUtils from './utils/credentialUtils';
import * as authorityUtils from './utils/authorityUtils';
import * as raProfileUtils from './utils/raProfileUtils';
import { readSmokeState, deleteSmokeState } from './utils/smokeState';
import { Logger } from './utils/Logger';

const logger = new Logger('GlobalTeardown');

export default async function globalTeardown(_config: FullConfig): Promise<void> {
    const state = readSmokeState();
    if (!state) {
        logger.info('No smoke state file — nothing to clean up');
        return;
    }

    const env = loadEnv();
    const baseRequest = await playwrightRequest.newContext({
        baseURL: env.baseUrl,
        ignoreHTTPSErrors: true,
    });
    const api = await getAuthenticatedApiContext(baseRequest, env);

    try {
        // Reverse dependency order: RA Profile → Authority → Credential
        try { await raProfileUtils.deleteRaProfile(api, state.authorityUuid, state.raProfileUuid); }
        catch (e) { logger.warn(`Teardown: deleteRaProfile failed: ${e}`); }

        try { await authorityUtils.deleteAuthority(api, state.authorityUuid); }
        catch (e) { logger.warn(`Teardown: deleteAuthority failed: ${e}`); }

        try { await credentialUtils.deleteCredential(api, state.credentialUuid); }
        catch (e) { logger.warn(`Teardown: deleteCredential failed: ${e}`); }

        deleteSmokeState();
        logger.info(`globalTeardown complete`);
    } finally {
        await api.dispose();
        await baseRequest.dispose();
    }
}
