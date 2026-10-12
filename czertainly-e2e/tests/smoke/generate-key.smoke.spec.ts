/**
 * SMK-006 — generate a key through the UI and check its state and details.
 *
 * WHAT: on a fresh SOFT token and Token Profile, a user creates an RSA-2048 key pair in Create
 * Key. The test passes when the platform opens the new key's detail page with the requested name,
 * profile and attributes, both key items are RSA and Active, and enabling the key turns both
 * items Enabled.
 *
 * WHY: generating a key is the entry point of the Keys module and goes all the way to the
 * cryptography provider: the form is built from the provider's attribute definitions (the RSA
 * size appears only after RSA is chosen), and the key material is created in the token.
 *
 * HOW: the token and profile are preconditions, so they are created through the API on the
 * Software Cryptography Provider (approved first if it is waiting). The key is created and
 * checked through the UI. afterEach removes, by UUID, the keys on this run's token, then the
 * profile, then the token; anything that will not go is recorded in the cleanup ledger.
 * A key is created Disabled (the form has no switch for it), which the test checks before
 * enabling it.
 */

import { APIRequestContext } from '@playwright/test';
import { test, expect, loginAsSmokeUser, getAuthenticatedApiContext } from '../../fixtures/testFixtures';
import { KeyPage } from '../../pages/KeyPage';
import * as connectorUtils from '../../utils/connectorUtils';
import * as tokenUtils from '../../utils/tokenUtils';
import { attemptCleanup } from '../../utils/cleanupLedger';
import { readSmokeState } from '../../utils/smokeState';
import { Logger } from '../../utils/Logger';

const logger = new Logger('GenerateKeySmokeTest');

/** The Software Cryptography Provider, approved if it waits for approval. */
async function softCryptoConnectorUuid(api: APIRequestContext): Promise<string> {
    const connectors = await connectorUtils.getAllConnectors(api) as Array<connectorUtils.ConnectorDto & {
        functionGroups?: Array<{ kinds?: string[] }>;
    }>;
    const soft = connectors.find((c) => (c.functionGroups ?? []).some((g) => (g.kinds ?? []).includes('SOFT')));
    if (!soft) {
        throw new Error(`No connector offers kind SOFT. Connectors: ${connectors.map((c) => `${c.name} (${c.status})`).join(', ')}`);
    }
    if (soft.status !== 'connected') {
        logger.info(`Connector ${soft.name} is ${soft.status}, approving`);
        await connectorUtils.approveConnector(api, soft.uuid);
    }
    return soft.uuid;
}

test.describe('@smoke keys', () => {
    // What this run created, so afterEach removes exactly that.
    let tokenUuid: string | undefined;
    let profileUuid: string | undefined;

    test.afterEach(async ({ request, env }) => {
        if (!tokenUuid) return;
        const token = tokenUuid;
        const api = await getAuthenticatedApiContext(request, env);
        try {
            // Keys first: a profile or token that still holds keys cannot be deleted.
            let keys: string[] = [];
            await attemptCleanup({ resource: 'key', name: `keys on token ${token}` },
                async () => { keys = await tokenUtils.listKeyUuidsOnToken(api, token); });
            for (const key of keys) {
                await attemptCleanup({ resource: 'key', uuid: key }, async () => {
                    const resp = await api.delete('/api/v1/keys', { data: [key] });
                    if (!resp.ok() && resp.status() !== 404) throw new Error(`Delete key ${key} failed: ${resp.status()} - ${await resp.text()}`);
                });
            }
            if (profileUuid) {
                const profile = profileUuid;
                await attemptCleanup({ resource: 'tokenProfile', uuid: profile },
                    () => tokenUtils.deleteTokenProfile(api, { tokenInstanceUuid: token, uuid: profile }));
            }
            await attemptCleanup({ resource: 'tokenInstance', uuid: token },
                () => tokenUtils.deleteTokenInstance(api, token), { blockedBy: profileUuid && `tokenProfile ${profileUuid}` });
        } finally {
            await api.dispose();
            tokenUuid = undefined;
            profileUuid = undefined;
        }
    });

    test('SMK-006: generate key and verify state and details', async ({ page, request, env }) => {
        test.skip(!readSmokeState(), 'Smoke fixtures not provisioned (env vars missing) — globalSetup skipped');

        const ts = Date.now();
        // The provider's token name rule: a letter first, letters, digits and single underscores.
        const tokenName = `smk006_${ts}`;
        const profileName = `smk006-profile-${ts}`;
        const keyName = `smk006-key-${ts}`;
        const alias = `smk006alias${ts}`;
        let tokenProfileName = '';

        await test.step('Setup: SOFT token and Token Profile via API', async () => {
            const api = await getAuthenticatedApiContext(request, env);
            try {
                const connectorUuid = await softCryptoConnectorUuid(api);
                const token = await tokenUtils.createSoftTokenInstance(api, {
                    connectorUuid, name: tokenName, activationCode: `smk006-${ts}`,
                });
                tokenUuid = token.uuid;
                const profile = await tokenUtils.createTokenProfile(api, { tokenInstanceUuid: token.uuid, name: profileName });
                profileUuid = profile.uuid;
                tokenProfileName = profile.name;
            } finally {
                await api.dispose();
            }
        });

        const keyPage = new KeyPage(page);
        await loginAsSmokeUser(page, env);

        await test.step('Create an RSA-2048 key pair in Create Key', async () => {
            await keyPage.goToList();
            await keyPage.openCreateModal();
            await keyPage.fillRsaKeyPair({ name: keyName, tokenProfileName, alias, rsaSize: '2048' });
            await keyPage.submit();
        });

        await test.step('Detail page shows the key on our token and profile', async () => {
            await expect(keyPage.row('name')).toContainText(keyName);
            await expect(keyPage.row('tokenName')).toContainText(tokenName);
            await expect(keyPage.row('tokenProfileName')).toContainText(profileName);
        });

        await test.step('Key attributes carry the requested algorithm, size and alias', async () => {
            // Rows are keyed by the provider's attribute UUIDs, so they are matched by label instead.
            const attributes = keyPage.main.locator('tr').filter({ hasText: /^Cryptographic Key Algorithm|^RSA Key Size|^Cryptographic Key Alias/ });
            await expect(attributes.filter({ hasText: 'RSA Key Size' })).toContainText('2048');
            await expect(attributes.filter({ hasText: 'Cryptographic Key Algorithm' })).toContainText('RSA');
            await expect(attributes.filter({ hasText: 'Cryptographic Key Alias' })).toContainText(alias);
        });

        for (const item of ['Public key', 'Private key'] as const) {
            await test.step(`${item}: RSA, Active, created Disabled`, async () => {
                await keyPage.openKeyItem(item);
                await expect(keyPage.itemRow('Type')).toContainText(item);
                await expect(keyPage.itemRow('keyAlgorithm')).toContainText('RSA');
                await expect(keyPage.itemRow('state')).toContainText('Active');
                await expect(keyPage.itemRow('enabled')).toContainText('Disabled');
            });
        }

        await test.step('Enabling the key enables both items', async () => {
            await keyPage.enableKey();
            for (const item of ['Public key', 'Private key'] as const) {
                await keyPage.openKeyItem(item);
                await expect(keyPage.itemRow('enabled')).toContainText('Enabled', { timeout: 10_000 });
                await expect(keyPage.itemRow('state')).toContainText('Active');
            }
        });
    });
});
