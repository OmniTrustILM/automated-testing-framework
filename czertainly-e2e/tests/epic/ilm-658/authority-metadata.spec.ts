/**
 * authority-metadata — Epic ilm#658: the ACME account an ACME authority's connection check returns as authority metadata.
 * Runs against Let's Encrypt staging: saving the authority registers an account there, no certificate is ordered.
 * Needs a connected acme-connector (`ACME_CONNECTOR_NAME`, default: the first connector named like "acme") and an enabled vault profile
 * for the account keys (`ACME_VAULT_PROFILE_NAME`, default: the first enabled one). A connector answering 204 is covered in Core's tests.
 */
import type { APIRequestContext } from '@playwright/test';
import { AuthorityPage } from '../../../pages/AuthorityPage';
import { expect, getAuthenticatedApiContext, loginAsSmokeUser, test } from '../../../fixtures/testFixtures';
import { recordCleanupFailure, statusOf } from '../../../utils/cleanupLedger';
import { Json, send, sendOk } from '../../../utils/epicOwnership';
import {
    ACCOUNT_THUMBPRINT, ACCOUNT_URL, AccountKey, AcmeConnector, acmeAuthorityAttributes, attributeValue, createAccountKey, deleteAccountKey,
    findAcmeConnector, findVaultProfile, LE_STAGING_DIRECTORY, metadataCount, metadataValues, MISSING_DIRECTORY, saveAuthority,
} from '../../../utils/epicAuthorityMetadata';
import { requiredCustomAttributes } from '../../../utils/regression/customAttributes';
import { uniqueName } from '../../../utils/names';

const TAGS = ['@epic-658', '@regression'];
/** Each save waits for the connector's check against LE staging (up to 90 s). */
const TEST_TIMEOUT_MS = 480_000;
const LE_STAGING_ACCOUNT = /^https:\/\/acme-staging-v02\.api\.letsencrypt\.org\/acme\/acct\/\d+$/;

// A trace records request bodies, and the account key secrets carry private keys.
test.use({ trace: 'off' });

