/**
 * Playwright globalSetup for the smoke suite.
 *
 * Runs ONCE before any tests. By the time we get here, loadEnv() has guaranteed
 * every smoke env var is present (strict validation in env.ts).
 *
 * Default mode (SMOKE_PERSIST not set): full provisioning every run.
 *   1. Authenticate against Keycloak
 *   2. Register all 3 connectors (auto-register if missing)
 *   3. Create per-run PKI chain (Credential + Authority + RA Profile)
 *   4. Write UUIDs to .smoke-state.json
 *
 * Persistent mode (SMOKE_PERSIST=true) for local iterative dev:
 *   - If .smoke-state.json already exists → log "reusing" + return (no provisioning)
 *   - Otherwise → full provisioning as above; state file persists for next run
 *
 * If any provisioning step fails → best-effort cleanup of partial state, then
 * re-throw → Playwright fails all tests (env is broken).
 */

import { FullConfig, request as playwrightRequest } from '@playwright/test';
import { loadEnv } from './utils/env';
import { getAuthenticatedApiContext } from './fixtures/testFixtures';
import * as connectorUtils from './utils/connectorUtils';
import * as credentialUtils from './utils/credentialUtils';
import * as authorityUtils from './utils/authorityUtils';
import * as raProfileUtils from './utils/raProfileUtils';
import { readSmokeState, writeSmokeState } from './utils/smokeState';
import { Logger } from './utils/Logger';

const logger = new Logger('GlobalSetup');

export default async function globalSetup(_config: FullConfig): Promise<void> {
    const env = loadEnv();

    // Persistent mode: if state already exists, reuse it and skip provisioning.
    if (env.smokePersist && readSmokeState()) {
        logger.info('SMOKE_PERSIST=true and state file exists — reusing fixtures, skipping provisioning.');
        return;
    }

    const baseRequest = await playwrightRequest.newContext({
        baseURL: env.baseUrl,
        ignoreHTTPSErrors: true,
    });
    const api = await getAuthenticatedApiContext(baseRequest, env);

    const registeredConnectorUuids: string[] = [];
    let credentialUuid: string | undefined;
    let authorityUuid: string | undefined;
    let raProfileUuid: string | undefined;

    try {
        // 1. Register all 3 connectors (idempotent — finds existing or creates)
        const discoveryResult = await connectorUtils.ensureConnectorRegistered(api, {
            name: env.smoke.discoveryProviderName!,
            url: env.smoke.discoveryProviderUrl!,
        });
        if (discoveryResult.registered) registeredConnectorUuids.push(discoveryResult.connector.uuid);

        const ejbcaResult = await connectorUtils.ensureConnectorRegistered(api, {
            name: env.smoke.ejbcaConnectorName!,
            url: env.smoke.ejbcaConnectorUrl!,
        });
        if (ejbcaResult.registered) registeredConnectorUuids.push(ejbcaResult.connector.uuid);

        const credResult = await connectorUtils.ensureConnectorRegistered(api, {
            name: env.smoke.credentialConnectorName!,
            url: env.smoke.credentialConnectorUrl!,
        });
        if (credResult.registered) registeredConnectorUuids.push(credResult.connector.uuid);

        const timestamp = Date.now();

        // 2. Create Credential (with P12 + password from env)
        const credentialName = `smoke-credential-${timestamp}`;
        const credential = await credentialUtils.createCredential(api, {
            name: credentialName,
            connectorUuid: credResult.connector.uuid,
            p12Base64: env.smoke.ejbcaP12Base64!,
            password: env.smoke.ejbcaP12Password!,
        });
        credentialUuid = credential.uuid;

        // 3. Create Authority (refs Credential + WS URL)
        const authorityName = `smoke-authority-${timestamp}`;
        const authority = await authorityUtils.createAuthority(api, {
            name: authorityName,
            connectorUuid: ejbcaResult.connector.uuid,
            wsUrl: env.smoke.ejbcaWsUrl!,
            credential: { uuid: credential.uuid, name: credential.name },
        });
        authorityUuid = authority.uuid;

        // 4. Create RA Profile + enable
        const raProfileName = `smoke-raprofile-${timestamp}`;
        const raProfile = await raProfileUtils.createRaProfile(api, {
            name: raProfileName,
            authorityUuid: authority.uuid,
            endEntityProfileName: env.smoke.ejbcaEndEntityProfile!,
            certificateProfileName: env.smoke.ejbcaCertificateProfile!,
            caName: env.smoke.ejbcaCaName!,
            usernamePrefix: 'atf-',
        });
        raProfileUuid = raProfile.uuid;
        await raProfileUtils.enableRaProfile(api, authority.uuid, raProfile.uuid);

        // 5. Write state file for the tests + globalTeardown
        writeSmokeState({
            registeredConnectorUuids,
            credentialUuid: credential.uuid, credentialName,
            authorityUuid: authority.uuid, authorityName,
            raProfileUuid: raProfile.uuid, raProfileName,
        });

        logger.info(`globalSetup complete: ${credentialName} → ${authorityName} → ${raProfileName}`);
    } catch (e) {
        logger.error('globalSetup failed, attempting partial cleanup:', e);

        // Reverse dependency order
        if (raProfileUuid && authorityUuid) {
            try { await raProfileUtils.deleteRaProfile(api, authorityUuid, raProfileUuid); }
            catch (err) { logger.warn(`Partial cleanup: deleteRaProfile failed: ${err}`); }
        }
        if (authorityUuid) {
            try { await authorityUtils.deleteAuthority(api, authorityUuid); }
            catch (err) { logger.warn(`Partial cleanup: deleteAuthority failed: ${err}`); }
        }
        if (credentialUuid) {
            try { await credentialUtils.deleteCredential(api, credentialUuid); }
            catch (err) { logger.warn(`Partial cleanup: deleteCredential failed: ${err}`); }
        }
        for (const uuid of registeredConnectorUuids) {
            try { await connectorUtils.deleteConnector(api, uuid); }
            catch (err) { logger.warn(`Partial cleanup: deleteConnector ${uuid} failed: ${err}`); }
        }

        throw e;  // re-throw → Playwright fails all tests
    } finally {
        await api.dispose();
        await baseRequest.dispose();
    }
}
