/**
 * Unit tests for the EST PKI helpers: certificates and CSRs built here must parse back with the
 * properties the specs rely on, and the response parsers must read what EST sends.
 */
import { test, expect } from '@playwright/test';
import * as forge from 'node-forge';
import {
    certToDer,
    certToPem,
    createCa,
    createCsr,
    derToCert,
    isDerCsrAttrs,
    issueCert,
    keyMatchesCert,
    keyToPem,
    parseCertsOnly,
    parseCertsOnlyDer,
    parseMultipartMixed,
    parsePkcs8Der,
    sha256Fingerprint,
} from '../../utils/estPki';

const ca = createCa({ cn: 'unit-ca' });

function certsOnly(...certs: forge.pki.Certificate[]): Buffer {
    const p7 = forge.pkcs7.createSignedData();
    certs.forEach((c) => p7.addCertificate(c));
    return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

test('a CA is self-signed, a CA, valid for the requested days', () => {
    const short = createCa({ cn: 'short', validityDays: 2 });
    expect(short.cert.subject.getField('CN').value).toBe('short');
    expect(short.cert.verify(short.cert)).toBe(true);
    expect((short.cert.getExtension('basicConstraints') as { cA: boolean }).cA).toBe(true);
    const days = (short.cert.validity.notAfter.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(1);
    expect(days).toBeLessThan(2.1);
    expect(ca.cert.validity.notAfter.getTime()).toBeGreaterThan(Date.now() + 300 * 86_400_000);
});

test('an issued certificate carries subject, SANs, EKU names and dotted OIDs', () => {
    const { cert } = issueCert(ca, {
        subject: 'host.example.com',
        sans: ['host.example.com', 'alt.example.com'],
        eku: ['clientAuth', '1.3.6.1.5.5.7.3.28'],
    });
    expect(ca.cert.verify(cert)).toBe(true);
    expect(cert.subject.getField('CN').value).toBe('host.example.com');
    const san = cert.getExtension('subjectAltName') as { altNames: Array<{ value: string }> };
    expect(san.altNames.map((a) => a.value)).toEqual(['host.example.com', 'alt.example.com']);
    const eku = cert.getExtension('extKeyUsage') as Record<string, unknown>;
    expect(eku.clientAuth).toBe(true);
    expect(eku['1.3.6.1.5.5.7.3.28']).toBe(true);
});

test('an issued certificate takes explicit validity, a subject list and a supplied key', () => {
    const first = issueCert(ca, { subject: 'one' });
    const notBefore = new Date('2020-01-01T00:00:00Z');
    const notAfter = new Date('2020-01-02T00:00:00Z');
    const { cert, key } = issueCert(ca, {
        subject: [{ name: 'commonName', value: 'two' }, { name: 'organizationName', value: 'Org' }],
        notBefore,
        notAfter,
        key: first.key,
    });
    expect(cert.validity.notBefore.getTime()).toBe(notBefore.getTime());
    expect(cert.validity.notAfter.getTime()).toBe(notAfter.getTime());
    expect(cert.subject.getField('O').value).toBe('Org');
    expect(key).toBe(first.key);
    expect(cert.getExtension('subjectAltName')).toBeNull();
    expect(cert.getExtension('extKeyUsage')).toBeNull();
});

test('a CSR is DER, base64 of it, verifiable, with SANs only when asked', () => {
    const csr = createCsr({ subject: 'csr.example.com', sans: ['csr.example.com'] });
    expect(csr.base64).toBe(csr.der.toString('base64'));
    const parsed = forge.pki.certificationRequestFromAsn1(forge.asn1.fromDer(csr.der.toString('binary')));
    expect(parsed.verify()).toBe(true);
    expect(parsed.subject.getField('CN').value).toBe('csr.example.com');
    expect(JSON.stringify(parsed.getAttribute({ name: 'extensionRequest' }))).toContain('csr.example.com');

    const plain = createCsr({ subject: 'plain', key: csr.key });
    expect(plain.key).toBe(csr.key);
    const plainParsed = forge.pki.certificationRequestFromAsn1(forge.asn1.fromDer(plain.der.toString('binary')));
    expect(plainParsed.getAttribute({ name: 'extensionRequest' })).toBeNull();
});

test('DER and PEM conversions round-trip and the fingerprint is lowercase SHA-256 of the DER', () => {
    const { cert } = issueCert(ca, { subject: 'conv' });
    const der = certToDer(cert);
    expect(derToCert(der).serialNumber).toBe(cert.serialNumber);
    expect(certToPem(cert)).toContain('BEGIN CERTIFICATE');
    const fp = sha256Fingerprint(cert);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Fingerprint(der)).toBe(fp);
});

test('a key is matched to its certificate, as a forge key or as PKCS#8 DER', () => {
    const { cert, key } = issueCert(ca, { subject: 'match' });
    const other = issueCert(ca, { subject: 'other' });
    expect(keyToPem(key)).toContain('PRIVATE KEY');
    expect(keyMatchesCert(key.privateKey, cert)).toBe(true);
    expect(keyMatchesCert(other.key.privateKey, cert)).toBe(false);

    const pkcs8 = Buffer.from(
        forge.asn1.toDer(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key.privateKey))).getBytes(),
        'binary',
    );
    expect(parsePkcs8Der(pkcs8).n.equals(key.publicKey.n)).toBe(true);
    expect(keyMatchesCert(pkcs8, cert)).toBe(true);
    expect(keyMatchesCert(pkcs8, other.cert)).toBe(false);
});