test.describe('@epic-658 authority metadata', () => {
    test.describe.configure({ timeout: TEST_TIMEOUT_MS });

    let authorityUuid: string | undefined;
    const keys: AccountKey[] = [];

    test.afterEach(async ({ request, env }) => {
        const api = await getAuthenticatedApiContext(request, env);
        try {
            if (authorityUuid) {
                try {
                    const answer = await send(api, 'DELETE', `/api/v1/authorities/${authorityUuid}`);
                    if (answer.status !== 404 && (answer.status < 200 || answer.status >= 300)) {
                        recordCleanupFailure({ resource: 'authorities', uuid: authorityUuid, status: answer.status, message: answer.text.slice(0, 300) });
                    }
                } catch (e) {
                    recordCleanupFailure({ resource: 'authorities', uuid: authorityUuid, status: statusOf(e), message: String(e) });
                }
            }
            for (const key of keys) {
                try {
                    await deleteAccountKey(api, key.uuid);
                } catch (e) {
                    recordCleanupFailure({ resource: 'secrets', uuid: key.uuid, name: key.name, status: statusOf(e), message: String(e) });
                }
            }
        } finally {
            authorityUuid = undefined;
            keys.length = 0;
            await api.dispose();
        }
    });

    test('S1-S4: create, edit with a new key, failed edit and delete of an ACME authority', { tag: TAGS }, async ({ page, request, env }) => {
        const run = uniqueName('atf-e658').toLowerCase();
        const api: APIRequestContext = await getAuthenticatedApiContext(request, env, { minLifetimeMs: TEST_TIMEOUT_MS });
        try {
            const connector = await findAcmeConnector(api, process.env.ACME_CONNECTOR_NAME || undefined);
            expect(connector, 'a connected acme-connector with a v3 authority interface (ACME_CONNECTOR_NAME)').toBeDefined();
            const vault = await findVaultProfile(api, process.env.ACME_VAULT_PROFILE_NAME || undefined);
            expect(vault, 'an enabled vault profile for the account keys (ACME_VAULT_PROFILE_NAME)').toBeDefined();
            const acme = connector as AcmeConnector;
            const customAttributes = await requiredCustomAttributes(api, 'authorities', 'qa');
            const read = async (): Promise<Json> => (await sendOk(api, 'GET', `/api/v1/authorities/${authorityUuid}`)).json as Json;
            const edit = (directoryUrl: string, key: AccountKey) =>
                saveAuthority(api, 'PUT', `/api/v1/authorities/${authorityUuid}`, { attributes: acmeAuthorityAttributes(directoryUrl, key), customAttributes });
            const newKey = (suffix: string): Promise<AccountKey> => createAccountKey(api, vault!, `${run}-${suffix}`, (key) => keys.push(key));

            const key1 = await newKey('key-1');
            let accountUrl = '';

            await test.step('S1: create shows the account URL and thumbprint (API and UI)', async () => {
                const created = await saveAuthority(api, 'POST', '/api/v1/authorities', {
                    name: run, connectorUuid: acme.uuid, interfaceUuid: acme.interfaceUuid,
                    attributes: acmeAuthorityAttributes(LE_STAGING_DIRECTORY, key1), customAttributes,
                });
                const createdUuid = (created.json as Json | undefined)?.uuid;
                if (createdUuid) authorityUuid = String(createdUuid);
                expect(created.status, `the create: ${created.text.slice(0, 300)}`).toBe(201);

                const detail = await read();
                const values = metadataValues(detail, acme.uuid);
                accountUrl = String(values[ACCOUNT_URL]);
                expect(accountUrl, 'the account URL').toMatch(LE_STAGING_ACCOUNT);
                expect(values[ACCOUNT_THUMBPRINT], 'the thumbprint of key 1').toBe(key1.thumbprint);
                expect(((detail.metadata ?? []) as Json[]).find((m) => m.connectorUuid === acme.uuid)?.connectorName).toBe(acme.name);

                const authorities = new AuthorityPage(page);
                await loginAsSmokeUser(page, env);
                await authorities.openDetail(String(authorityUuid));
                await expect(authorities.metadataWidget()).toBeVisible();
                const dialog = await authorities.openConnectorMetadata(acme.name);
                await expect(dialog).toContainText(accountUrl);
                await expect(dialog).toContainText(key1.thumbprint);
            });

            const key2 = await newKey('key-2');
            await test.step('S2: an edit with a new account key changes the thumbprint', async () => {
                const answer = await edit(LE_STAGING_DIRECTORY, key2);
                expect(answer.status, `the edit: ${answer.text.slice(0, 300)}`).toBe(200);
                const detail = await read();
                const values = metadataValues(detail, acme.uuid);
                expect(values[ACCOUNT_THUMBPRINT], 'the thumbprint of key 2').toBe(key2.thumbprint);
                expect(values[ACCOUNT_THUMBPRINT]).not.toBe(key1.thumbprint);
                expect(values[ACCOUNT_URL], 'a new key registers a new account').toMatch(LE_STAGING_ACCOUNT);
                expect(values[ACCOUNT_URL], 'the account URL of key 2').not.toBe(accountUrl);
                expect(metadataValues(answer.json as Json, acme.uuid), 'the edit answer carries the same metadata').toEqual(values);
                expect(metadataCount(detail, ACCOUNT_URL), 'the set is replaced, not appended').toBe(1);
                expect(metadataCount(detail, ACCOUNT_THUMBPRINT)).toBe(1);
            });

            await test.step('S3: a failed check on edit keeps the attributes and the metadata', async () => {
                const before = await read();
                const answer = await edit(MISSING_DIRECTORY, key1);
                expect(answer.status, `the edit with a directory that answers 404: ${answer.text.slice(0, 300)}`).toBe(502);
                expect(answer.text, 'the refusal names the failed directory read').toMatch(/ACME directory/);
                const after = await read();
                expect(after.metadata, 'the metadata').toEqual(before.metadata);
                expect(attributeValue(after, 'data_directoryUrl')).toBe(LE_STAGING_DIRECTORY);
                expect(attributeValue(after, 'data_accountKey')).toEqual(expect.objectContaining({ uuid: key2.uuid }));
            });

            await test.step('S4: delete removes the authority and its metadata from every read', async () => {
                const answer = await send(api, 'DELETE', `/api/v1/authorities/${authorityUuid}`);
                expect(answer.status, `the delete: ${answer.text.slice(0, 300)}`).toBe(204);
                const gone = await send(api, 'GET', `/api/v1/authorities/${authorityUuid}`);
                expect(gone.status, 'the deleted authority').toBe(404);
                const list = (await sendOk(api, 'GET', '/api/v1/authorities')).json as Json[];
                expect(list.some((a) => a.uuid === authorityUuid), 'the authority list').toBe(false);
                authorityUuid = undefined;
            });
        } finally {
            await api.dispose();
        }
    });
});
