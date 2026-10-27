/**
 * Unit tests of utils/regression/inventory/seedCertificates.ts: certificates built with a chosen validity, key
 * size, hash and issuer. No environment, no network.
 */
import { expect, test } from '@playwright/test';
import * as crypto from 'crypto';
import { buildCertificate, describeCertificate, generateKeys, verifiesUnder } from '../../utils/regression/inventory/seedCertificates';

// ------------------------------------------------------------------ pure: seedCertificates

test('buildCertificate: validity at second precision, key size, hash, self-signed vs issued, the CA flag', async () => {
    test.setTimeout(60_000);
    const ca = await buildCertificate({ commonName: 'ca-root-test', notBefore: new Date('2026-09-01T00:00:00.789Z'), notAfter: new Date('2027-09-01T00:00:00Z'), ca: true });
    const leaf = await buildCertificate({
        commonName: 'leaf-test', notBefore: new Date('2026-09-02T00:00:00Z'), notAfter: new Date('2027-01-01T00:00:00Z'), keyBits: 3072, issuer: ca.handle,
    });
    const self = await buildCertificate({ commonName: 'self-test', notBefore: new Date('2026-09-02T00:00:00Z'), notAfter: new Date('2027-01-01T00:00:00Z'), hash: 'SHA-512' });
    const dCa = describeCertificate(ca.pem);
    expect(dCa).toMatchObject({ subject: 'CN=ca-root-test', issuer: 'CN=ca-root-test', keyBits: 2048, isCa: true });
    expect(dCa.notBefore.toISOString(), 'seconds precision').toBe('2026-09-01T00:00:00.000Z');
    expect(describeCertificate(leaf.pem)).toMatchObject({ subject: 'CN=leaf-test', issuer: 'CN=ca-root-test', keyBits: 3072, isCa: false, hash: 'SHA-256' });
    expect(describeCertificate(self.pem)).toMatchObject({ subject: 'CN=self-test', issuer: 'CN=self-test', isCa: false, hash: 'SHA-512' });
    expect(await verifiesUnder(leaf.pem, ca.pem), 'the leaf is signed by the CA').toBe(true);
    expect(await verifiesUnder(self.pem, ca.pem), 'a self-signed certificate does not verify under another key').toBe(false);
    expect(await verifiesUnder(self.pem, self.pem), 'and verifies under its own').toBe(true);
    expect(ca.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ca.fingerprintSha256).toBe(crypto.createHash('sha256').update(ca.der).digest('hex'));
    await expect(buildCertificate({ commonName: 'wrong-hash', notBefore: new Date('2026-09-02T00:00:00Z'), notAfter: new Date('2027-01-01T00:00:00Z'), hash: 'SHA-384', issuer: ca.handle }))
        .rejects.toThrow(/asks for SHA-384 but its issuer's key signs with SHA-256/);
    await expect(buildCertificate({ commonName: 'bad', notBefore: new Date('2026-09-02T00:00:00Z'), notAfter: new Date('2026-09-01T00:00:00Z') })).rejects.toThrow(/notAfter must be after notBefore/);
    expect(await generateKeys(2048, 'SHA-256')).toBeTruthy();
});
