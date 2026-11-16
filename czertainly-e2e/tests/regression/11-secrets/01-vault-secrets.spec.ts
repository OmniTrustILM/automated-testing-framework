/**
 * REG-SEC-01, REG-SEC-02, REG-SEC-03 — vault instance, vault profile and secrets on own parents only (ilm#436, ilm#83).
 * The secret value must round-trip exactly and never appear in a list or a detail; it is never logged.
 */
import * as crypto from 'crypto';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { findConnectorWithInterface } from '../../../utils/regression/platform/connectorLookup';
import { findVaultConnector } from '../../../utils/regression/platform/connectorKinds';
import { copiedVaultAttributes, createOwnSecret, enableOwnSecret, createOwnVaultInstance, disableOwnVaultProfile, enableOwnVaultProfile, createOwnVaultProfile, getSecretVersions, getVaultInstance, listSecretAttributes, listVaultInstanceAttributes, readOwnSecretContent, SecretType, stringValues, waitForSecretState } from '../../../utils/regression/platform/secretsAndVaults';
import { apiJson } from '../../../utils/regression/apiReads';
import { testMeta, tags, type Needs } from '../../../utils/regression/tags';
import type { JsonObject } from '../../../utils/regression/json';
import { CONNECTOR_READ_TEST_MS, CONNECTOR_WRITE_TEST_MS, SECRET_ACTIVE_MS } from '../../../utils/regression/timeouts';


interface Target {
    /** The table row of a target that is not the default secret connector. */
    row?: string;
    needs?: Needs;
    where: string;
    find: (api: Parameters<typeof findConnectorWithInterface>[0]) => Promise<{ uuid: string; name: string; interfaceUuid: string } | undefined>;
    reason: string;
}

/** The secret connector the rows run on: the one the tier offers by interface, and the HashiCorp Vault connector when it is another. */
const TARGETS: Target[] = [
    { where: 'the secret connector', find: (api) => findConnectorWithInterface(api, /^secret/i), reason: 'no connected connector with a secret interface is registered on this tier (REG_SECRET_CONNECTOR)' },
    { row: 'vault-connector', needs: 'vault-connector', where: 'the HashiCorp Vault connector', find: (api) => findVaultConnector(api), reason: 'no connected HashiCorp Vault connector with a secret interface is registered on this tier' },
];

