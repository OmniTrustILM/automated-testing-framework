/**
 * REG-CONN-01 / REG-CONN-02 — the connector inventory, live and read-only (ilm#436, T12; platform area).
 *
 * REG-CONN-01: per P-CONN row registered on the tier: stored status `connected` and never `failed` (core never sets
 * it, A4 §4.3); the v1 function groups and kinds equal the table (the kinds are read from the tier, compared as sets)
 * or the v2 interface codes include the table's; live health by version (v1 `ok`, v2 `UP`) — the plan's "status OK" is
 * the stored flag plus the live health. A row whose connector is not registered skips naming it (not coverage).
 * Rows are matched by function groups / interfaces (and a name hint), never by a hard-coded registration name.
 *
 * REG-CONN-02: `[static-form]` the credential provider's Basic form loads without a callback (a GET of the
 * definitions). `[callbacks]`: the forwarded `callbackContext` (`core/getCredentials` answered by core, the connector
 * callbacks) and the NG `dependsOn` path go through `POST /v1/connectors/{uuid}/{fg}/{kind}/callback` /
 * `POST /v2/connectors/{uuid}/callback` on PRE-EXISTING connectors: core's callback handler stores attribute
 * definitions (B1 author decision 2), so the guard refuses those POSTs by ownership — guard request G-3 (platform
 * area) asks for a read-only callback probe; the test is `test.fixme` with its full body meanwhile.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { connectorVersion, describeHealth, healthByVersion } from '../../utils/regression/connectorApi';
import { listCredentialAttributes } from '../../utils/regression/platformApi';
import { apiJson } from '../../utils/regression/regressionApi';
import { meta, tags } from '../../utils/regression/tags';

type Json = Record<string, any>;

interface ConnRow {
    id: string;
    title: string;
    version: 1 | 2;
    /** v1: function group code → kinds (set equality); v2: interface codes that must be present. */
    functionGroups?: Record<string, string[]>;
    interfaces?: string[];
    /** A name hint to tell the two v2 secret connectors apart. */
    name?: RegExp;
}

/** P-CONN (the test plan §4.8). */
const P_CONN: ConnRow[] = [
    { id: 'credential-v1', title: 'Common Credential Provider v1 (credentialProvider: SoftKeyStore, Basic, ApiKey)', version: 1, functionGroups: { credentialProvider: ['SoftKeyStore', 'Basic', 'ApiKey'] } },
    { id: 'credential-v2', title: 'Common Credential Provider v2 (info, health, metrics, attributes, secret)', version: 2, interfaces: ['info', 'health', 'metrics', 'attributes', 'secret'], name: /credential/i },
    { id: 'keystore-entity', title: 'Keystore Entity Provider (entityProvider: Keystore)', version: 1, functionGroups: { entityProvider: ['Keystore'] } },
    { id: 'x509-compliance', title: 'X509 Compliance Provider (complianceProvider: x509)', version: 1, functionGroups: { complianceProvider: ['x509'] } },
    { id: 'vault-v1', title: 'HashiCorp Vault Connector v1 (discoveryProvider + authorityProvider: HVault)', version: 1, functionGroups: { discoveryProvider: ['HVault'], authorityProvider: ['HVault'] } },
    { id: 'vault-v2', title: 'HashiCorp Vault Connector v2 (info, health, metrics, secret)', version: 2, interfaces: ['info', 'health', 'metrics', 'secret'], name: /vault/i },
    { id: 'otpki', title: 'OTPKI Connector (v2: info, health, metrics, authority, attributes)', version: 2, interfaces: ['info', 'health', 'metrics', 'authority', 'attributes'], name: /otpki/i },
    { id: 'cryptosense', title: 'Cryptosense Discovery Provider (discoveryProvider: Cryptosense)', version: 1, functionGroups: { discoveryProvider: ['Cryptosense'] } },
];

const groupsOf = (detail: Json): Record<string, string[]> =>
    Object.fromEntries(((detail.functionGroups ?? []) as Json[]).map((g) => [String(g.functionGroupCode ?? g.code), ((g.kinds ?? []) as string[]).slice().sort()]));
const interfaceCodes = (detail: Json): string[] => ((detail.interfaces ?? []) as Json[]).map((i) => String(i.code ?? i.name ?? '').toLowerCase());

