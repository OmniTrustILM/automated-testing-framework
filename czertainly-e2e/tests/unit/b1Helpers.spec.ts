/**
 * B1 — pure helpers of the 18-flow extension, without an environment (npm run test:unit):
 * - pki: the DNS + IP SAN CSR (forge, RSA), the same-key CSR, the EC P-256 CSR (@peculiar/x509), certificate SANs /
 *   SPKI, the leaf-first chain check, the SAN set comparison and the ILM detail SAN reader;
 * - connectorApi: version parsing, the health oracle by version, REG_REQUIRED_CONNECTORS / REG_BLOCKED_CONNECTORS;
 * - errorContract: the 422 array / {message} shapes; acmeClient: the response-header read-outs;
 * - regressionApi: the CA order, the SAN oracle per CA, the response → request attribute copy;
 * - inventorySeed: the subset plan and its manifest rules.
 */
import { expect, test } from '@playwright/test';
import * as forge from 'node-forge';
import { acmeHeaders } from '../../utils/regression/acmeClient';
import { blockedConnectors, judgeHealth, parseConnectorVersion, requiredConnectors } from '../../utils/regression/connectorApi';
import { errorShape, expect422Messages, expectMessageObject, INGRESS_SKIP_REASON, judgeRefusedMethod } from '../../utils/regression/errorContract';
import { manifestProblems, manifestValue, nullRows, planSeedSubset, SeedSubsetManifest, seedFilter } from '../../utils/regression/inventorySeed';
import {
    certificateInfo, chainProblems, csrFromKey, csrInfo, csrWithSan, ecCsrWithSan, ecRefusalWording, parseCertificate, pemBlocks, sameSans, sansOfDetail,
    selfSignedPem, sha256Fingerprint, sha256FingerprintOfPem,
} from '../../utils/regression/pki';
import { caConnectorOrder, sanOracleFor, toRequestAttribute } from '../../utils/regression/regressionApi';
import { meta } from '../../utils/regression/tags';

// ------------------------------------------------------------------ pki

test('csrWithSan: DNS and IP SANs, CN and the key are in the request; the private key is returned', () => {
    const csr = csrWithSan('qa-reg-x-ui.example.test', ['qa-reg-x-ui.example.test', 'alt.qa-reg-x-ui.example.test'], { ip: ['192.0.2.10'] });
    const info = csrInfo(csr.pem);
    expect(info.sans).toEqual({ dns: ['qa-reg-x-ui.example.test', 'alt.qa-reg-x-ui.example.test'], ip: ['192.0.2.10'] });
    expect(info.subject).toBe('CN=qa-reg-x-ui.example.test');
    expect(info.spkiBase64).toBe(csr.spkiBase64);
    expect(csrInfo(csr.derBase64).sans).toEqual(info.sans);
    expect(csr.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(csr.sans).toEqual({ dns: ['qa-reg-x-ui.example.test', 'alt.qa-reg-x-ui.example.test'], ip: ['192.0.2.10'] });
    expect(csr.keyType).toBe('rsa-2048');
    expect(Buffer.from(csr.derBase64Url, 'base64url').equals(Buffer.from(csr.derBase64, 'base64'))).toBe(true);
});

test('csrWithSan without SANs has no SAN extension; csrFromKey keeps the key (same-key renew CSR)', () => {
    const plain = csrWithSan('qa-reg-x-plain');
    expect(csrInfo(plain.pem).sans).toEqual({ dns: [], ip: [] });
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const a = csrFromKey(keys, 'qa-reg-x-same', { dns: ['a.example.test'] });
    const b = csrFromKey(keys, 'qa-reg-x-same', { dns: ['b.example.test'] });
    expect(a.spkiBase64).toBe(b.spkiBase64);
    expect(csrWithSan('qa-reg-x-same', [], { key: keys }).spkiBase64).toBe(a.spkiBase64);
    expect(csrInfo(b.pem).sans.dns).toEqual(['b.example.test']);
});

test('ecCsrWithSan: an EC P-256 request with the SANs; its SPKI is the one returned', async () => {
    const csr = await ecCsrWithSan('qa-reg-x-ec.example.test', ['qa-reg-x-ec.example.test'], { ip: ['192.0.2.12'] });
    expect(csr.keyType).toBe('ec-p256');
    const info = csrInfo(csr.pem);
    expect(info.sans).toEqual({ dns: ['qa-reg-x-ec.example.test'], ip: ['192.0.2.12'] });
    expect(info.subject).toBe('CN=qa-reg-x-ec.example.test');
    expect(info.spkiBase64).toBe(csr.spkiBase64);
    expect(csr.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(csr.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
});

/** One certificate (forge): subject / issuer common names, the key it certifies and the key that signs it. */
function certOf(cn: string, issuerCn: string, pub: forge.pki.PublicKey, signer: forge.pki.rsa.PrivateKey, serial: string, ext: any[] = []): string {
    const c = forge.pki.createCertificate();
    c.publicKey = pub;
    c.serialNumber = serial;
    c.validity.notBefore = new Date(Date.now() - 60_000);
    c.validity.notAfter = new Date(Date.now() + 86_400_000);
    c.setSubject([{ name: 'commonName', value: cn }]);
    c.setIssuer([{ name: 'commonName', value: issuerCn }]);
    if (ext.length) c.setExtensions(ext);
    c.sign(signer, forge.md.sha256.create());
    return forge.pki.certificateToPem(c);
}

const caKeys = forge.pki.rsa.generateKeyPair(1024);
const leafKeys = forge.pki.rsa.generateKeyPair(1024);
const otherKeys = forge.pki.rsa.generateKeyPair(1024);

/** A CA and a leaf it signs (forge), for the chain check. */
function chain(): { ca: string; leaf: string; other: string } {
    const ca = certOf('qa test ca', 'qa test ca', caKeys.publicKey, caKeys.privateKey, '01');
    const leaf = certOf('qa-reg-x.example.test', 'qa test ca', leafKeys.publicKey, caKeys.privateKey, '02', [
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'qa-reg-x.example.test' }, { type: 7, ip: '192.0.2.13' }] },
    ]);
    const other = certOf('qa other ca', 'qa other ca', otherKeys.publicKey, otherKeys.privateKey, '03');
    return { ca, leaf, other };
}

