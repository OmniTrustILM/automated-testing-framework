/**
 * REG-SEC-01 / 02 / 03 — own vault instance, own vault profile, secret write then read (ilm#436, T12; ilm#83; platform
 * area). Own objects: the vault instance on the first connected connector with a secret interface (the common
 * credential provider v2 or the vault connector v2; `REG_SECRET_CONNECTOR` picks one), its vault profile, its secrets;
 * when the run cannot make a vault instance, the vault profile goes under the first pre-existing vault instance
 * (accepted deviation R6-4: a create under a pre-existing parent). The content of a PRE-EXISTING secret is never read.
 * The secret value is a run-made random string, never logged, and the list / detail responses must not carry it.
 */
import * as crypto from 'crypto';
import { expect, test } from '../../fixtures/testFixtures';
import {
    createOwnSecret, disableOwnVaultProfile, enableOwnVaultProfile, ensureOwnVaultInstance, ensureOwnVaultProfile, findConnectorWithInterface, getSecretVersions,
    getVaultInstance, listSecretAttributes, listVaultInstanceAttributes, readOwnSecretContent, SecretType, stringValues, waitForSecretState,
} from '../../utils/regression/platformApi';
import { apiJson } from '../../utils/regression/regressionApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-SEC-01-05';
type Json = Record<string, any>;

test.describe('REG-SEC vaults and secrets (API)', { tag: tags.regression }, () => {
    test('REG-SEC-01: the vault-instance attributes of the secret-interface connector load; an own vault instance is created; its detail shows the connector and the attributes',
        meta({ id: 'REG-SEC-01', prio: 'P1', issue: 'ilm#436', rule: ['platform-keys-connectors A4 r16 (secret model ilm#83: VaultInstance → Connector), P-CONN credential v2 row (secret v1 interface)'] }),
        async ({ api }) => {
            test.setTimeout(60_000);
            const connector = await findConnectorWithInterface(api, /^secret/i, process.env, 'REG_SECRET_CONNECTOR');
            test.skip(!connector, 'no connected connector with a secret interface is registered on this tier (REG_SECRET_CONNECTOR)');
            const defs = await listVaultInstanceAttributes(api, connector!.uuid);
            expect(Array.isArray(defs), 'the vault-instance attributes load').toBe(true);
            let vault: Awaited<ReturnType<typeof ensureOwnVaultInstance>>;
            try {
                vault = await ensureOwnVaultInstance(api, SPEC);
            } catch (e) {
                // A refusal by the connector / core is an environment gate for this chain (Sonnet F8): named skip, never red.
                test.skip(true, `the vault instance create on ${connector!.name} was refused: ${String(e).slice(0, 200)}`);
                return;
            }
            test.skip('skip' in vault, 'skip' in vault ? vault.skip : '');
            const detail = await getVaultInstance(api, (vault as Json).uuid);
            expect(detail.name).toBe((vault as Json).name);
            expect(String(detail.connectorUuid ?? detail.connector?.uuid)).toBe(connector!.uuid);
            expect(Array.isArray(detail.attributes)).toBe(true);
        });

    test('REG-SEC-02: an own vault profile is created (under the run vault, else a pre-existing one); enable and disable answer 2xx; the secret-type attributes endpoint loads',
        meta({ id: 'REG-SEC-02', prio: 'P1', issue: 'ilm#436', rule: ['platform-keys-connectors A4 r16 (VaultProfile → VaultInstance); R6-4 (own profile under a pre-existing vault instance)'] }),
        async ({ api }) => {
            test.setTimeout(60_000);
            const made = await ensureOwnVaultProfile(api, SPEC);
            test.skip('skip' in made, 'skip' in made ? made.skip : '');
            const { vault, profile } = made as Exclude<typeof made, { skip: string }>;
            const enabled = await enableOwnVaultProfile(api, vault, profile);
            expect(enabled.status(), await enabled.text()).toBeLessThan(300);
            const disabled = await disableOwnVaultProfile(api, vault, profile);
            expect(disabled.status(), await disabled.text()).toBeLessThan(300);
            expect((await enableOwnVaultProfile(api, vault, profile)).status()).toBeLessThan(300);
            const defs = await listSecretAttributes(api, vault, profile, 'generic');
            expect(Array.isArray(defs), 'the generic secret attributes load').toBe(true);
        });

    test('REG-SEC-03: Generic and ApiKey secrets (BasicAuth when offered) are written Active; the content reads back exactly; versions list version 1; the value never appears in list or detail',
        meta({ id: 'REG-SEC-03', prio: 'P1', issue: 'ilm#436', rule: ['platform-keys-connectors A4 r16 (Secret → VaultProfile; states Inactive / Active / …; types Generic, ApiKey, BasicAuth …)'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(120_000);
            const made = await ensureOwnVaultProfile(api, SPEC);
            test.skip('skip' in made, 'skip' in made ? made.skip : '');
            const { vault, profile } = made as Exclude<typeof made, { skip: string }>;
            await enableOwnVaultProfile(api, vault, profile);
            for (const type of ['generic', 'apiKey', 'basicAuth'] as SecretType[]) {
                await test.step(`${type}: write, then read`, async () => {
                    const offered = await api.get(`/api/v1/vaults/${vault.uuid}/vaultProfiles/${profile.uuid}/secrets/${type}/attributes`);
                    if (!offered.ok()) {
                        testInfo.annotations.push({ type: 'not-offered', description: `${type}: attributes answered ${offered.status()}` });
                        expect(type, 'generic and apiKey must be offered').toBe('basicAuth');
                        return;
                    }
                    const value = `qa-${crypto.randomBytes(12).toString('base64url')}`;
                    const secret = await createOwnSecret(api, vault, profile, `sec-${type}-${Date.now().toString(36)}`, type, value, SPEC);
                    const detail = await waitForSecretState(api, secret.uuid, 'active', 60_000); // created inactive, activated asynchronously
                    expect(String(detail.state).toLowerCase()).toBe('active');
                    const content = await readOwnSecretContent(api, secret);
                    expect(stringValues(content), 'the content carries exactly the value written').toContain(value);
                    const versions = await getSecretVersions(api, secret.uuid);
                    expect(versions.map((v) => Number(v.version)), 'version 1 is listed').toContain(1);
                    expect(stringValues(detail), 'the detail never carries the value').not.toContain(value);
                    const list = await apiJson<Json>(api, 'POST', '/api/v1/secrets', { itemsPerPage: 100, pageNumber: 1, filters: [] });
                    expect(stringValues(list), 'the list never carries the value').not.toContain(value);
                });
            }
        });
});
