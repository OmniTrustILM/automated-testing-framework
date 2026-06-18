/**
 * Playwright globalSetup for SMK-004.
 *
 * Runs ONCE before any tests. If SMK-004 env vars are all present, provisions
 * the per-run PKI chain via Core REST API:
 *   1. Authenticates to Keycloak → APIRequestContext with Bearer token
 *   2. Looks up EJBCA + Credential connectors by name
 *   3. Creates Credential (from P12 in env), Authority, RA Profile (+ enable)
 *   4. Writes UUIDs to .smoke-state.json for the test + globalTeardown
 *
 * If env vars are missing → silently skip (no-op). SMK-004 test then skips itself.
 * If any creation step fails → best-effort cleanup of partial state, then re-throw
 * (causes Playwright to fail all tests, which is correct — env is broken).
 */

import { FullConfig, request as playwrightRequest } from '@playwright/test';
import { loadEnv } from './utils/env';
import { getAuthenticatedApiContext } from './fixtures/testFixtures';
import * as connectorUtils from './utils/connectorUtils';
import * as credentialUtils from './utils/credentialUtils';
import * as authorityUtils from './utils/authorityUtils';
import * as raProfileUtils from './utils/raProfileUtils';
import { writeSmokeState } from './utils/smokeState';
import { Logger } from './utils/Logger';

const logger = new Logger('GlobalSetup');

export default async function globalSetup(_config: FullConfig): Promise<void> {
    const env = loadEnv();

    // SMK-004 needs ALL these vars. If any missing → skip provisioning.
    // SMK-004 test will then skip itself (state file doesn't exist).
    const required: Record<string, string | undefined> = {
        EJBCA_WS_URL: env.ejbcaWsUrl,
        EJBCA_P12_BASE64: env.ejbcaP12Base64,
        EJBCA_P12_PASSWORD: env.ejbcaP12Password,
        EJBCA_CA_NAME: env.ejbcaCaName,
        EJBCA_END_ENTITY_PROFILE: env.ejbcaEndEntityProfile,
        EJBCA_CERTIFICATE_PROFILE: env.ejbcaCertificateProfile,
    };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
        logger.info(`SMK-004 env vars missing: ${missing.join(', ')} — skipping per-run provisioning`);
        return;
    }

    // 1. Build authenticated API context (Keycloak ROPC → Bearer token)
    const baseRequest = await playwrightRequest.newContext({
        baseURL: env.baseUrl,
        ignoreHTTPSErrors: true,
    });
    const api = await getAuthenticatedApiContext(baseRequest, env);

    // Track what we've created — for partial cleanup if next step fails
    let credentialUuid: string | undefined;
    let authorityUuid: string | undefined;
    let raProfileUuid: string | undefined;

    try {
        // 2. Find both connectors by name
        const ejbcaConnector = await connectorUtils.findConnectorByName(api, env.ejbcaConnectorName);
        const credConnector = await connectorUtils.findConnectorByName(api, env.credentialConnectorName);

        const timestamp = Date.now();

        // 3. Create Credential (with P12 + password from env)
        const credentialName = `smoke-credential-${timestamp}`;
        const credential = await credentialUtils.createCredential(api, {
            name: credentialName,
            connectorUuid: credConnector.uuid,
            p12Base64: env.ejbcaP12Base64!,
            password: env.ejbcaP12Password!,
        });
        credentialUuid = credential.uuid;

        // 4. Create Authority (refs Credential + WS URL)
        const authorityName = `smoke-authority-${timestamp}`;
        const authority = await authorityUtils.createAuthority(api, {
            name: authorityName,
            connectorUuid: ejbcaConnector.uuid,
            wsUrl: env.ejbcaWsUrl!,
            credential: { uuid: credential.uuid, name: credential.name },
        });
        authorityUuid = authority.uuid;

        // 5. Create RA Profile + enable
        const raProfileName = `smoke-raprofile-${timestamp}`;
        const raProfile = await raProfileUtils.createRaProfile(api, {
            name: raProfileName,
            authorityUuid: authority.uuid,
            endEntityProfileName: env.ejbcaEndEntityProfile!,
            certificateProfileName: env.ejbcaCertificateProfile!,
            caName: env.ejbcaCaName!,
            usernamePrefix: 'atf-',
        });
        raProfileUuid = raProfile.uuid;
        await raProfileUtils.enableRaProfile(api, authority.uuid, raProfile.uuid);

        // 6. Write state file for the test + globalTeardown
        writeSmokeState({
            credentialUuid: credential.uuid, credentialName,
            authorityUuid: authority.uuid, authorityName,
            raProfileUuid: raProfile.uuid, raProfileName,
        });

        logger.info(`globalSetup complete: ${credentialName} → ${authorityName} → ${raProfileName}`);
    } catch (e) {
        logger.error('globalSetup failed, attempting partial cleanup:', e);

        // Reverse order — RA Profile depends on Authority, Authority depends on Credential
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

        throw e;  // re-throw → Playwright fails all tests
    } finally {
        await api.dispose();
        await baseRequest.dispose();
    }
}