test('chainProblems: leaf first and signed by the next block passes; reversed or a foreign issuer fails', async () => {
    const { ca, leaf, other } = chain();
    const blocks = pemBlocks(`${leaf}\r\n${ca}`);
    expect(blocks).toHaveLength(2);
    expect(await chainProblems(blocks)).toEqual([]);
    expect(await chainProblems([leaf])).toEqual([]);
    expect((await chainProblems([ca, leaf])).length).toBeGreaterThan(0);
    expect((await chainProblems([leaf, other])).length).toBeGreaterThan(0);
});

test('chainProblems checks BOTH the signature and the names (each alone is not enough; mutants M09 / M10)', async () => {
    const { leaf } = chain();
    // An impostor with the CA's name but another key: the names match, the signature does not.
    const impostor = certOf('qa test ca', 'qa test ca', otherKeys.publicKey, otherKeys.privateKey, '04');
    expect(await chainProblems([leaf, impostor])).toEqual(['block 0 is not signed by block 1']);
    // A leaf signed by the CA's key that names another issuer: the signature verifies, the names do not.
    const misnamed = certOf('qa-reg-x.example.test', 'some other issuer', leafKeys.publicKey, caKeys.privateKey, '05');
    const ca = certOf('qa test ca', 'qa test ca', caKeys.publicKey, caKeys.privateKey, '06');
    expect(await chainProblems([misnamed, ca])).toEqual(["block 0 issuer does not name block 1's subject"]);
});

test('ecRefusalWording: only a CA policy about the KEY counts (B1 fix pass, Sonnet F9); a bare "algorithm" or an unrelated refusal does not', () => {
    for (const yes of [
        'EC keys are not allowed by the certificate profile',
        'Key algorithm not supported by the end entity profile',
        'The elliptic curve is unsupported',
        'unsupported public key algorithm ECDSA',
        'curve P-256 rejected by policy',
        'Key type EC denied',
    ]) expect(ecRefusalWording(yes), yes).toBe(true);
    for (const no of [
        '',
        'Issued using RA Profile qa-reg-x-ra for the algorithm sha256WithRSA',
        'Certificate request refused: the common name is not in the allowed list',
        'Invalid CSR',
        'The order is not ready',
        'signature algorithm is fine, key length 2048',
        'denied by an unrelated rule, the CA answered after a long and verbose explanation that has nothing to do with it; key',
    ]) expect(ecRefusalWording(no), no).toBe(false);
});

