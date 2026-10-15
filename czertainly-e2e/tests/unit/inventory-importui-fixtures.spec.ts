/**
 * Pure unit tests of the import / inspection / upload fixtures (utils/regression/inventoryImportFixtures.ts): every builder is
 * parsed back with an independent reader (node-forge, @peculiar/x509 through pki.ts, node:crypto) and its structure asserted;
 * nothing here touches a server. The fixtures stand in for what core reads, so a builder that silently produced something else
 * (a PKCS#12 that opens with the wrong password, a PEM with one key instead of two, 200 certificates instead of 201) would make
 * a refusal test pass or fail for the wrong reason.
 */
import { expect, test } from '@playwright/test';
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import { certificateInfo, csrInfo } from '../../utils/regression/pki';
import {
    asFile, certificate, certificateFingerprint, certificatesInOnePem, containerDigest, csrPem, dhParametersPem, entryReference, fileMember, garbageBytes, importBody,
    importCn, inspectionAlert, inspectionBody, keyReference, LIMITS, limitExceeded, paddedCertificatePem, pemBlock, pemBundle, pemToDer, pemTwoKeys, pkcs12, pkcs12Truststore,
    pkcs12TwoPassphrases, pkcs7Der, pkcs7Pem, pkcs8Key, REFUSAL, requestsInOnePem, ROUTES, sha256Hex, toBase64, uploadBody,
} from '../../utils/regression/inventoryImportFixtures';
import { RUN_ID } from '../../utils/regression/regressionRun';
import { randomBytes } from 'node:crypto';
// Run-scoped generated test passwords (merge follow-up 2026-10-15): no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_2 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_3 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_4 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_5 = `qa-${randomBytes(9).toString('base64url')}`;

test.describe.configure({ timeout: 90_000 });

const blocksOf = (text: string): string[] => [...text.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----/g)].map((m) => m[1]);
const OIDS = { pbes2: '1.2.840.113549.1.5.13', pbkdf2: '1.2.840.113549.1.5.12', hmacSha256: '1.2.840.113549.2.9', aes256: '2.16.840.1.101.3.4.1.42' };

function oidsOf(node: forge.asn1.Asn1, out: string[] = []): string[] {
    if (node.type === forge.asn1.Type.OID) out.push(forge.asn1.derToOid(node.value as string));
    if (Array.isArray(node.value)) for (const c of node.value) oidsOf(c, out);
    return out;
}

test('names: run-prefixed and unique per call (safe under --repeat-each)', () => {
    const a = importCn('x');
    const b = importCn('x');
    expect(a.startsWith(`${RUN_ID}-imp-`)).toBe(true);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9-]+$/);
});

