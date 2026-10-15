/**
 * inventoryPki — X.509 certificates with chosen validity, key size, signature hash, issuer and CA flag, for the inventory
 * seeds (SEED-A / B / C, phase-05 §4 B2 "pki.ts: seed certificates with chosen validity / key size / hash / issuer").
 * It is a new module instead of a patch to pki.ts (six area agents share pki.ts); `@peculiar/x509` (WebCrypto, native
 * RSA key generation) is loaded lazily with `reflect-metadata`, like pki.ts does (B0 §7 #5). No openssl, no network.
 *
 * What the platform derives from a certificate (core CertificateUtil.getCertificateSubjectType :188-207, read for this
 * module): a certificate is a CA when `getBasicConstraints() >= 0` (a basicConstraints extension with cA true), and
 * self-signed when subject DN = issuer DN AND its signature verifies with its own key; then
 *   CA + self-signed            -> rootCa
 *   CA + issued by another      -> intermediateCa
 *   not CA + self-signed        -> selfSignedEndEntity
 *   not CA + issued by another  -> endEntity
 * `buildCertificate` follows that: `ca: true` writes basicConstraints cA=true (+ keyCertSign), an end-entity gets no
 * basicConstraints at all (the common shape of a plain self-signed upload).
 */
import * as crypto from 'crypto';
import type * as X509 from '@peculiar/x509';

export type KeyBits = 2048 | 3072 | 4096;
export type SignatureHash = 'SHA-256' | 'SHA-384' | 'SHA-512';

/** What a certificate can sign with: its subject and private key (kept in memory only). */
export interface IssuerHandle {
    /** Distinguished name as `CN=<commonName>`. */
    subject: string;
    /** The hash the issuer's key signs with: WebCrypto binds an RSASSA-PKCS1-v1_5 key to its hash at generation time. */
    hash: SignatureHash;
    privateKey: CryptoKey;
    publicKey: CryptoKey;
}

export interface CertificateSpec {
    commonName: string;
    notBefore: Date;
    notAfter: Date;
    keyBits?: KeyBits;
    /**
     * The signature hash of a SELF-SIGNED certificate (default SHA-256). An issued certificate is signed with the issuer's
     * key, whose hash is fixed when the key is generated: asking for another hash throws instead of silently signing with
     * the issuer's.
     */
    hash?: SignatureHash;
    /** Signed by this issuer; default: self-signed. */
    issuer?: IssuerHandle;
    /** basicConstraints cA=true and keyCertSign (a CA certificate). */
    ca?: boolean;
    /** Serial number as hex (default: random, positive). */
    serialHex?: string;
    /** Reuse a key pair (a CA signing several leaves is NOT this: leaves always get their own key). */
    keys?: CryptoKeyPair;
}

export interface BuiltCertificate {
    pem: string;
    der: Buffer;
    /** Lowercase hex SHA-256 of the DER: the inventory fingerprint and the import entryReference. */
    fingerprintSha256: string;
    serialHex: string;
    keyBits: KeyBits;
    hash: SignatureHash;
    /** Handle to sign other certificates with. */
    handle: IssuerHandle;
    commonName: string;
    notBefore: Date;
    notAfter: Date;
}

let lib: typeof X509 | undefined;

function x509(): typeof X509 {
    if (!lib) {
        require('reflect-metadata');
        lib = require('@peculiar/x509') as typeof X509;
        lib.cryptoProvider.set(crypto.webcrypto as unknown as Crypto);
    }
    return lib;
}

/** A date at second precision (X.509 UTCTime / GeneralizedTime carry no milliseconds). */
export const atSecond = (d: Date): Date => new Date(Math.floor(d.getTime() / 1000) * 1000);

async function generateRsa(bits: KeyBits, hash: SignatureHash): Promise<CryptoKeyPair> {
    return (await crypto.webcrypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash },
        true,
        ['sign', 'verify'],
    )) as unknown as CryptoKeyPair;
}

/** A fresh RSA key pair (native; 2048 bits in ~0.1 s, 4096 in a few seconds). */
export const generateKeys = generateRsa;