test.describe('Vaults and secrets (API)', { tag: tags.regression }, () => {
    /** The connector of a target, or the test skips with the named reason (reads only; before any write). */
    async function connectorOf(api: Parameters<typeof findConnectorWithInterface>[0], target: Target) {
        const connector = await target.find(api);
        test.skip(!connector, target.reason);
        if (target.row) {
            const first = await findConnectorWithInterface(api, /^secret/i);
            test.skip(first?.uuid === connector!.uuid, 'the Vault connector is the secret connector the first rows already used (REG_SECRET_CONNECTOR)');
            const address = await copiedVaultAttributes(api, connector!.uuid);
            test.skip(!address, 'no vault instance on the Vault connector to copy a real Vault address from (it refuses an invented one)');
        }
        return connector!;
    }

    for (const target of TARGETS) {
        test(`an own vault instance is created on ${target.where} and shows its attributes`,
            testMeta({ id: 'REG-SEC-01', ...(target.row ? { row: target.row } : {}), ...(target.needs ? { needs: target.needs } : {}), prio: 'P2', issue: 'ilm#436', rule: ['secret model ilm#83: VaultInstance → Connector (secret v1 interface)'] }),
            async ({ api, own }) => {
                test.setTimeout(CONNECTOR_READ_TEST_MS);
                const connector = await connectorOf(api, target);
                const defs = await listVaultInstanceAttributes(api, connector.uuid);
                expect(Array.isArray(defs), 'the vault-instance attributes load').toBe(true);
                // The gates above are reads (the connector, its attribute definitions). From here on a refused create is the
                // behaviour under test and FAILS the test with the platform's answer: the create is not wrapped in a skip.
                const vault = await createOwnVaultInstance(api, own.spec, 'vault', { connector });
                const detail = await getVaultInstance(api, vault.uuid);
                expect(detail.name).toBe(vault.name);
                expect(String(detail.connectorUuid ?? (detail.connector as JsonObject | undefined)?.uuid)).toBe(connector.uuid);
                expect(Array.isArray(detail.attributes)).toBe(true);
            });

        test(`an own vault profile is created, enabled and disabled on ${target.where}`,
            testMeta({ id: 'REG-SEC-02', ...(target.row ? { row: target.row } : {}), ...(target.needs ? { needs: target.needs } : {}), prio: 'P2', issue: 'ilm#436', rule: ['secret model ilm#83: VaultProfile → VaultInstance (an own profile under an own vault instance)'] }),
            async ({ api, own }) => {
                test.setTimeout(CONNECTOR_READ_TEST_MS);
                const connector = await connectorOf(api, target);
                // The gate above is a read; from here a refused create is the behaviour under test and fails the test.
                const vault = await createOwnVaultInstance(api, own.spec, 'vault', { connector });
                const profile = await createOwnVaultProfile(api, own.spec, 'vp', { vault });
                const enabled = await enableOwnVaultProfile(api, vault, profile);
                expect(enabled.status(), await enabled.text()).toBeLessThan(300);
                const disabled = await disableOwnVaultProfile(api, vault, profile);
                expect(disabled.status(), await disabled.text()).toBeLessThan(300);
                expect((await enableOwnVaultProfile(api, vault, profile)).status()).toBeLessThan(300);
                const defs = await listSecretAttributes(api, vault, profile, 'generic');
                expect(Array.isArray(defs), 'the generic secret attributes load').toBe(true);
            });

        test(`own secrets become active, read back and stay out of lists on ${target.where}`,
            testMeta({ id: 'REG-SEC-03', ...(target.row ? { row: target.row } : {}), ...(target.needs ? { needs: target.needs } : {}), prio: 'P2', issue: 'ilm#436', rule: ['secret model ilm#83: Secret → VaultProfile (states Inactive / Active / …; types Generic, ApiKey, BasicAuth …)'] }),
            async ({ api, own }, testInfo) => {
                test.setTimeout(CONNECTOR_WRITE_TEST_MS);
                const connector = await connectorOf(api, target);
                // The gate above is a read; from here a refused create is the behaviour under test and fails the test.
                const vault = await createOwnVaultInstance(api, own.spec, 'vault', { connector });
                const profile = await createOwnVaultProfile(api, own.spec, 'vp', { vault });
                await enableOwnVaultProfile(api, vault, profile);
                for (const type of ['generic', 'apiKey', 'basicAuth'] as SecretType[]) {
                    await test.step(`${type}: write, then read`, async () => {
                        const offered = await api.get(`/api/v1/vaults/${vault.uuid}/vaultProfiles/${profile.uuid}/secrets/${type}/attributes`);
                        if (!offered.ok()) {
                            testInfo.annotations.push({ type: 'not-offered', description: `${type}: attributes answered ${offered.status()}` });
                            // A connector may leave out basicAuth; generic and apiKey must be offered.
                            if (type !== 'basicAuth') throw new Error(`${type} must be offered (its attributes answered ${offered.status()})`);
                            return;
                        }
                        const value = `qa-${crypto.randomBytes(12).toString('base64url')}`;
                        const secret = await createOwnSecret(api, own.spec, `sec-${type}`, { vault, profile, type, value });
                        const detail = await waitForSecretState(api, secret.uuid, 'active', SECRET_ACTIVE_MS); // created inactive, activated asynchronously
                        expect(String(detail.state).toLowerCase()).toBe('active');
                        // A secret's content is read only once it is enabled (a separate action from its activation).
                        expect((await enableOwnSecret(api, secret)).enabled, 'the own secret is enabled').toBe(true);
                        const content = await readOwnSecretContent(api, secret);
                        expect(stringValues(content), 'the content carries exactly the value written').toContain(value);
                        const versions = await getSecretVersions(api, secret.uuid);
                        expect(versions.map((v) => Number(v.version)), 'version 1 is listed').toContain(1);
                        expect(stringValues(detail), 'the detail never carries the value').not.toContain(value);
                        const list = await apiJson<JsonObject>(api, 'POST', '/api/v1/secrets', { itemsPerPage: 100, pageNumber: 1, filters: [] });
                        expect(stringValues(list), 'the list never carries the value').not.toContain(value);
                    });
                }
            });
    }
});