test('a certs-only PKCS#7 yields its certificates', () => {
    const a = issueCert(ca, { subject: 'a' }).cert;
    const parsed = parseCertsOnly(certsOnly(ca.cert, a));
    expect(parsed.map((c) => sha256Fingerprint(c))).toEqual([sha256Fingerprint(ca.cert), sha256Fingerprint(a)]);
});

test('a certs-only PKCS#7 yields the DER of its certificates, and none when it holds none', () => {
    const a = issueCert(ca, { subject: 'a' }).cert;
    const ders = parseCertsOnlyDer(certsOnly(ca.cert, a));
    expect(ders.map((d) => sha256Fingerprint(d))).toEqual([sha256Fingerprint(ca.cert), sha256Fingerprint(a)]);

    const empty = forge.pkcs7.createSignedData();
    const emptyDer = Buffer.from(forge.asn1.toDer(empty.toAsn1()).getBytes(), 'binary');
    expect(parseCertsOnlyDer(emptyDer)).toEqual([]);
});

const asn1 = forge.asn1;
const oid = (value: string) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(value).getBytes());
const sequence = (...items: forge.asn1.Asn1[]) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, items);
const set = (...items: forge.asn1.Asn1[]) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, items);
const der = (node: forge.asn1.Asn1) => Buffer.from(asn1.toDer(node).getBytes(), 'binary');

/** A certs-only message with one part of its structure altered by `alter`. */
function tamperedCertsOnly(alter: (contentInfo: forge.asn1.Asn1, signedData: forge.asn1.Asn1[]) => void): Buffer {
    const contentInfo = asn1.fromDer(forge.util.createBuffer(certsOnly(ca.cert).toString('binary')));
    const signedData = ((contentInfo.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
    alter(contentInfo, signedData);
    return der(contentInfo);
}

test('a PKCS#7 that is not certs-only is refused', () => {
    const withSigner = tamperedCertsOnly((_, signedData) => {
        signedData[signedData.length - 1].value = [sequence()];
    });
    expect(() => parseCertsOnlyDer(withSigner)).toThrow(/carries signers/);

    const withContent = tamperedCertsOnly((_, signedData) => {
        (signedData[2].value as forge.asn1.Asn1[]).push(
            asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, 'x')]),
        );
    });
    expect(() => parseCertsOnlyDer(withContent)).toThrow(/carries content/);

    const notSignedData = tamperedCertsOnly((contentInfo) => {
        (contentInfo.value as forge.asn1.Asn1[])[0] = oid('1.2.840.113549.1.7.1');
    });
    expect(() => parseCertsOnlyDer(notSignedData)).toThrow(/Not a PKCS#7 SignedData/);
});