/**
 * One certificate. The key pair is generated here (own key per certificate, phase-03 §2.1) unless `keys` is given.
 * Extensions: subjectKeyIdentifier always; authorityKeyIdentifier when issued by another certificate; basicConstraints
 * and keyUsage only for a CA.
 */
export async function buildCertificate(spec: CertificateSpec): Promise<BuiltCertificate> {
    const lib = x509();
    const keyBits = spec.keyBits ?? 2048;
    if (spec.issuer && spec.hash && spec.hash !== spec.issuer.hash) {
        throw new Error(`buildCertificate: ${spec.commonName} asks for ${spec.hash} but its issuer's key signs with ${spec.issuer.hash}`);
    }
    // The hash of the SIGNATURE is the signing key's: the issuer's, or the certificate's own when self-signed.
    const hash = spec.issuer ? spec.issuer.hash : (spec.hash ?? 'SHA-256');
    const keys = spec.keys ?? (await generateRsa(keyBits, spec.hash ?? hash));
    const serialHex = spec.serialHex ?? `01${crypto.randomBytes(15).toString('hex')}`;
    const notBefore = atSecond(spec.notBefore);
    const notAfter = atSecond(spec.notAfter);
    if (notAfter.getTime() <= notBefore.getTime()) throw new Error(`buildCertificate: notAfter must be after notBefore (${spec.commonName})`);
    const subject = `CN=${spec.commonName}`;
    const issuer = spec.issuer;
    const extensions: X509.Extension[] = [await lib.SubjectKeyIdentifierExtension.create(keys.publicKey)];
    if (spec.ca) {
        extensions.push(new lib.BasicConstraintsExtension(true, undefined, true));
        extensions.push(new lib.KeyUsagesExtension(lib.KeyUsageFlags.keyCertSign | lib.KeyUsageFlags.cRLSign, true));
    }
    if (issuer) extensions.push(await lib.AuthorityKeyIdentifierExtension.create(issuer.publicKey));
    const signingAlgorithm = { name: 'RSASSA-PKCS1-v1_5', hash };
    const cert = await lib.X509CertificateGenerator.create({
        serialNumber: serialHex,
        subject,
        issuer: issuer ? issuer.subject : subject,
        notBefore,
        notAfter,
        signingAlgorithm,
        publicKey: keys.publicKey,
        signingKey: issuer ? issuer.privateKey : keys.privateKey,
        extensions,
    });
    const der = Buffer.from(cert.rawData);
    return {
        pem: cert.toString('pem'),
        der,
        fingerprintSha256: crypto.createHash('sha256').update(der).digest('hex'),
        serialHex,
        keyBits,
        hash,
        handle: { subject, hash: spec.keys ? hash : (spec.hash ?? hash), privateKey: keys.privateKey, publicKey: keys.publicKey },
        commonName: spec.commonName,
        notBefore,
        notAfter,
    };
}

/** What a parsed certificate says (for the unit tests and the manifest read-back checks). */
export function describeCertificate(pemOrDer: string | Buffer): {
    subject: string;
    issuer: string;
    notBefore: Date;
    notAfter: Date;
    keyBits: number;
    hash: string;
    isCa: boolean;
    serialHex: string;
} {
    const lib = x509();
    const cert = new lib.X509Certificate(typeof pemOrDer === 'string' ? pemOrDer : new Uint8Array(pemOrDer));
    const bc = cert.getExtension(lib.BasicConstraintsExtension);
    const alg = cert.publicKey.algorithm as unknown as { modulusLength?: number };
    return {
        subject: cert.subject,
        issuer: cert.issuer,
        notBefore: cert.notBefore,
        notAfter: cert.notAfter,
        keyBits: alg.modulusLength ?? 0,
        hash: String((cert.signatureAlgorithm as unknown as { hash?: { name?: string } }).hash?.name ?? ''),
        isCa: !!bc?.ca,
        serialHex: cert.serialNumber,
    };
}

/** Does `cert` verify under `issuer`'s public key (the signature check core runs to call a certificate self-signed)? */
export async function verifiesUnder(certPem: string, issuerPem: string): Promise<boolean> {
    const lib = x509();
    const cert = new lib.X509Certificate(certPem);
    const issuer = new lib.X509Certificate(issuerPem);
    return cert.verify({ publicKey: issuer.publicKey, signatureOnly: true });
}
