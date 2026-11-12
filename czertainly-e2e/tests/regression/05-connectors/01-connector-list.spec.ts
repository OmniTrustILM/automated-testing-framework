/**
 * REG-CONN-01, REG-CONN-02 — The connector list, live and read-only (release checklist: Connectors). ilm#436.
 *
 * WHAT: 1. For each expected connector (credential v1 and v2, keystore entity, x509 compliance, Vault v1 and v2, OTPKI,
 *          Cryptosense, EJBCA-NG, Network Discovery v1 and v2, Software Cryptography v1 and v2, MS-ADCS v2; REG-CONN-01, one test
 *          each) that is registered → stored as connected (never failed), offers its function groups and kinds or its interfaces,
 *          and answers its live health check by interface version.
 *       2. The Basic credential form (REG-CONN-02) → loads with a username and a password field and no callback.
 *       3. Attribute callbacks (test.fixme) → answered through core, persisting nothing.
 * WHY: a connector that is stored as connected but does not answer its health, or has lost a function group, breaks every flow
 *      built on it. v1 health ok means UP and v2 means HealthInfo UP; core never sets failed.
 * HOW: read-only. A row is matched by what a connector offers (a name hint only tells two connectors of one interface apart); a row
 *      whose connector is not registered is skipped by name (the rows added for EJBCA-NG, Network Discovery, Software Cryptography and
 *      MS-ADCS declare it as a need that is decided from the connector list before the test body runs), and one that is offline is skipped as an environment gate (a read before any
 *      assertion). The callback test stays fixme until the guard allows a read-only callback probe on a pre-existing connector.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { describeHealth, healthByVersion } from '../../../utils/regression/platform/connectorApi';
import { CONNECTOR_SPECS, featuresByInterface, findRegisteredConnector, groupsOf, interfaceCodes, type ConnectorSpec } from '../../../utils/regression/platform/connectorKinds';
import { listCredentialAttributes } from '../../../utils/regression/config/authorities';
import { apiJson } from '../../../utils/regression/apiReads';
import { testMeta, tags, type Needs } from '../../../utils/regression/tags';
import type { AttributeDefinition } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import type { JsonObject } from '../../../utils/regression/json';
import { CONNECTOR_FORM_MS, CONNECTOR_READ_TEST_MS, CONNECTOR_WRITE_TEST_MS } from '../../../utils/regression/timeouts';

interface ConnRow extends ConnectorSpec {
    id: string;
    title: string;
    /** The needs the row declares besides `connector-online`: the connector must be registered on the tier. */
    needs?: Needs[];
}

/** The expected connectors of the platform. */
const P_CONN: ConnRow[] = [
    { id: 'credential-v1', title: 'Common Credential Provider v1 (credentialProvider: SoftKeyStore, Basic, ApiKey)', version: 1, functionGroups: { credentialProvider: ['SoftKeyStore', 'Basic', 'ApiKey'] } },
    { id: 'credential-v2', title: 'Common Credential Provider v2 (info, health, metrics, attributes, secret)', version: 2, interfaces: ['info', 'health', 'metrics', 'attributes', 'secret'], name: /credential/i },
    { id: 'keystore-entity', title: 'Keystore Entity Provider (entityProvider: Keystore)', version: 1, functionGroups: { entityProvider: ['Keystore'] } },
    { id: 'x509-compliance', title: 'X509 Compliance Provider (complianceProvider: x509)', version: 1, functionGroups: { complianceProvider: ['x509'] } },
    { id: 'vault-v1', title: 'HashiCorp Vault Connector v1 (discoveryProvider + authorityProvider: HVault)', version: 1, functionGroups: { discoveryProvider: ['HVault'], authorityProvider: ['HVault'] } },
    { id: 'vault-v2', title: 'HashiCorp Vault Connector v2 (info, health, metrics, secret)', version: 2, interfaces: ['info', 'health', 'metrics', 'secret'], name: /vault/i },
    { id: 'otpki', title: 'OTPKI Connector (v2: info, health, metrics, authority, attributes)', version: 2, interfaces: ['info', 'health', 'metrics', 'authority', 'attributes'], name: /otpki/i },
    { id: 'ejbca-ng', title: 'EJBCA-NG Connector (authorityProvider: EJBCA)', ...CONNECTOR_SPECS.ejbca, needs: ['ejbca-connector'] },
    { id: 'network-discovery-v1', title: 'Network Discovery Provider v1 (discoveryProvider: IP-Hostname)', ...CONNECTOR_SPECS['network-discovery-v1'], needs: ['v1-discovery'] },
    { id: 'network-discovery-v2', title: 'Network Discovery Provider v2 (info, health, discovery)', ...CONNECTOR_SPECS['network-discovery-v2'], needs: ['v2-discovery'] },
    { id: 'software-cryptography-v1', title: 'Software Cryptography Provider v1 (cryptographyProvider: SOFT)', ...CONNECTOR_SPECS['software-cryptography-v1'], needs: ['crypto-v1'] },
    { id: 'software-cryptography-v2', title: 'Software Cryptography Provider v2 (info, health, metrics, cryptography)', ...CONNECTOR_SPECS['software-cryptography-v2'], needs: ['crypto-v2'] },
    { id: 'adcs-v2', title: 'MS-ADCS-NG Connector v2 (info, health, metrics, authority, attributes)', ...CONNECTOR_SPECS['adcs-v2'], needs: ['adcs-connector'] },
    { id: 'cryptosense', title: 'Cryptosense Discovery Provider (discoveryProvider: Cryptosense)', version: 1, functionGroups: { discoveryProvider: ['Cryptosense'] } },
];

