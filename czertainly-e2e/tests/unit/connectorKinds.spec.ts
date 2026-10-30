/**
 * connectorKinds — the connector finder, the shape readers and the needs that depend on which connectors a tier has.
 *
 * Checks `matchesSpec` and the connector detail readers, `findRegisteredConnector` and `findVaultConnector` against a
 * loopback fake core, and the needs `crypto-v1`, `vault-connector`, `ejbca-connector` and `adcs-connector`. Each need is
 * shown met (undefined), unmet (the named reason) and with a failed read (the resolver throws, so the test fails and does
 * not skip). Only GET reaches the fake core; it answers 404 for paths the test did not set.
 */
import { expect, test } from '@playwright/test';
import type { GuardedApi } from '../../utils/regression/guard/types';
import { resolveNeed } from '../../utils/regression/needs';
import { kindConnector } from '../../utils/regression/inventory/credentialKinds';
import { CONNECTOR_SPECS, detailShapeProblems, featuresByInterface, findRegisteredConnector, findVaultConnector, groupsOf, infoShapeProblems, interfaceCodes, inventoryLine, matchesSpec } from '../../utils/regression/platform/connectorKinds';
import type { TestEnv } from '../../utils/env';
import type { Needs } from '../../utils/regression/tags';
import { FakeCore } from './helpers/fakeCore';
import { FakeCoreRig, registerFakeCore } from './helpers/guardRig';
import type { Answer, Arrived, LoopbackServer } from './helpers/loopbackServer';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ENV_KEYS = ['REG_CRYPTO_CONNECTOR_V1', 'REG_CRYPTO_CONNECTOR_V2', 'REG_SECRET_CONNECTOR'];

const v2 = (interfaces: Array<{ code: string; features?: string[] }>, groups: unknown[] = []) => ({
    version: 'v2', functionGroups: groups, interfaces: interfaces.map((i) => ({ uuid: U(90), version: '1.0.0', ...i })),
});
const v1 = (groups: Record<string, string[]>) => ({ version: 'v1', functionGroups: Object.entries(groups).map(([functionGroupCode, kinds]) => ({ functionGroupCode, kinds })) });

class ConnectorCore extends FakeCore {
    readonly routes = new Map<string, Answer>();

    serve(path: string, body: unknown, status = 200): void {
        this.routes.set(path, { status, body });
    }

    serveConnectors(rows: Array<{ uuid: string; name: string; status: string }>, details: Record<string, unknown>): void {
        this.serve('/api/v1/connectors', rows);
        for (const [uuid, detail] of Object.entries(details)) this.serve(`/api/v2/connectors/${uuid}`, detail);
    }

    protected route(a: Arrived, path: string): Answer | undefined {
        return a.method === 'GET' ? this.routes.get(path) : undefined;
    }
}

let core: ConnectorCore;
let server: LoopbackServer;
let api: GuardedApi;
test.beforeEach(() => {
    core = new ConnectorCore();
});
registerFakeCore(() => core, (rig: FakeCoreRig) => ({ server, api } = rig), { clear: ENV_KEYS });

const env = { baseUrl: process.env.BASE_URL, authMode: 'local', username: 'admin', password: 'unused' } as TestEnv;
const need = (name: Needs) => resolveNeed(name, { api, env });

// ------------------------------------------------------------------ the pure readers

test('groupsOf, interfaceCodes and featuresByInterface read a detail: kinds sorted, codes lower-cased, a missing feature list is empty', () => {
    const detail = { ...v1({ discoveryProvider: ['Z', 'IP-Hostname'] }), ...v2([{ code: 'Info' }, { code: 'metrics', features: ['openMetrics'] }]) };
    expect(groupsOf(detail)).toEqual({});
    expect(groupsOf(v1({ discoveryProvider: ['Z', 'IP-Hostname'] }))).toEqual({ discoveryProvider: ['IP-Hostname', 'Z'] });
    expect(interfaceCodes(detail)).toEqual(['info', 'metrics']);
    expect(featuresByInterface(detail)).toEqual({ info: [], metrics: ['openMetrics'] });
});

test('matchesSpec: version, name hint, groups with all kinds and interfaces must all match; a spec without version matches either', () => {
    const detail = v1({ cryptographyProvider: ['SOFT', 'OTHER'] });
    const row = { name: 'Software-Cryptography-Provider' };
    expect(matchesSpec(CONNECTOR_SPECS['software-cryptography-v1'], row, 1, detail)).toBe(true);
    expect(matchesSpec(CONNECTOR_SPECS['software-cryptography-v1'], row, 2, detail), 'a v2 record is no v1 connector').toBe(false);
    expect(matchesSpec(CONNECTOR_SPECS['software-cryptography-v1'], { name: 'PKCS11-Provider' }, 1, detail), 'the name hint').toBe(false);
    expect(matchesSpec({ functionGroups: { cryptographyProvider: ['SOFT', 'MISSING'] } }, row, 1, detail), 'every kind must be offered').toBe(false);
    expect(matchesSpec(CONNECTOR_SPECS.ejbca, { name: 'EJBCA-NG-Connector' }, 2, v1({ authorityProvider: ['EJBCA'] })), 'either version').toBe(true);
    const adcs = v2(['info', 'health', 'metrics', 'authority', 'attributes'].map((code) => ({ code })));
    expect(matchesSpec(CONNECTOR_SPECS['adcs-v2'], { name: 'MS-ADCS-NG-Connector' }, 2, adcs)).toBe(true);
    expect(matchesSpec(CONNECTOR_SPECS['adcs-v2'], { name: 'MS-ADCS-NG-Connector' }, 2, v2([{ code: 'info' }])), 'an interface is missing').toBe(false);
});

