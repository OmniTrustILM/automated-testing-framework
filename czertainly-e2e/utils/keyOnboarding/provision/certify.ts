// A certificate for a planted public key from a throwaway issuer, made on the runner: the cluster twin of plant-keys.sh's openssl step.
import * as crypto from 'crypto';
import { loadX509Module } from '../../regression/pkiBuilders';

const EC_P256 = { name: 'ECDSA', namedCurve: 'P-256' };
const VALID_DAYS = 30;

/** Base64 DER of a certificate with subject CN=`commonName` for the P-256 SPKI `spkiDer`; throws when it is no P-256 public key. */
export async function certificateForPublicKey(spkiDer: Buffer, commonName: string, now: Date = new Date()): Promise<string> {
    const lib = loadX509Module();
    const subtle = crypto.webcrypto.subtle;
    const publicKey = await subtle.importKey('spki', new Uint8Array(spkiDer), EC_P256, true, ['verify']);
    const issuer = (await subtle.generateKey(EC_P256, false, ['sign', 'verify'])) as crypto.webcrypto.CryptoKeyPair;
    const certificate = await lib.X509CertificateGenerator.create({
        subject: `CN=${commonName}`,
        issuer: `CN=${commonName} issuer`,
        notBefore: now,
        notAfter: new Date(now.getTime() + VALID_DAYS * 86_400_000),
        signingAlgorithm: { ...EC_P256, hash: 'SHA-256' },
        publicKey: publicKey as unknown as CryptoKey,
        signingKey: issuer.privateKey as unknown as CryptoKey,
    });
    return Buffer.from(certificate.rawData).toString('base64');
}
