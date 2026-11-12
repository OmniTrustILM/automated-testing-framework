/**
 * pkiBuilders — pure checks of utils/regression/pkiBuilders.ts: the DNS + IP SAN CSR, the same-key CSR, the EC P-256
 * CSR, the issued subject as a CSR subject, certificate SANs and SPKI, the leaf-first chain check, the SAN set comparison
 * and the detail SAN reader. No environment.
 */
import { expect, test } from '@playwright/test';
import * as forge from 'node-forge';
import { certificateInfo, chainProblems, csrFromKey, csrInfo, csrWithSan, ecCsrWithSan, ecRefusalWording, parseCertificate, pemBlocks, sameSans, sansOfDetail, selfSignedPem, sha256Fingerprint, sha256FingerprintOfPem, csrFromKeyWithSubject, newKeyPair, subjectAttributesOf } from '../../utils/regression/pkiBuilders';

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

test('chainProblems checks BOTH the signature and the names (each alone is not enough: a check that skips either one fails)', async () => {
    const { leaf } = chain();
    // An impostor with the CA's name but another key: the names match, the signature does not.
    const impostor = certOf('qa test ca', 'qa test ca', otherKeys.publicKey, otherKeys.privateKey, '04');
    expect(await chainProblems([leaf, impostor])).toEqual(['block 0 is not signed by block 1']);
    // A leaf signed by the CA's key that names another issuer: the signature verifies, the names do not.
    const misnamed = certOf('qa-reg-x.example.test', 'some other issuer', leafKeys.publicKey, caKeys.privateKey, '05');
    const ca = certOf('qa test ca', 'qa test ca', caKeys.publicKey, caKeys.privateKey, '06');
    expect(await chainProblems([misnamed, ca])).toEqual(["block 0 issuer does not name block 1's subject"]);
});

test('ecRefusalWording: only a CA policy about the KEY counts; a bare "algorithm" or an unrelated refusal does not', () => {
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

test('certificateInfo: SANs, subject and SPKI of a certificate; fingerprints agree with forge', () => {
    const { leaf } = chain();
    const info = certificateInfo(leaf);
    expect(info.sans).toEqual({ dns: ['qa-reg-x.example.test'], ip: ['192.0.2.13'] });
    expect(info.subject).toBe('CN=qa-reg-x.example.test');
    expect(info.issuer).toBe('CN=qa test ca');
    const der64 = leaf.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, '');
    expect(certificateInfo(der64).spkiBase64).toBe(info.spkiBase64);
    expect(sha256FingerprintOfPem(leaf)).toBe(sha256Fingerprint(parseCertificate(leaf)));
    const self = selfSignedPem('qa-reg-x-seed-one');
    expect(certificateInfo(self.pem).subject).toBe('CN=qa-reg-x-seed-one');
});

test('sameSans is set equality (order and DNS case ignored, no extras); sansOfDetail reads dNSName / iPAddress', () => {
    expect(sameSans({ dns: ['A.example.test', 'b.example.test'], ip: ['192.0.2.1'] }, { dns: ['b.example.test', 'a.example.test'], ip: ['192.0.2.1'] })).toBe(true);
    expect(sameSans({ dns: ['a.example.test'], ip: [] }, { dns: ['a.example.test'], ip: ['192.0.2.1'] })).toBe(false);
    expect(sameSans({ dns: ['a.example.test', 'x.example.test'], ip: [] }, { dns: ['a.example.test'], ip: [] })).toBe(false);
    expect(sansOfDetail({ dNSName: ['a.example.test'], iPAddress: ['192.0.2.1'], rfc822Name: ['x@example.test'] })).toEqual({ dns: ['a.example.test'], ip: ['192.0.2.1'] });
    expect(sansOfDetail(undefined)).toEqual({ dns: [], ip: [] });
    expect(sansOfDetail({ dNSName: [] })).toEqual({ dns: [], ip: [] });
});

// ------------------------------------------------------------ the issued subject as a CSR subject (moved from the lifecycle helper tests)

test('subjectAttributesOf / csrFromKeyWithSubject: the issued subject DN (several RDNs, escaped characters) becomes the CSR subject, in order', () => {
    expect(subjectAttributesOf('CN=qa-reg-x.example.test,O=QA Org,C=CZ')).toEqual([
        { name: 'commonName', value: 'qa-reg-x.example.test' }, { name: 'organizationName', value: 'QA Org' }, { name: 'countryName', value: 'CZ' },
    ]);
    expect(subjectAttributesOf('CN=a\\, b\\+c, OU = Unit,2.5.4.97=NTRCZ-1')).toEqual([
        { name: 'commonName', value: 'a, b+c' }, { name: 'organizationalUnitName', value: 'Unit' }, { shortName: '2.5.4.97', value: 'NTRCZ-1' },
    ]);
    const keys = newKeyPair();
    const csr = csrFromKeyWithSubject(keys, 'CN=qa-reg-x.example.test,O=QA Org,C=CZ', { dns: ['qa-reg-x.example.test'] });
    const info = csrInfo(csr.pem);
    expect(info.subject).toBe('CN=qa-reg-x.example.test, O=QA Org, C=CZ');
    expect(info.sans).toEqual({ dns: ['qa-reg-x.example.test'], ip: [] });
    expect(info.spkiBase64).toBe(csr.spkiBase64);
    // Mutant: a CN-only CSR differs from the issued subject the CA completed.
    expect(csrInfo(csrFromKeyWithSubject(keys, 'CN=qa-reg-x.example.test').pem).subject).toBe('CN=qa-reg-x.example.test');
});
