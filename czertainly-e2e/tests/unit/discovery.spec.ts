/**
 * The pure helpers of the discovery area: the v1 (`ip`, `port`, `allPorts`, `data_parallel_executions`) and v2
 * (`version: v3`, one content item per entry) attribute shapes, the generation-dependent create body, `isSubsequence`,
 * `fingerprintSet`, and the TLS scan target (deploy gate texts, a served chain read back over a real TLS handshake on
 * loopback, distinct leaves). No network beyond 127.0.0.1.
 */
import { expect, test } from '@playwright/test';
import * as tls from 'tls';
import * as crypto from 'crypto';
import { DiscoveryConnector, discoveryBody, fingerprintSet, isSubsequence, v1Attributes, v2Attributes } from '../../utils/regression/discovery/discoveryApi';
import type { TlsTarget } from '../../utils/regression/discovery/tlsTarget';
import { scanHost, scanTargetProblem, startTlsTarget } from '../../utils/regression/discovery/tlsTarget';
import { runName } from '../../utils/regression/ledger/runState';
import { contentOf } from './helpers/contentOf';

type Json = Record<string, any>;

// ------------------------------------------------------------------ discovery builders

const V1_DEFS: Json[] = [
    { uuid: 'd-ip', name: 'ip', contentType: 'string' },
    { uuid: 'd-port', name: 'port', contentType: 'string' },
    { uuid: 'd-all', name: 'allPorts', contentType: 'boolean' },
    { uuid: 'd-par', name: 'data_parallel_executions', contentType: 'integer' },
];
const V2_DEFS: Json[] = [
    { uuid: 'e-hosts', name: 'data_hosts', contentType: 'string' },
    { uuid: 'e-ports', name: 'data_ports', contentType: 'string' },
    { uuid: 'e-par', name: 'data_parallelExecutions', contentType: 'integer' },
];
const V1: DiscoveryConnector = { uuid: 'c1', name: 'n', generation: 'v1', kind: 'IP-Hostname' } as DiscoveryConnector;
const V2: DiscoveryConnector = { uuid: 'c2', name: 'n', generation: 'v2', interfaceUuid: 'i2' } as DiscoveryConnector;

test('v1 attributes: one comma-separated ip value, ports, allPorts, parallel; unset fields are left out', () => {
    const a = v1Attributes(V1_DEFS, { hosts: ['192.0.2.1', '192.0.2.2'], ports: ['443', '8443'], allPorts: false, parallel: 3 });
    expect(a.map((x) => [x.name, contentOf(x)[0].data])).toEqual([['ip', '192.0.2.1,192.0.2.2'], ['port', '443,8443'], ['allPorts', false], ['data_parallel_executions', 3]]);
    expect(a.every((x) => !('version' in x))).toBe(true);
    expect(v1Attributes(V1_DEFS, {})).toEqual([]);
    expect(() => v1Attributes([], { hosts: ['x'] })).toThrow(/offers no attribute ip/);
});

test('v2 attributes: version v3, one content item per entry with its content type', () => {
    const a = v2Attributes(V2_DEFS, { hosts: ['192.0.2.0/24', '198.51.100.0/24'], ports: ['443'], parallel: 5 });
    expect(a[0]).toMatchObject({ version: 'v3', name: 'data_hosts', contentType: 'string' });
    expect(a[0].content).toEqual([{ contentType: 'string', data: '192.0.2.0/24' }, { contentType: 'string', data: '198.51.100.0/24' }]);
    expect(a[2]).toMatchObject({ name: 'data_parallelExecutions', contentType: 'integer', content: [{ contentType: 'integer', data: 5 }] });
    expect(v2Attributes(V2_DEFS, { hosts: [] })[0].content).toEqual([]);
});

test('the discovery body depends on the generation: v1 kind, v2 interface + resources; triggers and overrides are applied', () => {
    const b1 = discoveryBody(V1, 'n1', [], { triggers: [{ uuid: 't1' }] });
    expect(b1).toMatchObject({ name: 'n1', connectorUuid: 'c1', kind: 'IP-Hostname', triggers: ['t1'] });
    expect('interfaceUuid' in b1 || 'resources' in b1).toBe(false);
    const b2 = discoveryBody(V2, 'n2', []);
    expect(b2).toMatchObject({ connectorUuid: 'c2', interfaceUuid: 'i2', resources: ['certificates'] });
    expect('kind' in b2).toBe(false);
    expect('triggers' in b2).toBe(false);
    expect(discoveryBody(V2, 'n2', [], { resources: ['keys'], body: { name: 'override' } })).toMatchObject({ name: 'override', resources: ['keys'] });
});