test('judgeRefusedMethod (API-GEN-32[method], Fable F1): an ingress answer skips; core 400 + empty body passes on main; core 401 is the known bug on a migrated build', () => {
    const answer = (status: number, bodyText = '', headers: Record<string, string> = {}) => ({ status, headers, bodyText });
    // Not core's answer: skip (the test reports INGRESS_SKIP_REASON, never a pass, never a red gate).
    expect(INGRESS_SKIP_REASON).toBe('refused by the ingress before core (DevOps Q-10)');
    expect(judgeRefusedMethod(answer(405, '<html>Not Allowed</html>', { server: 'nginx' }))).toEqual({ outcome: 'skip', why: 'HTTP 405' });
    expect(judgeRefusedMethod(answer(405))).toEqual({ outcome: 'skip', why: 'HTTP 405' });
    expect(judgeRefusedMethod(answer(400, '', { server: 'envoy' }))).toEqual({ outcome: 'skip', why: 'server header names a proxy (envoy)' });
    expect(judgeRefusedMethod(answer(401, '', { server: 'Traefik/3.0' }))).toMatchObject({ outcome: 'skip' });
    expect(judgeRefusedMethod(answer(502, '<html><body>Bad Gateway</body></html>'))).toEqual({ outcome: 'skip', why: 'non-JSON body (37 bytes)' });
    // Core's own answers (Tomcat sends no proxy Server header; "Apache-Coyote" is core, not a proxy).
    expect(judgeRefusedMethod(answer(400))).toEqual({ outcome: 'core', problems: [] });
    expect(judgeRefusedMethod(answer(400, '\n', { server: 'Apache-Coyote/1.1' }))).toEqual({ outcome: 'core', problems: [] });
    // On a migrated build core answers 401 (core#2502): problems, so the spec's `expect(problems).toEqual([])` fails — expected there.
    expect(judgeRefusedMethod(answer(401))).toEqual({ outcome: 'core', problems: ['status 401, expected 400'] });
    expect(judgeRefusedMethod(answer(400, '{"message":"x"}'))).toEqual({ outcome: 'core', problems: ['body is not empty (15 bytes), expected an empty body'] });
});

test('judgeRefusedMethod never puts the response body into a verdict (a proxy or an error forward could echo the bearer token)', () => {
    const echo = 'Bearer SECRET-TOKEN-ECHOED';
    for (const verdict of [
        judgeRefusedMethod({ status: 400, headers: {}, bodyText: `{"message":"${echo}"}` }),
        judgeRefusedMethod({ status: 401, headers: {}, bodyText: echo }),
        judgeRefusedMethod({ status: 400, headers: {}, bodyText: `Authorization: ${echo}` }),
        judgeRefusedMethod({ status: 405, headers: { server: 'nginx' }, bodyText: echo }),
    ]) expect(JSON.stringify(verdict)).not.toContain('SECRET');
});

test('certificateInfo: SANs, subject and SPKI of a certificate; fingerprints agree with forge', () => {
    const { leaf } = chain();
    const info = certificateInfo(leaf);
    expect(info.sans).toEqual({ dns: ['qa-reg-x.example.test'], ip: ['192.0.2.13'] });
    expect(info.subject).toBe('CN=qa-reg-x.example.test');
    expect(info.issuer).toBe('CN=qa test ca');
    const der64 = leaf.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, '');
    expect(certificateInfo(der64).spkiBase64).toBe(info.spkiBase64);
    expect(sha256FingerprintOfPem(leaf)).toBe(sha256Fingerprint(parseCertificate(leaf)));
    const self = selfSignedPem('qa-reg-x-seed-a');
    expect(certificateInfo(self.pem).subject).toBe('CN=qa-reg-x-seed-a');
});