/** The registered connector matching an expected row (its v2 detail), or undefined. */
const findRow = (api: Parameters<typeof findRegisteredConnector>[0], row: ConnectorSpec) => findRegisteredConnector(api, row);

test.describe('Connector inventory (read-only)', { tag: tags.regression }, () => {
    for (const row of P_CONN) {
        test(`the ${row.title.replace(/ \(.*\)$/, '')} is connected, offers its functions and is healthy`,
            testMeta({
                id: 'REG-CONN-01', row: row.id, prio: 'P2', issue: 'ilm#436', needs: row.needs ? ['connector-online', ...row.needs] : 'connector-online',
                rule: ['health mapping by version: v1 ok → UP, v2 HealthInfo UP; core never sets failed; "status OK" = connected + live health'],
            }),
            async ({ api }, testInfo) => {
                test.setTimeout(CONNECTOR_READ_TEST_MS);
                const found = await test.step('Find the registered connector by its function groups / interfaces', async () => findRow(api, row));
                test.skip(!found, `expected connector ${row.id} is not registered on this tier (no connector with its function groups / interfaces): not coverage`);
                const { list, detail } = found!;
                // A connector that is down on this tier is an environment gate, not a regression (stored status `offline`);
                // `failed` (never set by core) and any other status stay red. Both gates are reads of the list, before any assertion.
                test.skip(list.status === 'offline', `connector ${list.name} is offline on this tier (@needs:connector-online): DevOps brings it up`);
                testInfo.annotations.push({ type: 'connector', description: `${row.id} → ${list.name}` });
                await test.step('Stored status connected (never failed)', async () => {
                    expect(list.status, 'stored status').toBe('connected');
                    expect(list.status).not.toBe('failed');
                });
                await test.step('Function groups and kinds, or interfaces, as expected', async () => {
                    const features = featuresByInterface(detail);
                    const offered = Object.entries(features).filter(([, list]) => list.length).map(([code, list]) => `${code}: ${list.join(', ')}`);
                    if (offered.length) testInfo.annotations.push({ type: 'features', description: `${row.id} → ${offered.join('; ')}` });
                    if (row.functionGroups) {
                        const groups = groupsOf(detail);
                        for (const [code, kinds] of Object.entries(row.functionGroups)) expect(groups[code], `${code} kinds`).toEqual(expect.arrayContaining([...kinds].sort()));
                    } else {
                        expect(interfaceCodes(detail)).toEqual(expect.arrayContaining(row.interfaces!));
                    }
                });
                await test.step('Live health by interface version', async () => {
                    const health = await healthByVersion(api, list);
                    if (row.version) expect(health.version).toBe(row.version);
                    expect(health.healthy, describeHealth(health)).toBe(true);
                });
            });
    }

    test('the Basic credential form loads without any callback',
        testMeta({ id: 'REG-CONN-02', row: 'static-form', prio: 'P2', issue: 'ilm#436', rule: ['callback dispatch by declaration shape: a static form has no callbackContext / dependsOn; keyStoreType is a static list'] }),
        async ({ api }) => {
            test.setTimeout(CONNECTOR_FORM_MS);
            const found = await findRow(api, P_CONN[0]);
            test.skip(!found, 'the credential provider v1 is not registered on this tier: not coverage');
            const defs = await listCredentialAttributes(api, found!.list.uuid, 'Basic');
            // The Basic form is a username and a password: the two fields an own credential is filled from.
            expect(defs.some((d) => /user/i.test(d.name)), `a username field in ${defs.map((d) => d.name).join(', ')}`).toBe(true);
            expect(defs.some((d) => /pass/i.test(d.name)), `a password field in ${defs.map((d) => d.name).join(', ')}`).toBe(true);
            expect(defs.filter((d) => d.attributeCallback || (d as AttributeDefinition & { callback?: unknown }).callback), 'no callback in a static form').toEqual([]);
        });

    test.fixme('attribute callbacks answer through core and persist nothing',
        testMeta({ id: 'REG-CONN-02', row: 'callbacks', prio: 'P2', issue: 'ilm#436', rule: ['callbackContext = legacy path forwarded with the free-form body; dependsOn = NG shared POST /v2/attributes/callback; core/getCredentials answered by core'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(CONNECTOR_WRITE_TEST_MS);
            testInfo.annotations.push({ type: 'fixme', description: 'pending guard change: the callback POSTs on pre-existing connectors are ownership-refused (core stores attribute definitions); a read-only callback probe is requested' });
            const keystore = await findRow(api, P_CONN[2]);
            if (keystore) {
                const defs = await apiJson<JsonObject[]>(api, 'GET', `/api/v1/connectors/${keystore.list.uuid}/attributes/entityProvider/Keystore`);
                const credential = defs.find((d) => d.name === 'credential');
                expect(credential?.attributeCallback ?? credential?.callback, 'the entity credential attribute declares a callback').toBeTruthy();
                const res = await api.post(`/api/v1/connectors/${keystore.list.uuid}/entityProvider/Keystore/callback`, {
                    data: { uuid: credential!.uuid, name: 'credential', pathVariables: { credentialKind: 'Basic' }, queryParameters: {}, requestBody: {} },
                });
                expect(res.status(), await res.text()).toBe(200);
                expect(Array.isArray(await res.json())).toBe(true);
            }
            const otpki = await findRow(api, P_CONN[6]);
            if (otpki) {
                const res = await api.post(`/api/v2/connectors/${otpki.list.uuid}/callback`, { data: { name: 'endEntityProfile', pathVariables: {}, queryParameters: {}, requestBody: {} } });
                expect(res.status(), await res.text()).toBe(200);
            }
        });
});