/** The registered connector matching a P-CONN row (its v2 detail), or undefined. */
async function findRow(api: Parameters<typeof apiJson>[0], row: ConnRow): Promise<{ list: Json; detail: Json } | undefined> {
    const rows = await apiJson<Json[]>(api, 'GET', '/api/v1/connectors');
    for (const r of rows) {
        if (row.name && !row.name.test(String(r.name))) continue;
        const v = await connectorVersion(api, String(r.uuid));
        if (!v.detail || v.version !== row.version) continue;
        if (row.functionGroups) {
            const groups = groupsOf(v.detail);
            if (Object.keys(row.functionGroups).every((code) => groups[code] && row.functionGroups![code].every((k) => groups[code].includes(k)))) return { list: r, detail: v.detail };
        } else if (row.interfaces && row.interfaces.every((c) => interfaceCodes(v.detail!).includes(c))) return { list: r, detail: v.detail };
    }
    return undefined;
}

test.describe('REG-CONN connector inventory (read-only)', { tag: tags.regression }, () => {
    for (const row of P_CONN) {
        test(`REG-CONN-01[${row.id}]: ${row.title}: stored connected (never failed), function groups / interfaces per P-CONN, live health by version`,
            meta({
                id: 'REG-CONN-01', prio: 'P1', issue: 'ilm#436',
                rule: ['platform-keys-connectors A4 r14 (health mapping by version: v1 ok → UP, v2 HealthInfo UP), §4.3 (core never sets failed), M13 ("status OK" = connected + live health); P-CONN table'],
            }),
            async ({ api }, testInfo) => {
                test.setTimeout(60_000);
                const found = await findRow(api, row);
                test.skip(!found, `P-CONN row ${row.id} is not registered on this tier (no connector with its function groups / interfaces): not coverage`);
                const { list, detail } = found!;
                testInfo.annotations.push({ type: 'connector', description: `${row.id} → ${String(list.name)}` });
                // A connector that is down on this tier is an environment gate, not a regression (live run 2: stored status `offline`);
                // `failed` (never set by core) and any other status stay red.
                if (String(list.status) === 'offline') testInfo.annotations.push({ type: 'connector-offline', description: `${String(list.name)} stored status offline` });
                test.skip(String(list.status) === 'offline', 'connector offline on this tier (@needs:connector-online): DevOps brings it up');
                expect(String(list.status), 'stored status').toBe('connected');
                expect(String(list.status)).not.toBe('failed');
                if (row.functionGroups) {
                    const groups = groupsOf(detail);
                    for (const [code, kinds] of Object.entries(row.functionGroups)) expect(groups[code], `${code} kinds`).toEqual(expect.arrayContaining([...kinds].sort()));
                } else {
                    expect(interfaceCodes(detail)).toEqual(expect.arrayContaining(row.interfaces!));
                }
                const health = await healthByVersion(api, { uuid: String(list.uuid), name: String(list.name), status: String(list.status) });
                expect(health.version).toBe(row.version);
                expect(health.healthy, describeHealth(health)).toBe(true);
            });
    }

    test('REG-CONN-02[static-form]: the credential provider\'s Basic form loads from the attribute definitions without any callback',
        meta({ id: 'REG-CONN-02', prio: 'P1', issue: 'ilm#436', rule: ['platform-keys-connectors A4 r15 (callback dispatch by declaration shape: a static form has no callbackContext / dependsOn); P-CONN credential row (keyStoreType is a static list)'] }),
        async ({ api }) => {
            test.setTimeout(30_000);
            const found = await findRow(api, P_CONN[0]);
            test.skip(!found, 'the credential provider v1 is not registered on this tier: not coverage');
            const defs = await listCredentialAttributes(api, String(found!.list.uuid), 'Basic');
            expect(defs.length).toBeGreaterThan(0);
            expect(defs.filter((d) => d.attributeCallback || (d as Json).callback), 'no callback in a static form').toEqual([]);
        });

    test.fixme('REG-CONN-02[callbacks]: per P-CONN probe column the forwarded callbackContext answers 200 with a non-empty list, core/getCredentials lists the run\'s own Basic credential, dependsOn goes through POST /v2/attributes/callback; nothing persisted',
        meta({ id: 'REG-CONN-02', prio: 'P1', issue: 'ilm#436', rule: ['platform-keys-connectors A4 r15 (callbackContext = legacy path forwarded with the free-form body; dependsOn = NG shared POST /v2/attributes/callback; core/getCredentials answered by core)'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(120_000);
            testInfo.annotations.push({ type: 'fixme', description: 'guard request G-3: the callback POSTs on pre-existing connectors are ownership-refused (core stores attribute definitions, B1 author decision 2); a read-only callback probe is requested' });
            const keystore = await findRow(api, P_CONN[2]);
            if (keystore) {
                const defs = await apiJson<Json[]>(api, 'GET', `/api/v1/connectors/${keystore.list.uuid}/attributes/entityProvider/Keystore`);
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
