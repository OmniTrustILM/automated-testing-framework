/**
 * Unit tests for the server key generation helpers: reading a `multipart/mixed` answer, matching a
 * private key to a certificate, and the key lookups, deletion and key-recovery attributes against
 * a fake request context.
 */
import { test, expect } from '@playwright/test';
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import { EstResponse } from '../../utils/estHttp';
import { certToDer, createCa, issueCert, keyToPem } from '../../utils/estPki';
import {
    certificatePublicKey,
    deleteTokenKey,
    ecdsaKeyRecoveryAttributes,
    getCertificateKey,
    PKCS8,
    privateKeyMatchesCertificate,
    serverGeneratedKey,
} from '../../utils/estServerKeygen';
import { fakeApi } from './estFakeApi';

const ca = createCa({ cn: 'skg-unit-ca' });
const issued = issueCert(ca, { subject: 'device' });
const certificate = certToDer(issued.cert);
const pkcs8 = crypto.createPrivateKey(keyToPem(issued.key)).export({ type: 'pkcs8', format: 'der' });

function certsOnly(...certs: forge.pki.Certificate[]): Buffer {
    const p7 = forge.pkcs7.createSignedData();
    certs.forEach((c) => p7.addCertificate(c));
    return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

function multipart(parts: Array<[string, Buffer]>, status = 200): EstResponse {
    const body = parts
        .map(([type, data]) => `--b1\r\nContent-Type: ${type}\r\nContent-Transfer-Encoding: base64\r\n\r\n${data.toString('base64')}\r\n`)
        .join('');
    return { status, headers: { 'content-type': 'multipart/mixed; boundary=b1' }, body: Buffer.from(`${body}--b1--\r\n`) };
}

test.describe('reading the answer', () => {
    test('a key part and a certs-only part give the key and the one certificate', () => {
        const answer = multipart([[PKCS8, pkcs8], ['application/pkcs7-mime; smime-type=certs-only', certsOnly(issued.cert)]]);
        expect(serverGeneratedKey(answer)).toEqual({ key: pkcs8, certificate });
    });

    test('a refusal, missing parts or several certificates are named', () => {
        const refusal = { status: 403, headers: {}, body: Buffer.from('Server-side key generation is not enabled.') };
        expect(() => serverGeneratedKey(refusal)).toThrow('answered 403: Server-side key generation is not enabled.');
        expect(() => serverGeneratedKey(multipart([[PKCS8, pkcs8]]))).toThrow('answered parts: application/pkcs8');
        const two = multipart([[PKCS8, pkcs8], ['application/pkcs7-mime', certsOnly(issued.cert, ca.cert)]]);
        expect(() => serverGeneratedKey(two)).toThrow('answered 2 certificates');
    });

    test('a private key matches its own certificate and no other', () => {
        expect(privateKeyMatchesCertificate(pkcs8, certificate)).toBe(true);
        expect(privateKeyMatchesCertificate(pkcs8, certToDer(ca.cert))).toBe(false);
    });
});

test.describe('inventory keys', () => {
    test('a certificate without a key has none', async () => {
        const { api } = fakeApi(() => ({ body: {} }));
        expect(await getCertificateKey(api, 'c-1')).toBeUndefined();
    });

    test('a linked key is read with its token profile, private item and public key', async () => {
        const spki = certificatePublicKey(certificate);
        const { api, calls } = fakeApi(({ url }) =>
            url === '/api/v1/certificates/c-1'
                ? { body: { key: { uuid: 'k-1' } } }
                : { body: { tokenProfileUuid: 'tp', items: [{ type: 'Private' }, { type: 'Public', keyData: spki.toString('base64') }] } },
        );
        expect(await getCertificateKey(api, 'c-1')).toEqual({ uuid: 'k-1', tokenProfileUuid: 'tp', hasPrivateKey: true, publicKey: spki });
        expect(calls[1].url).toBe('/api/v1/keys/k-1');
    });

    test('a public-only key has no private item and may lack key data', async () => {
        const { api } = fakeApi(({ url }) =>
            url.startsWith('/api/v1/certificates/') ? { body: { key: { uuid: 'k-1' } } } : { body: { items: [{ type: 'Public' }] } },
        );
        expect(await getCertificateKey(api, 'c-1')).toEqual({ uuid: 'k-1', tokenProfileUuid: undefined, hasPrivateKey: false, publicKey: undefined });
    });

    test('a key is deleted, and must be gone afterwards', async () => {
        const gone = fakeApi(({ method }) => (method === 'GET' ? { status: 404 } : undefined));
        await deleteTokenKey(gone.api, 'k-1');
        expect(gone.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['DELETE /api/v1/keys/k-1', 'GET /api/v1/keys/k-1']);

        const kept = fakeApi(() => undefined);
        await expect(deleteTokenKey(kept.api, 'k-1')).rejects.toThrow('left the key in the inventory: 200');
    });

    test('key-recovery attributes run the curve callback on the token profile first', async () => {
        const { api, calls } = fakeApi();
        const attributes = await ecdsaKeyRecoveryAttributes(api, 'tp');
        expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/v1/keys/tp/callback', data: { name: 'group_keySpecV2' } });
        expect(attributes).toMatchObject([
            { name: 'data_keyAlgorithm', content: [{ data: 'ECDSA' }] },
            { name: 'data_ecdsaCurve', content: [{ data: 'secp256r1' }] },
        ]);
    });
});