test('CsrAttrs is a SEQUENCE of OIDs and Attributes, and nothing else', () => {
    expect(isDerCsrAttrs(der(sequence())), 'empty').toBe(true);
    expect(isDerCsrAttrs(der(sequence(oid('1.2.840.113549.1.9.7')))), 'an OID').toBe(true);
    expect(isDerCsrAttrs(der(sequence(sequence(oid('1.2.840.113549.1.9.14'), set())))), 'an Attribute').toBe(true);
    expect(isDerCsrAttrs(der(sequence(oid('1.2.840.113549.1.9.7'), sequence(oid('1.2.3'), set())))), 'both').toBe(true);
    expect(isDerCsrAttrs(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x05])), 'an INTEGER element').toBe(false);
    expect(isDerCsrAttrs(der(sequence(sequence(oid('1.2.3'))))), 'an Attribute without values').toBe(false);
    expect(isDerCsrAttrs(der(sequence(sequence(set(), set())))), 'an Attribute without an OID').toBe(false);
    expect(isDerCsrAttrs(Buffer.from('300a30080601 2a3100020105'.replace(' ', ''), 'hex')), 'an Attribute with a third part').toBe(false);
    expect(isDerCsrAttrs(Buffer.from([0x30, 0x02, 0x06, 0x00])), 'an empty OID').toBe(false);
    expect(isDerCsrAttrs(Buffer.from([0x30, 0x03, 0x06, 0x01, 0x81])), 'an unterminated OID').toBe(false);
    expect(isDerCsrAttrs(Buffer.from([0x02, 0x01, 0x05])), 'an INTEGER').toBe(false);
    expect(isDerCsrAttrs(Buffer.from('not der')), 'garbage').toBe(false);
});

test('multipart/mixed is split with CRLF, preamble, quoted boundary and base64 parts', () => {
    const raw = Buffer.from([0x00, 0xff, 0x10, 0x80]);
    const body = Buffer.from(
        'preamble text\r\n' +
            '--bnd\r\n' +
            'Content-Type: application/pkcs8\r\n' +
            'Content-Transfer-Encoding: base64\r\n' +
            '\r\n' +
            `${raw.toString('base64').slice(0, 4)}\r\n${raw.toString('base64').slice(4)}\r\n` +
            '--bnd\r\n' +
            'Content-Type: application/pkcs7-mime; smime-type=certs-only\r\n' +
            '\r\n' +
            'plain body\r\n' +
            '--bnd--\r\n',
    );
    const parts = parseMultipartMixed('multipart/mixed; boundary="bnd"', body);
    expect(parts).toHaveLength(2);
    expect(parts[0].contentType).toBe('application/pkcs8');
    expect(parts[0].body.equals(raw)).toBe(true);
    expect(parts[1].contentType).toBe('application/pkcs7-mime');
    expect(parts[1].headers['content-type']).toContain('certs-only');
    expect(parts[1].body.toString()).toBe('plain body');
});

test('multipart parts separated by bare LF parse as well, and a headerless part has no type', () => {
    const body = Buffer.from('--b\nX-Note: hi\n\ndata\n--b--\n');
    const parts = parseMultipartMixed('multipart/mixed; boundary=b', body);
    expect(parts).toHaveLength(1);
    expect(parts[0].contentType).toBe('');
    expect(parts[0].headers['x-note']).toBe('hi');
    expect(parts[0].body.toString()).toBe('data');
});

test('malformed multipart bodies are rejected', () => {
    expect(() => parseMultipartMixed('multipart/mixed', Buffer.from('x'))).toThrow(/boundary/);
    expect(() => parseMultipartMixed('multipart/mixed; boundary=b', Buffer.from('--b\r\nno separator'))).toThrow(/separator/);
    expect(() => parseMultipartMixed('multipart/mixed; boundary=b', Buffer.from('--b\r\nX: y\r\n\r\nbody\r\n'))).toThrow(/closing delimiter/);
});