test('certificate: parses back, CN as asked, fingerprint and reference are the SHA-256 of the DER, PEM and DER agree', () => {
    const id = certificate(importCn('cert'));
    const info = certificateInfo(id.pem);
    expect(info.subject).toBe(`CN=${id.cn}`);
    expect(info.issuer).toBe(`CN=${id.cn}`);
    expect(pemToDer(id.pem).equals(id.der)).toBe(true);
    expect(id.fingerprint).toBe(crypto.createHash('sha256').update(id.der).digest('hex'));
    expect(certificateFingerprint(id.pem)).toBe(id.fingerprint);
    expect(certificateFingerprint(id.der)).toBe(id.fingerprint);
    expect(entryReference(id.der)).toBe(id.fingerprint);
    expect(id.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The key reference is the SHA-256 of the SPKI the certificate carries.
    expect(Buffer.from(info.spkiBase64, 'base64').equals(id.spki)).toBe(true);
    expect(id.keyReference).toBe(keyReference(id.spki));
    // The PKCS#8 PEM of the key is a PRIVATE KEY block whose public half is the certificate's key.
    expect(blocksOf(id.pkcs8Pem)).toEqual(['PRIVATE KEY']);
    const derived = crypto.createPublicKey(crypto.createPrivateKey(id.pkcs8Pem)).export({ type: 'spki', format: 'der' });
    expect(Buffer.from(derived).equals(id.spki)).toBe(true);
    // Two certificates never share a fingerprint, even with the same name.
    expect(certificate(id.cn).fingerprint).not.toBe(id.fingerprint);
});

test('PKCS#7: a degenerate SignedData with the certificates — PEM block type PKCS7, DER parses, every certificate is in it', () => {
    const a = certificate(importCn('p7a'));
    const b = certificate(importCn('p7b'));
    const der = pkcs7Der([a, b]);
    const message = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der.toString('binary'))) as unknown as { certificates: forge.pki.Certificate[]; signers?: unknown[] };
    expect(message.certificates).toHaveLength(2);
    const derOf = (c: forge.pki.Certificate) => Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes(), 'binary');
    expect(message.certificates.map((c) => derOf(c).toString('hex'))).toEqual([a.der.toString('hex'), b.der.toString('hex')]);
    const pem = pkcs7Pem([a]);
    expect(blocksOf(pem)).toEqual(['PKCS7']);
    expect(forge.pkcs7.messageFromPem(pem)).toBeTruthy();
    expect(pemToDer(pem).equals(pkcs7Der([a]))).toBe(true); // the PEM is the DER of the same structure, deterministically
    // contentType signedData (1.2.840.113549.1.7.2), no signer
    expect(oidsOf(forge.asn1.fromDer(der.toString('binary')))[0]).toBe('1.2.840.113549.1.7.2');
});

test('PKCS#8: plain is a PRIVATE KEY; encrypted is ENCRYPTED PRIVATE KEY under PBES2 / PBKDF2 / HMAC-SHA256 / AES-256-CBC (the protection core accepts); wrong or missing passphrase cannot open it', () => {
    const plain = pkcs8Key();
    expect(blocksOf(plain.pem)).toEqual(['PRIVATE KEY']);
    expect(plain.keyReference).toBe(sha256Hex(plain.spki));
    expect(Buffer.from(crypto.createPublicKey(crypto.createPrivateKey(plain.pem)).export({ type: 'spki', format: 'der' })).equals(plain.spki)).toBe(true);

    const enc = pkcs8Key(GEN_PW_1);
    expect(blocksOf(enc.pem)).toEqual(['ENCRYPTED PRIVATE KEY']);
    const oids = oidsOf(forge.asn1.fromDer(enc.der.toString('binary')));
    expect(oids).toEqual([OIDS.pbes2, OIDS.pbkdf2, OIDS.hmacSha256, OIDS.aes256]);
    const opened = crypto.createPrivateKey({ key: enc.pem, passphrase: GEN_PW_1 });
    expect(Buffer.from(crypto.createPublicKey(opened).export({ type: 'spki', format: 'der' })).equals(enc.spki)).toBe(true);
    expect(() => crypto.createPrivateKey({ key: enc.pem, passphrase: GEN_PW_2 })).toThrow();
    expect(() => crypto.createPrivateKey({ key: enc.pem })).toThrow();
});

test('PKCS#12 with a password: round trip with the right password; a wrong and a missing one are refused by the MAC (the same failure)', () => {
    const f = pkcs12(importCn('p12'), GEN_PW_1);
    const parse = (pw?: string) => forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(f.bytes.toString('binary')), pw as string);
    const ok = parse(GEN_PW_1);
    const bags = ok.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
    expect(bags).toHaveLength(1);
    expect(bags[0].cert!.subject.getField('CN').value).toBe(f.identity.cn);
    expect(ok.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]).toHaveLength(1);
    expect(() => parse(GEN_PW_2)).toThrow(/MAC could not be verified/);
    expect(() => parse('')).toThrow();
    // PFX version 3 (core's KeystoreDetection.isPkcs12 needs it: the first value of the outer SEQUENCE).
    const outer = forge.asn1.fromDer(f.bytes.toString('binary'));
    expect(forge.asn1.derToInteger((outer.value as forge.asn1.Asn1[])[0].value as string)).toBe(3);
});

