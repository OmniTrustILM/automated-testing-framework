/**
 * Unit tests for the enrollment helpers: what `/simpleenroll` sends, how a certs-only answer is
 * read and refused, the forwarded certificate header, and the inventory lookups and cleanup
 * against a fake request context.
 */
import { test, expect } from '@playwright/test';
import * as forge from 'node-forge';
import * as https from 'https';
import { AddressInfo } from 'net';
import {
    CERTS_ONLY,
    certificateHasKey,
    cleanupCertificatesByCommonName,
    cleanupEnrolledCertificates,
    derToPem,
    enrolledCertificate,
    findCertificatesByCommonName,
    sendCsr,
    forwardedCertificateHeader,
    getInventoryCertificate,
    issuedIdentityMismatches,
    simpleEnroll,
} from '../../utils/estEnroll';
import { EstResponse } from '../../utils/estHttp';
import { certToDer, certToPem, createCa, createCsr, issueCert, keyToPem, sha256Fingerprint } from '../../utils/estPki';
import { clearCleanupFailures, readCleanupFailures } from '../../utils/cleanupLedger';
import { fakeApi } from './estFakeApi';

const ca = createCa({ cn: 'enroll-unit-ca' });
const issued = issueCert(ca, { subject: 'device' });

function certsOnlyBase64(...certs: forge.pki.Certificate[]): Buffer {
    const p7 = forge.pkcs7.createSignedData();
    certs.forEach((c) => p7.addCertificate(c));
    return Buffer.from(Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary').toString('base64'));
}

function answer(status: number, body: Buffer | string, contentType = CERTS_ONLY): EstResponse {
    return { status, headers: { 'content-type': contentType }, body: Buffer.from(body) };
}

test.beforeEach(() => clearCleanupFailures());
test.afterEach(() => clearCleanupFailures());

test('simpleEnroll posts the CSR as base64 PKCS#10 under the label', async () => {
    const server = issueCert(ca, { subject: 'localhost' });
    const csr = createCsr({ subject: 'device' });
    let seen = '';
    const srv = https.createServer({ cert: certToPem(server.cert), key: keyToPem(server.key) }, (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            seen = `${req.method} ${req.url} ${req.headers['content-type']} ${req.headers.authorization} ${Buffer.concat(chunks)}`;
            res.end();
        });
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = srv.address() as AddressInfo;
        const resp = await simpleEnroll({
            baseUrl: `https://127.0.0.1:${port}`,
            label: 'p1',
            csr,
            basicAuth: { username: 'u', password: 'p' },
        });
        expect(resp.status).toBe(200);
        const basic = Buffer.from('u:p').toString('base64');
        expect(seen).toBe(`POST /.well-known/est/p1/simpleenroll application/pkcs10 Basic ${basic} ${csr.base64}`);
    } finally {
        srv.close();
    }
});

test('the one certificate of a certs-only 200 is returned as DER', () => {
    expect(enrolledCertificate(answer(200, certsOnlyBase64(issued.cert)))).toEqual(certToDer(issued.cert));
});

test('a refusal, a wrong content type or a wrong certificate count is named', () => {
    expect(() => enrolledCertificate(answer(401, 'Authentication is required.'))).toThrow(
        'Enrollment answered 401: Authentication is required.',
    );
    expect(() => enrolledCertificate(answer(200, certsOnlyBase64(issued.cert), 'application/pkcs7-mime'))).toThrow(
        'content type application/pkcs7-mime',
    );
    expect(() => enrolledCertificate(answer(200, certsOnlyBase64(issued.cert, ca.cert)))).toThrow('answered 2 certificates');
});

test('a certificate holds the key it was issued for and no other', () => {
    const der = certToDer(issued.cert);
    expect(certificateHasKey(der, issued.key)).toBe(true);
    expect(certificateHasKey(der, createCsr({ subject: 'other' }).key)).toBe(false);
});

test('the forwarded header is the URL-encoded PEM', () => {
    const pem = certToPem(issued.cert);
    const header = forwardedCertificateHeader(pem)['ssl-client-cert'];
    expect(header).not.toMatch(/[\n /+=]/);
    expect(decodeURIComponent(header)).toBe(pem);
});

test('an inventory certificate is found by fingerprint and read with its RA Profile', async () => {
    const der = certToDer(issued.cert);
    const { api, calls } = fakeApi((call) =>
        call.method === 'POST'
            ? { body: { certificates: [{ uuid: 'c-1' }] } }
            : { body: { state: 'issued', raProfile: { name: 'ra-x' } } },
    );
    expect(await getInventoryCertificate(api, der)).toEqual({ uuid: 'c-1', state: 'issued', raProfileName: 'ra-x' });
    expect(JSON.stringify(calls[0].data)).toContain(sha256Fingerprint(der));
    expect(calls[1].url).toBe('/api/v1/certificates/c-1');
});