test('detailShapeProblems: v1 needs function groups with kinds; v2 needs the info and health interfaces with versions and a list of features', () => {
    expect(detailShapeProblems(1, v1({ discoveryProvider: ['IP-Hostname'] }))).toEqual([]);
    expect(detailShapeProblems(1, { functionGroups: [] })).toEqual(['a v1 connector lists no function group']);
    expect(detailShapeProblems(1, { functionGroups: [{ functionGroupCode: 'x' }] })).toEqual(['function group x lists no kinds array']);
    expect(detailShapeProblems(2, v2([{ code: 'info' }, { code: 'health' }, { code: 'metrics', features: ['openMetrics'] }]))).toEqual([]);
    expect(detailShapeProblems(2, v2([{ code: 'info' }]))).toEqual(['a v2 connector does not offer the health interface']);
    expect(detailShapeProblems(2, v2([{ code: 'info' }, { code: 'health', version: '' } as never]))[0]).toMatch(/health carries no version/);
    expect(detailShapeProblems(2, v2([{ code: 'info' }, { code: 'health', features: 'stateless' as never }]))).toEqual(['interface health lists its features as something else than a list']);
    expect(detailShapeProblems(2, v2([{ code: 'info' }, { code: 'health', features: ['openMetrics'] }])), 'openMetrics belongs to the metrics interface').toEqual(['the openMetrics feature is listed on the health interface, not on metrics']);
});

test('infoShapeProblems: an object that names the connector and its version, flat or wrapped; a list of interfaces needs code and version', () => {
    expect(infoShapeProblems({ id: 'a', name: 'Credential', version: '2.0.0' })).toEqual([]);
    expect(infoShapeProblems({ connector: { name: 'Credential', version: '2.0.0' }, interfaces: [{ code: 'info', version: '1.0.0' }] })).toEqual([]);
    expect(infoShapeProblems([])).toEqual(['the info answer is not a JSON object']);
    expect(infoShapeProblems({ version: '2.0.0' })).toEqual(['the info names no connector']);
    expect(infoShapeProblems({ name: 'x' })).toEqual(['the info carries no connector version']);
    expect(infoShapeProblems({ name: 'x', version: '1', interfaces: 'info' })).toEqual(['the info lists its interfaces as something else than a list']);
    expect(infoShapeProblems({ name: 'x', version: '1', interfaces: [{ code: 'info' }] })[0]).toMatch(/lacks its code or version/);
});

test('inventoryLine: a v1 connector by function groups and kinds, a v2 one by interfaces with their features, an unknown version is said', () => {
    expect(inventoryLine('Net', 1, v1({ discoveryProvider: ['IP-Hostname'] }))).toBe('Net: v1 function groups discoveryProvider[IP-Hostname]');
    expect(inventoryLine('Net', 2, v2([{ code: 'info' }, { code: 'metrics', features: ['openMetrics'] }]))).toBe('Net: v2 interfaces info, metrics(openMetrics)');
    expect(inventoryLine('X', undefined, {})).toBe('X: version unknown interfaces (none)');
    expect(inventoryLine('Y', 2, v2([{ code: 'info' }], [{ functionGroupCode: 'g', kinds: ['k'] }]))).toBe('Y: v2 interfaces info; function groups g[k]');
});

// ------------------------------------------------------------------ the finders and the needs

test('findRegisteredConnector returns a matching connector whatever its state, and undefined when none matches', async () => {
    core.serveConnectors(
        [{ uuid: U(1), name: 'Common-Credential-Connector', status: 'connected' }, { uuid: U(2), name: 'EJBCA-NG-Connector', status: 'offline' }],
        { [U(1)]: v1({ credentialProvider: ['Basic'] }), [U(2)]: v1({ authorityProvider: ['EJBCA', 'EJBCA_SCHEDULE'] }) },
    );
    expect((await findRegisteredConnector(api, CONNECTOR_SPECS.ejbca))?.list).toMatchObject({ uuid: U(2), status: 'offline' });
    expect(await findRegisteredConnector(api, CONNECTOR_SPECS['network-discovery-v1'])).toBeUndefined();
    expect(server.mutations()).toEqual([]);
});

