/**
 * seedCertificates — X.509 certificates for the inventory seeds.
 *
 * WHAT: X.509 certificates with a chosen validity, key size, signature hash, issuer and CA flag for the inventory seeds,
 *       built with @peculiar/x509 (loaded lazily). A CA gets basicConstraints cA=true; an end entity gets none, so the platform
 *       classifies each as root CA, intermediate CA, self-signed end entity or end entity. No openssl, no network.
 * WHY: The seed needs certificates with chosen validity, key size, hash, issuer and CA flag.
 * HOW: Built with @peculiar/x509 loaded lazily; a CA gets basicConstraints cA=true, an end entity none; no openssl, no network.
 */
import * as crypto from 'crypto';
import type * as X509 from '@peculiar/x509';
import { loadX509Module, sha256Hex } from '../pkiBuilders';

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
     * The signature hash of a SELF-SIGNED certificate (default SHA-256). An issued certificate is signed with the issuer's key, whose hash
     * is fixed when the key is generated: asking for another hash throws instead of silently signing with the issuer's.
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

/** A date at second precision (X.509 UTCTime / GeneralizedTime carry no milliseconds). */
const dateAtSecond = (d: Date): Date => new Date(Math.floor(d.getTime() / 1000) * 1000);

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
 * One certificate. The key pair is generated here (own key per certificate) unless `keys` is given.
 * Extensions: subjectKeyIdentifier always; authorityKeyIdentifier when issued by another certificate; basicConstraints
 * and keyUsage only for a CA.
 */
export async function buildCertificate(spec: CertificateSpec): Promise<BuiltCertificate> {
    const lib = loadX509Module();
    const keyBits = spec.keyBits ?? 2048;
    if (spec.issuer && spec.hash && spec.hash !== spec.issuer.hash) {
        throw new Error(`buildCertificate: ${spec.commonName} asks for ${spec.hash} but its issuer's key signs with ${spec.issuer.hash}`);
    }
    // The hash of the SIGNATURE is the signing key's: the issuer's, or the certificate's own when self-signed.
    const hash = spec.issuer ? spec.issuer.hash : (spec.hash ?? 'SHA-256');
    const keys = spec.keys ?? (await generateRsa(keyBits, spec.hash ?? hash));
    const serialHex = spec.serialHex ?? `01${crypto.randomBytes(15).toString('hex')}`;
    const notBefore = dateAtSecond(spec.notBefore);
    const notAfter = dateAtSecond(spec.notAfter);
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
        fingerprintSha256: sha256Hex(der),
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
    const lib = loadX509Module();
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
    const lib = loadX509Module();
    const cert = new lib.X509Certificate(certPem);
    const issuer = new lib.X509Certificate(issuerPem);
    return cert.verify({ publicKey: issuer.publicKey, signatureOnly: true });
}