test('a certificate missing from the inventory is an error', async () => {
    const { api } = fakeApi(() => ({ body: { certificates: [] } }));
    await expect(getInventoryCertificate(api, certToDer(issued.cert))).rejects.toThrow('No certificate with fingerprint');
});

test('cleanup deletes found certificates, skips gone ones and records failures', async () => {
    const found = certToDer(issued.cert);
    const gone = certToDer(ca.cert);
    const { api, calls } = fakeApi((call) => {
        if (call.method === 'DELETE') return { status: 500, body: 'boom' };
        const wanted = JSON.stringify(call.data).includes(sha256Fingerprint(found));
        return { body: { certificates: wanted ? [{ uuid: 'c-1' }] : [] } };
    });
    await cleanupEnrolledCertificates(api, [gone]);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(readCleanupFailures()).toEqual([]);

    await cleanupEnrolledCertificates(api, [found]);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
        '/api/v1/certificates/c-1',
        '/api/v1/certificates/c-1',
    ]);
    expect(readCleanupFailures()).toMatchObject([{ resource: 'certificate', uuid: sha256Fingerprint(found), status: 500 }]);
});

test('sendCsr posts the CSR to the named operation', async () => {
    const server = issueCert(ca, { subject: 'localhost' });
    const csr = createCsr({ subject: 'device' });
    let seen = '';
    const srv = https.createServer({ cert: certToPem(server.cert), key: keyToPem(server.key) }, (req, res) => {
        seen = `${req.method} ${req.url} ${req.headers['content-type']}`;
        res.end();
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = srv.address() as AddressInfo;
        await sendCsr('simplereenroll', { baseUrl: `https://127.0.0.1:${port}`, label: 'p1', csr });
        expect(seen).toBe('POST /.well-known/est/p1/simplereenroll application/pkcs10');
    } finally {
        srv.close();
    }
});

test('a DER certificate becomes the same certificate in PEM', () => {
    expect(derToPem(certToDer(issued.cert)).replace(/\r/g, '')).toBe(certToPem(issued.cert).replace(/\r/g, ''));
});

test('certificates are found by an exact common name', async () => {
    const { api, calls } = fakeApi(() => ({ body: { certificates: [{ uuid: 'c-1' }, { uuid: 'c-2' }] } }));
    expect(await findCertificatesByCommonName(api, 'cn-1')).toEqual(['c-1', 'c-2']);
    expect(calls[0]).toMatchObject({
        method: 'POST',
        url: '/api/v1/certificates',
        data: { filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: 'cn-1' }] },
    });
});

test('cleanup by common name deletes every match and records a failure', async () => {
    const { api, calls } = fakeApi(({ method }) => (method === 'POST' ? { body: { certificates: [{ uuid: 'c-1' }] } } : undefined));
    await cleanupCertificatesByCommonName(api, 'cn-1');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/v1/certificates/c-1' });
    expect(readCleanupFailures()).toEqual([]);

    const failing = fakeApi(() => ({ status: 500, body: 'boom' }));
    await cleanupCertificatesByCommonName(failing.api, 'cn-1');
    expect(readCleanupFailures()).toMatchObject([{ resource: 'certificate', uuid: 'cn-1', status: 500 }]);
});

test('cleanup by common name still deletes the rest when one delete fails', async () => {
    const { api, calls } = fakeApi(({ method, url }) => {
        if (method === 'POST') return { body: { certificates: [{ uuid: 'c-1' }, { uuid: 'c-2' }] } };
        if (method === 'DELETE' && url.endsWith('/c-1')) return { status: 500, body: 'boom' };
        return undefined;
    });
    await cleanupCertificatesByCommonName(api, 'cn-1');
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/certificates/c-2')).toBe(true);
    expect(readCleanupFailures()).toMatchObject([{ resource: 'certificate', uuid: 'c-1', status: 500 }]);
});

test('the issued identity matches when subject and DNS names are all there', () => {
    const subject = [{ name: 'commonName', value: 'd' }, { name: 'organizationName', value: 'Org' }];
    const csr = createCsr({ subject, sans: ['d.est.test'] });
    const cert = certToDer(issueCert(ca, { subject, sans: ['d.est.test'] }).cert);
    expect(issuedIdentityMismatches(cert, csr.der)).toEqual([]);
});

test('a missing subject attribute is reported', () => {
    const csr = createCsr({ subject: [{ name: 'commonName', value: 'd' }, { name: 'organizationName', value: 'Org' }] });
    const cert = certToDer(issueCert(ca, { subject: 'd' }).cert);
    expect(issuedIdentityMismatches(cert, csr.der)).toEqual(['subject O=Org not issued']);
});

test('a DNS name that only extends the requested one is a mismatch', () => {
    const csr = createCsr({ subject: 'd', sans: ['d.est.test'] });
    const cert = certToDer(issueCert(ca, { subject: 'd', sans: ['d.est.test.attacker.invalid'] }).cert);
    expect(issuedIdentityMismatches(cert, csr.der)).toEqual(['DNS name d.est.test not issued']);
});