test('findVaultConnector needs a connected v2 connector named Vault with a secret interface', async () => {
    core.serveConnectors(
        [{ uuid: U(1), name: 'HashiCorp-Vault-Connector', status: 'connected' }, { uuid: U(2), name: 'HashiCorp Vault v2', status: 'offline' }],
        { [U(1)]: v1({ discoveryProvider: ['HVault'] }), [U(2)]: v2([{ code: 'secret' }]) },
    );
    expect(await findVaultConnector(api), 'a v1 Vault connector has no secret interface, the v2 one is offline').toBeUndefined();
    core.serveConnectors([{ uuid: U(2), name: 'HashiCorp Vault v2', status: 'connected' }], { [U(2)]: { ...v2([{ code: 'info' }, { code: 'secret' }]), interfaces: [{ uuid: U(7), code: 'secret', version: '1.0.0' }] } });
    expect(await findVaultConnector(api)).toEqual({ uuid: U(2), name: 'HashiCorp Vault v2', interfaceUuid: U(7) });
});

test('ejbca-connector and adcs-connector are met by a registered connector (any state), unmet without one, and fail on an unreadable list', async () => {
    core.serveConnectors([{ uuid: U(1), name: 'EJBCA-NG-Connector', status: 'offline' }], { [U(1)]: v1({ authorityProvider: ['EJBCA'] }) });
    expect(await need('ejbca-connector'), 'an offline EJBCA-NG connector is still registered').toBeUndefined();
    expect(await need('adcs-connector')).toMatch(/^deploy gate: no MS-ADCS-NG v2 connector is registered on this tier \(@needs:adcs-connector\)$/);
    core.serve('/api/v1/connectors', []);
    expect(await need('ejbca-connector')).toMatch(/no EJBCA-NG connector is registered/);
    core.serve('/api/v1/connectors', { message: 'down' }, 500);
    await expect(need('ejbca-connector')).rejects.toThrow(/→ 500/);
    expect(server.mutations()).toEqual([]);
});

test('crypto-v1 is met by a connected v1 software cryptography connector, unmet with only a v2 one, and fails on an unreadable list', async () => {
    const rows = [{ uuid: U(1), name: 'Software-Cryptography-Provider', status: 'connected', functionGroups: [{ functionGroupCode: 'cryptographyProvider' }] }];
    core.serve('/api/v1/connectors', rows);
    core.serve(`/api/v2/connectors/${U(1)}`, { uuid: U(1), version: 'v1' });
    expect(await need('crypto-v1')).toBeUndefined();
    core.serve(`/api/v2/connectors/${U(1)}`, { uuid: U(1), version: 'v2' });
    expect(await need('crypto-v1'), 'a v2 connector is no v1 connector').toMatch(/^no connected software cryptography connector of interface v1 /);
    core.serve('/api/v1/connectors', { message: 'down' }, 500);
    await expect(need('crypto-v1')).rejects.toThrow(/→ 500/);
    expect(server.mutations()).toEqual([]);
});

test('vault-connector is met by a connected Vault connector with a secret interface and unmet without one', async () => {
    core.serveConnectors([{ uuid: U(2), name: 'HashiCorp-Vault-Connector-v2', status: 'connected' }], { [U(2)]: v2([{ code: 'secret' }]) });
    expect(await need('vault-connector')).toBeUndefined();
    core.serve('/api/v1/connectors', []);
    expect(await need('vault-connector')).toMatch(/no connected HashiCorp Vault connector with a secret interface/);
    core.serve('/api/v1/connectors', { message: 'down' }, 500);
    await expect(need('vault-connector')).rejects.toThrow(/→ 500/);
    expect(server.mutations()).toEqual([]);
});

// ------------------------------------------------------------------ the credential kind read

test('kindConnector skips only when the kind is not offered (404) and throws on any other failed read', async () => {
    const path = `/api/v1/connectors/${U(1)}/attributes/credentialProvider/ApiKey`;
    core.serve('/api/v1/connectors', [{ uuid: U(1), name: 'Common-Credential-Connector', status: 'connected', functionGroups: [{ functionGroupCode: 'credentialProvider', kinds: ['ApiKey'] }] }]);
    core.serve(path, [{ uuid: U(5), name: 'apiKey', type: 'data', contentType: 'secret', properties: { required: true } }]);
    expect((await kindConnector(api, 'ApiKey')).ok?.uuid).toBe(U(1));
    core.serve(path, { message: 'not found' }, 404);
    expect((await kindConnector(api, 'ApiKey')).skip).toMatch(/does not offer the kind ApiKey/);
    core.serve(path, { message: 'down' }, 503);
    await expect(kindConnector(api, 'ApiKey')).rejects.toThrow(/answered 503/);
    core.serve('/api/v1/connectors', []);
    expect((await kindConnector(api, 'ApiKey')).skip).toMatch(/no connected credential connector offers the kind ApiKey/);
    expect(server.mutations()).toEqual([]);
});