test('PKCS#12 with the EMPTY password opens with an empty password; a truststore holds certificates only', () => {
    const f = pkcs12(importCn('p12-empty'), '');
    const asn1 = forge.asn1.fromDer(f.bytes.toString('binary'));
    expect(forge.pkcs12.pkcs12FromAsn1(asn1, '').getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]).toHaveLength(1);

    const a = certificate(importCn('ts-a'));
    const b = certificate(importCn('ts-b'));
    const trust = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(pkcs12Truststore([a, b], '').toString('binary')), '');
    expect(trust.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]).toHaveLength(2);
    expect(trust.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []).toHaveLength(0);
});

test('PKCS#12 with a key under another passphrase: the MAC verifies with the FILE passphrase only, the key opens with the KEY passphrase only, the certificate is readable', () => {
    const f = pkcs12TwoPassphrases(importCn('p12-two'), GEN_PW_3, GEN_PW_4);
    const outer = forge.asn1.fromDer(f.bytes.toString('binary'));
    const parts = outer.value as forge.asn1.Asn1[];
    expect(forge.asn1.derToInteger(parts[0].value as string)).toBe(3);
    // authSafe: data ContentInfo → OCTET STRING of the AuthenticatedSafe
    const authSafe = (((parts[1].value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value) as string;
    // MacData: SEQUENCE { DigestInfo, salt, iterations }
    const mac = parts[2].value as forge.asn1.Asn1[];
    const digest = ((mac[0].value as forge.asn1.Asn1[])[1].value) as string;
    const salt = mac[1].value as string;
    const iterations = forge.asn1.derToInteger(mac[2].value as string);
    const generateKey = (forge.pkcs12 as unknown as { generateKey(p: string, s: forge.util.ByteStringBuffer, id: number, n: number, len: number): forge.util.ByteStringBuffer }).generateKey;
    const macWith = (password: string): string => {
        const h = forge.hmac.create();
        h.start(forge.md.sha1.create(), generateKey(password, new forge.util.ByteStringBuffer(salt), 3, iterations, 20).getBytes());
        h.update(authSafe);
        return h.getMac().getBytes();
    };
    expect(macWith(GEN_PW_3)).toBe(digest);
    expect(macWith(GEN_PW_4)).not.toBe(digest);
    expect(macWith('')).not.toBe(digest);

    // The safe holds a shrouded key bag (PBES2, SHA-256 PRF, AES-256) and a certificate bag.
    const safe = forge.asn1.fromDer(authSafe);
    const content = forge.asn1.fromDer(((((safe.value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value) as string);
    const oids = oidsOf(content);
    expect(oids).toContain(forge.pki.oids.pkcs8ShroudedKeyBag);
    expect(oids).toContain(forge.pki.oids.certBag);
    expect(oids).toContain(OIDS.hmacSha256);
    expect(oids).toContain(OIDS.aes256);
    // Open the EncryptedPrivateKeyInfo with each passphrase.
    const keyBag = (content.value as forge.asn1.Asn1[])[0];
    const shrouded = ((keyBag.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0];
    expect(forge.pki.decryptPrivateKeyInfo(shrouded, GEN_PW_4)).toBeTruthy();
    // forge answers a wrong password with null or with a parse error of the garbage it decrypted: either way the key stays shut.
    let openedWithFilePassphrase = false;
    try {
        openedWithFilePassphrase = !!forge.pki.decryptPrivateKeyInfo(shrouded, GEN_PW_3);
    } catch {
        openedWithFilePassphrase = false;
    }
    expect(openedWithFilePassphrase).toBe(false);
    const certBag = (content.value as forge.asn1.Asn1[])[1];
    const certOctets = ((((certBag.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as string;
    expect(Buffer.from(certOctets, 'binary').equals(f.identity.der)).toBe(true);
});

test('PEM bundle: leaf, CA, then the leaf\'s PKCS#8 key; the leaf is signed by the CA, the key is the leaf\'s', () => {
    const b = pemBundle(importCn('leaf'), importCn('ca'));
    expect(blocksOf(b.pem)).toEqual(['CERTIFICATE', 'CERTIFICATE', 'PRIVATE KEY']);
    expect(b.ca.cert.verify(b.leaf.cert)).toBe(true);
    expect(b.leaf.cert.issuer.getField('CN').value).toBe(b.ca.cn);
    expect(b.leaf.fingerprint).not.toBe(b.ca.fingerprint);
    const keyPem = b.pem.slice(b.pem.indexOf('-----BEGIN PRIVATE KEY-----'));
    expect(Buffer.from(crypto.createPublicKey(crypto.createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' })).equals(b.leaf.spki)).toBe(true);
});

test('a PEM with two keys holds exactly two PRIVATE KEY blocks of different keys; a DH block is a DH PARAMETERS block with a 2048-bit prime and g = 2', () => {
    const two = pemTwoKeys();
    expect(blocksOf(two)).toEqual(['PRIVATE KEY', 'PRIVATE KEY']);
    const [k1, k2] = two.split(/(?=-----BEGIN)/);
    expect(crypto.createPrivateKey(k1).export({ type: 'pkcs8', format: 'der' }).equals(crypto.createPrivateKey(k2).export({ type: 'pkcs8', format: 'der' }))).toBe(false);

    const dh = dhParametersPem();
    expect(blocksOf(dh)).toEqual(['DH PARAMETERS']);
    const seq = forge.asn1.fromDer(pemToDer(dh).toString('binary'));
    const [p, g] = seq.value as forge.asn1.Asn1[];
    expect(seq.type).toBe(forge.asn1.Type.SEQUENCE);
    expect(p.type).toBe(forge.asn1.Type.INTEGER);
    expect(g.type).toBe(forge.asn1.Type.INTEGER);
    const prime = Buffer.from(p.value as string, 'binary');
    expect(prime.length === 256 || (prime.length === 257 && prime[0] === 0)).toBe(true);
    expect(forge.asn1.derToInteger(g.value as string)).toBe(2);
    // The text is a plain PEM: 64-column lines, a BEGIN line at the start of a line (what PemFormat counts).
    expect(dh.startsWith('-----BEGIN DH PARAMETERS-----\n')).toBe(true);
    expect(dh.split('\n').every((line) => line.length <= 64 + 30)).toBe(true);
});

test('CSR PEM: parses, CN as asked, the entry reference is the SHA-256 of the request DER', () => {
    const csr = csrPem(importCn('csr'));
    expect(blocksOf(csr.pem)).toEqual(['CERTIFICATE REQUEST']);
    expect(csrInfo(csr.pem).subject).toMatch(/^CN=/);
    expect(pemToDer(csr.pem).equals(csr.der)).toBe(true);
    expect(csr.reference).toBe(sha256Hex(csr.der));
});

test('garbage bytes: deterministic, no PEM line, not a keystore, not DER; its base64 is not the 22-character padded token the guard reads as a uuid', () => {
    const g = garbageBytes();
    expect(g.equals(garbageBytes())).toBe(true);
    expect(g.length).toBe(64);
    expect(g.toString('latin1')).not.toContain('-----BEGIN');
    expect(g[0]).toBe(0xff);
    expect(() => forge.asn1.fromDer(g.toString('binary'))).toThrow();
    expect(g.subarray(0, 4).equals(Buffer.from([0xfe, 0xed, 0xfe, 0xed]))).toBe(false); // JKS magic
    expect(g.subarray(0, 4).equals(Buffer.from([0xce, 0xce, 0xce, 0xce]))).toBe(false); // JCEKS magic
    expect(garbageBytes(10)).toHaveLength(10);
    expect(toBase64(g)).not.toMatch(/^[A-Za-z0-9+/_-]{22}==$/);
    expect(toBase64(garbageBytes(16)), 'the 16-byte trap the doc comment names').toMatch(/^[A-Za-z0-9+/_-]{22}==$/);
});

test('padded certificate PEM: EXACTLY the asked number of bytes at 5 242 880 and 5 242 881; one certificate, no other BEGIN line, comment lines after it', () => {
    for (const n of [LIMITS.fileBytes, LIMITS.fileBytes + 1]) {
        const { file, identity } = paddedCertificatePem(importCn('pad'), n);
        expect(file.length).toBe(n);
        const text = file.toString('ascii');
        expect(blocksOf(text)).toEqual(['CERTIFICATE']);
        expect(text.startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true);
        expect(text.slice(text.indexOf('-----END CERTIFICATE-----') + 26).trim().split('\n').every((l) => l.startsWith('#'))).toBe(true);
        expect(certificateInfo(text.slice(0, text.indexOf('-----END CERTIFICATE-----') + 25)).subject).toBe(`CN=${identity.cn}`);
        expect(containerDigest(file)).toBe(sha256Hex(file));
    }
    expect(LIMITS.fileBytes).toBe(5_242_880);
    expect(() => paddedCertificatePem('x', 10)).toThrow(/cannot hold/);
});

test('bulk bundles: 201 / 200 distinct certificates that all parse; 101 / 100 distinct requests that all parse', () => {
    for (const n of [LIMITS.certificates + 1, LIMITS.certificates]) {
        const { pem, certs } = certificatesInOnePem(n, importCn('bulk'));
        const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
        expect(blocks).toHaveLength(n);
        expect(certs).toHaveLength(n);
        expect(new Set(certs.map((c) => c.fingerprint)).size).toBe(n);
        expect(new Set(certs.map((c) => c.cn)).size).toBe(n);
        for (const idx of [0, n - 1]) expect(certificateInfo(blocks[idx]).subject).toBe(`CN=${certs[idx].cn}`);
        expect(blocksOf(pem).every((t) => t === 'CERTIFICATE')).toBe(true);
    }
    for (const n of [LIMITS.otherEntries + 1, LIMITS.otherEntries]) {
        const { pem, references } = requestsInOnePem(n, importCn('reqs'));
        const blocks = pem.match(/-----BEGIN CERTIFICATE REQUEST-----[\s\S]+?-----END CERTIFICATE REQUEST-----/g) ?? [];
        expect(blocks).toHaveLength(n);
        expect(new Set(references).size).toBe(n);
        expect(references[0]).toBe(sha256Hex(pemToDer(blocks[0]!)));
        expect(csrInfo(blocks[n - 1]).subject).toMatch(/^CN=/);
    }
});

test('texts: the fixed messages as core spells them (retyped from the Java constants), the limit texts built from the constants', () => {
    expect(REFUSAL.notSupportedFormat).toBe('The file is not in a supported format: PKCS#12, JKS, JCEKS, PEM, PKCS#7, a certificate, a certificate request, a PKCS#8 key, an OpenSSL traditional key or an OpenSSH private key.');
    expect(REFUSAL.pemTooManyKeys).toBe('A PEM file can hold at most one private key.');
    expect(REFUSAL.pemBlockUnsupported('DH PARAMETERS')).toBe('The file holds a PEM block of type DH PARAMETERS, which is not supported.');
    expect(REFUSAL.integrityFailed).toBe("The file's integrity check failed: the passphrase is wrong or missing, or the file is damaged.");
    expect(REFUSAL.twoPassphrases).toBe('The file protects its keys with a different passphrase than the file itself, which is not supported.');
    expect(REFUSAL.keyUnreadable).toBe('The key could not be read: the passphrase is wrong or missing, or the file is damaged.');
    expect(REFUSAL.certificateCount).toBe('The file exceeds the certificate count limit of 200.');
    expect(REFUSAL.entryCount).toBe('The file exceeds the entry count limit of 100.');
    expect(limitExceeded('certificate count', LIMITS.certificates)).toBe(REFUSAL.certificateCount);
    expect(REFUSAL.fileTooLarge).toBe('fileWithinLimit file must not exceed 5242880 bytes');
    expect(REFUSAL.fileRequired).toBe('file file is required');
    expect(REFUSAL.tokenProfileNotUuid).toBe('tokenProfileUuid must be a UUID');
    expect(REFUSAL.tokenProfileNotFound('u-1')).toBe("Object of type 'TokenProfile' identified by u-1 is not found.");
    expect(REFUSAL.uploadKeystore).toBe('The file is a keystore. Import it with the certificate import operation.');
    expect(REFUSAL.uploadNotCertificate('CERTIFICATE REQUEST')).toBe('Uploaded PEM encoded content is not certificate. Uploaded PEM type: CERTIFICATE REQUEST');
    expect(REFUSAL.uploadInvalid).toBe('Uploaded certificate content has invalid or unsupported format.');
    expect(REFUSAL.uploadDuplicate('ab')).toBe('Certificate already exists with fingerprint ab');
    expect(REFUSAL.requestNotImported).toBe('Certificate requests are not imported');
    expect(inspectionAlert(422, REFUSAL.pemTooManyKeys)).toBe('Failed to read the uploaded file (422): A PEM file can hold at most one private key.');
    // The two refusals a caller must not tell apart are one string each (non-oracular).
    expect(REFUSAL.integrityFailed).toContain('wrong or missing');
    expect(REFUSAL.keyUnreadable).toContain('wrong or missing');
    // The DH block type is plain enough for core to repeat (KeyFileRefusal.REPEATABLE `[A-Za-z0-9 .-]{1,64}`).
    expect('DH PARAMETERS').toMatch(/^[A-Za-z0-9 .-]{1,64}$/);
});

test('request shapes: upload, inspection (file bytes, a verbatim member, a missing member, passphrase, profile) and import bodies', () => {
    const bytes = Buffer.from('abc');
    expect(uploadBody(bytes)).toEqual({ certificate: 'YWJj', customAttributes: [] });
    expect(uploadBody(bytes, [{ x: 1 }])).toEqual({ certificate: 'YWJj', customAttributes: [{ x: 1 }] });
    expect(inspectionBody(bytes)).toEqual({ file: 'YWJj' });
    expect(inspectionBody(bytes, { passphrase: GEN_PW_5, tokenProfileUuid: 'u' })).toEqual({ file: 'YWJj', passphrase: GEN_PW_5, tokenProfileUuid: 'u' });
    expect(inspectionBody({ raw: 12345 })).toEqual({ file: 12345 });
    expect(inspectionBody(undefined)).toEqual({});
    expect(Object.keys(inspectionBody(undefined, { passphrase: GEN_PW_5 }))).toEqual(['passphrase']);
    expect(importBody(bytes, ['r1', 'r2'])).toEqual({ file: 'YWJj', entries: [{ entryReference: 'r1' }, { entryReference: 'r2' }] });
    expect(JSON.stringify(importBody(bytes, ['r1']))).not.toContain('keyDestination');
    expect(fileMember(bytes)).toBe('YWJj');
    expect(ROUTES).toEqual({ upload: '/api/v1/certificates/upload', uploadAsync: '/api/v1/certificates/upload/async', inspect: '/api/v1/inspections', import: '/api/v1/certificates/import' });
    expect(asFile('a.pem', 'x')).toEqual({ name: 'a.pem', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
    expect(pemBlock('X', Buffer.alloc(100, 1)).split('\n').filter((l) => l && !l.startsWith('-----')).every((l) => l.length <= 64)).toBe(true);
});