test('sameSans is set equality (order and DNS case ignored, no extras); sansOfDetail reads dNSName / iPAddress', () => {
    expect(sameSans({ dns: ['A.example.test', 'b.example.test'], ip: ['192.0.2.1'] }, { dns: ['b.example.test', 'a.example.test'], ip: ['192.0.2.1'] })).toBe(true);
    expect(sameSans({ dns: ['a.example.test'], ip: [] }, { dns: ['a.example.test'], ip: ['192.0.2.1'] })).toBe(false);
    expect(sameSans({ dns: ['a.example.test', 'x.example.test'], ip: [] }, { dns: ['a.example.test'], ip: [] })).toBe(false);
    expect(sansOfDetail({ dNSName: ['a.example.test'], iPAddress: ['192.0.2.1'], rfc822Name: ['x@example.test'] })).toEqual({ dns: ['a.example.test'], ip: ['192.0.2.1'] });
    expect(sansOfDetail(undefined)).toEqual({ dns: [], ip: [] });
    expect(sansOfDetail({ dNSName: [] })).toEqual({ dns: [], ip: [] });
});

// ------------------------------------------------------------------ connectorApi (pure)

test('parseConnectorVersion reads the interfaces ConnectorVersion codes and nothing else', () => {
    expect(parseConnectorVersion('v1')).toBe(1);
    expect(parseConnectorVersion('v2')).toBe(2);
    expect(parseConnectorVersion('V2')).toBe(2);
    expect(parseConnectorVersion(' v1 ')).toBe(1);
    expect(parseConnectorVersion(1)).toBe(1);
    expect(parseConnectorVersion(2)).toBe(2);
    for (const bad of ['v3', '3', 'version2', '', 'v', null, undefined, 1.5, {}, ['v1']]) expect(parseConnectorVersion(bad), String(bad)).toBeUndefined();
});

test('judgeHealth: v1 needs 200 + ok, v2 needs 200 + UP; anything else is unhealthy with the reason', () => {
    expect(judgeHealth(1, 200, { status: 'ok' })).toMatchObject({ healthy: true, status: 'ok' });
    expect(judgeHealth(2, 200, { status: 'UP', components: {} })).toMatchObject({ healthy: true, status: 'UP' });
    expect(judgeHealth(1, 200, { status: 'nok' })).toMatchObject({ healthy: false, why: 'v1 status nok (expected ok)' });
    expect(judgeHealth(2, 200, { status: 'ok' })).toMatchObject({ healthy: false });
    expect(judgeHealth(1, 200, { status: 'UP' })).toMatchObject({ healthy: false });
    expect(judgeHealth(2, 200, { status: 'DEGRADED' })).toMatchObject({ healthy: false });
    expect(judgeHealth(2, 503, { status: 'DOWN' })).toMatchObject({ healthy: false, status: 'DOWN', why: 'live health 503' });
    expect(judgeHealth(1, 404, undefined)).toMatchObject({ healthy: false, why: 'live health 404' });
    expect(judgeHealth(2, 200, 'UP')).toMatchObject({ healthy: false, why: 'v2 health body without a status' });
});

test('REG_REQUIRED_CONNECTORS / REG_BLOCKED_CONNECTORS', () => {
    expect(requiredConnectors({})).toEqual(['Common-Credential-Connector', 'MS-ADCS-NG-Connector']);
    expect(requiredConnectors({ REG_REQUIRED_CONNECTORS: ' A , B,,A ' })).toEqual(['A', 'B']);
    expect([...blockedConnectors({})]).toEqual([]);
    expect([...blockedConnectors({ REG_BLOCKED_CONNECTORS: '  ' })]).toEqual([]);
    expect([...blockedConnectors({ REG_BLOCKED_CONNECTORS: 'MS-ADCS-NG-Connector: health 503, DevOps ticket; X:a:b' })])
        .toEqual([['MS-ADCS-NG-Connector', 'health 503, DevOps ticket'], ['X', 'a:b']]);
    expect(() => blockedConnectors({ REG_BLOCKED_CONNECTORS: 'MS-ADCS-NG-Connector' })).toThrow(/name:reason/);
    expect(() => blockedConnectors({ REG_BLOCKED_CONNECTORS: 'X:' })).toThrow(/name:reason/);
});