test('isSubsequence keeps order and allows gaps; fingerprintSet normalises, de-duplicates and sorts', () => {
    expect(isSubsequence(['inProgress', 'completed'], ['inProgress', 'processing', 'completed'])).toBe(true);
    expect(isSubsequence(['completed', 'inProgress'], ['inProgress', 'completed'])).toBe(false);
    expect(isSubsequence([], ['a'])).toBe(true);
    expect(isSubsequence(['a'], [])).toBe(false);
    expect(fingerprintSet([{ fingerprint: 'AB:CD' }, { fingerprint: 'abcd' }, { fingerprint: '01 02' }, {}])).toEqual(['0102', 'abcd']);
});

// ------------------------------------------------------------------ TLS scan target

test('the scan target deploy gate: unset, malformed and valid REG_SCAN_HOST', () => {
    expect(scanTargetProblem({})).toMatch(/^deploy gate: no scan target \(REG_SCAN_HOST unset\)/);
    expect(scanTargetProblem({ REG_SCAN_HOST: 'localhost' })).toMatch(/neither a dotted host name nor an IP address/);
    expect(scanTargetProblem({ REG_SCAN_HOST: 'runner.qa.example.test' })).toBeUndefined();
    expect(scanTargetProblem({ REG_SCAN_HOST: '127.0.0.1' })).toBeUndefined();
    expect(scanHost({ REG_SCAN_HOST: '  h.example.test ' })).toBe('h.example.test');
    expect(scanHost({})).toBe('');
});

test('startTlsTarget without a scan host refuses with the deploy gate text and opens nothing', async () => {
    await expect(startTlsTarget({ env: {} })).rejects.toThrow(/deploy gate: no scan target/);
});

/**
 * The chain listener `index` serves, read over a verified TLS handshake on loopback: the client trusts `ca` (default: the root
 * alone, which no listener serves) and checks the leaf's name. Node appends the issuers it finds in `ca`, so the served
 * certificates come first.
 */
async function servedOn(target: TlsTarget, index: number, ca: string[] = [target.rootPem]): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port: target.ports[index], ca, servername: target.served[index][0].commonName }, () => {
            const out: string[] = [];
            let c: tls.DetailedPeerCertificate | undefined = socket.getPeerCertificate(true);
            const seen = new Set<string>();
            while (c && c.raw && !seen.has(c.fingerprint256)) {
                seen.add(c.fingerprint256);
                out.push(crypto.createHash('sha256').update(c.raw).digest('hex'));
                c = c.issuerCertificate && c.issuerCertificate !== c ? c.issuerCertificate : undefined;
            }
            socket.end();
            resolve(out);
        });
        socket.on('error', reject);
    });
}

test('a target with an intermediate serves leaf + intermediate; its own fingerprints equal what a client reads', async () => {
    const target = await startTlsTarget({ env: { REG_SCAN_HOST: '127.0.0.1', REG_SCAN_BIND: '127.0.0.1' }, listeners: 1 });
    try {
        expect(target.ports).toHaveLength(1);
        expect(target.host).toBe('127.0.0.1');
        expect(target.served[0].map((c) => c.role)).toEqual(['leaf', 'intermediate']);
        // trusting the root alone, the handshake succeeds only because the listener sends its intermediate
        const read = await servedOn(target, 0);
        expect(read.slice(0, 2).sort()).toEqual(target.servedFingerprints());
        expect(target.served[0][0].commonName.startsWith(runName(''))).toBe(true);
        expect(target.portsAttribute()).toBe(String(target.ports[0]));
        expect(target.ipAttribute()).toBe('127.0.0.1');
    } finally {
        await target.close();
        await target.close(); // idempotent
    }
});

test('distinct leaves: 3 listeners / 2 distinct leaves repeat leaf 1; no intermediate serves the leaf alone', async () => {
    const target = await startTlsTarget({ env: { REG_SCAN_HOST: '127.0.0.1', REG_SCAN_BIND: '127.0.0.1' }, listeners: 3, distinctLeaves: 2, withIntermediate: false, stem: 'unit' });
    try {
        expect(target.ports).toHaveLength(3);
        expect(new Set(target.ports).size).toBe(3);
        expect(target.served.every((chain) => chain.length === 1)).toBe(true);
        const leafPrints = target.served.map((c) => c[0].fingerprint);
        expect(new Set(leafPrints).size).toBe(2);
        expect(leafPrints[2]).toBe(leafPrints[0]);
        expect(target.distinct()).toHaveLength(2);
        // the leaf alone: trusting only the root, a client cannot verify it (OpenSSL's code for a one-certificate chain whose
        // issuer is missing); trusting the intermediate too, it reads this listener's leaf
        await expect(servedOn(target, 1)).rejects.toMatchObject({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
        expect((await servedOn(target, 1, [target.rootPem, target.intermediatePem]))[0]).toBe(leafPrints[1]);
    } finally {
        await target.close();
    }
});

test('a client cannot reach a closed target (the listeners are gone after close)', async () => {
    const target = await startTlsTarget({ env: { REG_SCAN_HOST: '127.0.0.1', REG_SCAN_BIND: '127.0.0.1' } });
    await target.close();
    await expect(servedOn(target, 0)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});