// ------------------------------------------------------------------ errorContract, acmeHeaders

test('errorShape: 422 = array of non-empty strings, others = exactly {message}', () => {
    expect(errorShape('["Unknown sort field identifier X."]')).toEqual({ kind: 'messages', messages: ['Unknown sort field identifier X.'] });
    expect(errorShape('{"message":"Object of type \'Certificate\' identified by x is not found."}')).toMatchObject({ kind: 'message' });
    expect(errorShape('')).toEqual({ kind: 'empty' });
    expect(errorShape('[]').kind).toBe('other');
    expect(errorShape('["", "x"]').kind).toBe('other');
    expect(errorShape('[1]').kind).toBe('other');
    expect(errorShape('{"message":"x","trace":"y"}').kind).toBe('other');
    expect(errorShape('{"message":1}').kind).toBe('other');
    expect(errorShape('<html/>').kind).toBe('other');
    expect(errorShape('"x"').kind).toBe('other');
    expect(expect422Messages('["a"]')).toEqual(['a']);
    expect(() => expect422Messages('{"message":"a"}')).toThrow(/JSON array/);
    expect(expectMessageObject('{"message":"Failed to submit certificate request"}')).toBe('Failed to submit certificate request');
    expect(() => expectMessageObject('["a"]')).toThrow(/\{"message"/);
});

test('acmeHeaders: lower-case names, Retry-After, Replay-Nonce, Content-Type, Location and the server Date', () => {
    const h = new Headers({ 'Retry-After': '30', 'Replay-Nonce': 'n1', 'Content-Type': 'application/json', Location: 'https://acme.example.test/order/1', Date: 'Tue, 13 Oct 2026 10:00:00 GMT' });
    const r = acmeHeaders({ headers: h });
    expect(r.retryAfter).toBe('30');
    expect(r.replayNonce).toBe('n1');
    expect(r.contentType).toBe('application/json');
    expect(r.location).toBe('https://acme.example.test/order/1');
    expect(r.date?.toISOString()).toBe('2026-10-13T10:00:00.000Z');
    expect(r.headers['retry-after']).toBe('30');
    expect(acmeHeaders({ headers: new Headers({ Date: 'not a date' }) }).date).toBeUndefined();
});

// ------------------------------------------------------------------ regressionApi (pure parts)

test('the CA order (Phase 2: MS ADCS, EJBCA-NG, PyADCS), REG_CA_CONNECTORS and the SAN oracle per CA', () => {
    expect(caConnectorOrder({})).toEqual(['MS-ADCS-NG-Connector', 'EJBCA-NG-Connector', 'PyADCS-Connector']);
    expect(caConnectorOrder({ REG_ADCS_CONNECTOR: 'ADCS-X' })).toEqual(['ADCS-X', 'EJBCA-NG-Connector', 'PyADCS-Connector']);
    expect(caConnectorOrder({ REG_CA_CONNECTORS: 'B, A ,B' })).toEqual(['B', 'A']);
    expect(sanOracleFor('EJBCA-NG-Connector', {})).toBe('exact');
    expect(sanOracleFor('MS-ADCS-NG-Connector', {})).toBe('dns');
    expect(sanOracleFor('PyADCS-Connector', { REG_EXACT_SAN_CONNECTORS: 'PyADCS-Connector' })).toBe('exact');
});

test('toRequestAttribute copies uuid, name, content type, content and the version (v2 when absent)', () => {
    const content = [{ reference: 'EE', data: { id: 1, name: 'EE' } }];
    expect(toRequestAttribute({ version: 'v3', uuid: 'u', name: 'n', label: 'L', type: 'data', contentType: 'object', content })).toEqual({ version: 'v3', uuid: 'u', name: 'n', contentType: 'object', content });
    expect(toRequestAttribute({ uuid: 'u', name: 'n', contentType: 'string', content: [{ data: 'x' }] }).version).toBe('v2');
});

// ------------------------------------------------------------------ inventorySeed (pure)

const RUN = 'qa-reg-20261014-080000-ab12';
const name = (s: string) => `${RUN}-${s}`;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function manifest(over: Partial<SeedSubsetManifest> = {}): SeedSubsetManifest {
    const plan = planSeedSubset(name, 'k1');
    return { ...plan, runId: RUN, attributeUuid: U(1), ownerUuid: U(2), certificates: plan.certificates.map((c, i) => ({ ...c, uuid: U(10 + i) })), ...over };
}

test('planSeedSubset: three certificates under one run-prefixed prefix; one without an owner, one without a rank, distinct ranks', () => {
    const p = planSeedSubset(name, 'k1');
    expect(p.prefix).toBe(`${RUN}-seed-k1-`);
    expect(p.certificates.map((c) => c.commonName)).toEqual([`${RUN}-seed-k1-a`, `${RUN}-seed-k1-b`, `${RUN}-seed-k1-c`]);
    expect(p.certificates.map((c) => [c.key, c.owner, c.rank])).toEqual([['a', true, 2], ['b', true, null], ['c', false, 1]]);
    expect(p.attribute).toEqual({ name: `${RUN}-seed-k1-rank`, label: 'Seed rank k1', contentType: 'integer' });
    expect(p.owner.username).toBe(`${RUN}-seed-k1-owner`);
    expect(planSeedSubset(name, 'k2').prefix).not.toBe(p.prefix);
    expect(seedFilter(p)).toEqual([{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: `${RUN}-seed-k1-` }]);
});

test('the manifest names the null rows and the values the sort oracle compares', () => {
    const m = manifest();
    expect(manifestProblems(m, RUN)).toEqual([]);
    expect(nullRows(m, 'owner')).toEqual([U(12)]);
    expect(nullRows(m, 'rank')).toEqual([U(11)]);
    expect(manifestValue(m, U(10), 'owner')).toBe(`${RUN}-seed-k1-owner`);
    expect(manifestValue(m, U(12), 'owner')).toBeNull();
    expect(manifestValue(m, U(10), 'rank')).toBe(2);
    expect(manifestValue(m, U(11), 'rank')).toBeNull();
    expect(manifestValue(m, U(99), 'rank')).toBeUndefined();
});

test('manifestProblems refuses another run, a foreign prefix, duplicates and a subset without exactly one null per field', () => {
    expect(manifestProblems(manifest(), 'qa-reg-20261014-080000-zz99')).toContain('the manifest belongs to another run');
    expect(manifestProblems(manifest({ prefix: 'prod-' }), RUN)).toEqual(expect.arrayContaining(['the prefix does not carry the run prefix', 'a certificate outside the prefix']));
    const m = manifest();
    expect(manifestProblems({ ...m, certificates: m.certificates.map((c) => ({ ...c, uuid: U(10) })) }, RUN)).toContain('duplicate certificate uuids');
    expect(manifestProblems({ ...m, certificates: m.certificates.map((c) => ({ ...c, owner: true })) }, RUN)).toContain('0 certificates without an owner (1 expected)');
    expect(manifestProblems({ ...m, certificates: m.certificates.map((c) => ({ ...c, rank: c.rank === null ? null : 5 })) }, RUN)).toContain('equal ranks (the value order would be a tie)');
    expect(manifestProblems({ ...m, certificates: m.certificates.slice(0, 2) }, RUN)).toContain('2 certificates (3 expected)');
});

// ------------------------------------------------------------------ tags (B1 rule annotations)

test('meta({ rule }) adds one `rule` annotation per cited rule after the ledger id (mutant M24)', () => {
    const m = meta({ id: 'REG-CFG-07.a', prio: 'P1', issue: 'ilm#427', bug: 'core#2297', rule: ['release plan CFG-07 N1', 'core#2297'] });
    expect(m.annotation).toEqual([
        { type: 'ledger-id', description: 'REG-CFG-07.a' },
        { type: 'rule', description: 'release plan CFG-07 N1' },
        { type: 'rule', description: 'core#2297' },
    ]);
    expect(meta({ id: 'API-GEN-32', prio: 'P1', issue: 'ilm#428', gate: true, rule: 'one rule' }).annotation).toEqual([
        { type: 'ledger-id', description: 'API-GEN-32' },
        { type: 'rule', description: 'one rule' },
    ]);
    expect(m.tag).toEqual(['@issue:ilm#448', '@issue:ilm#427', '@p1', '@bug:core#2297']);
});
