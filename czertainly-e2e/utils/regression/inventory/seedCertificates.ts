/**
 * seedCertificates — X.509 certificates for the inventory seeds, built with @peculiar/x509 (lazy; no openssl, no network); a CA gets
 * basicConstraints cA=true, an end entity none.
 */
import * as crypto from 'crypto';
import type * as X509 from '@peculiar/x509';
import { loadX509Module, sha256Hex } from '../pkiBuilders';

export type KeyBits = 2048 | 3072 | 4096;
export type SignatureHash = 'SHA-256' | 'SHA-384' | 'SHA-512';

export interface IssuerHandle {
    subject: string;
    /** The hash the issuer's key signs with (WebCrypto binds the key to its hash at generation). */
    hash: SignatureHash;
    privateKey: CryptoKey;
    publicKey: CryptoKey;
}

export interface CertificateSpec {
    commonName: string;
    notBefore: Date;
    notAfter: Date;
    keyBits?: KeyBits;
    /** The hash of a SELF-SIGNED certificate (default SHA-256); an issued one uses the issuer's, and asking for another throws. */
    hash?: SignatureHash;
    issuer?: IssuerHandle;
    ca?: boolean;
    serialHex?: string;
    /** Reuse a key pair (leaves always get their own key). */
    keys?: CryptoKeyPair;
}

export interface BuiltCertificate {
    pem: string;
    der: Buffer;
    fingerprintSha256: string;
    serialHex: string;
    keyBits: KeyBits;
    hash: SignatureHash;
    handle: IssuerHandle;
    commonName: string;
    notBefore: Date;
    notAfter: Date;
}

const dateAtSecond = (d: Date): Date => new Date(Math.floor(d.getTime() / 1000) * 1000);

async function generateRsa(bits: KeyBits, hash: SignatureHash): Promise<CryptoKeyPair> {
    return (await crypto.webcrypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash },
        true,
        ['sign', 'verify'],
    )) as unknown as CryptoKeyPair;
}

export const generateKeys = generateRsa;

/**
 * One certificate with a fresh key pair unless `keys` is given; extensions: subjectKeyIdentifier, authorityKeyIdentifier when issued,
 * basicConstraints and keyUsage for a CA.
 */
export async function buildCertificate(spec: CertificateSpec): Promise<BuiltCertificate> {
    const lib = loadX509Module();
    const keyBits = spec.keyBits ?? 2048;
    if (spec.issuer && spec.hash && spec.hash !== spec.issuer.hash) {
        throw new Error(`buildCertificate: ${spec.commonName} asks for ${spec.hash} but its issuer's key signs with ${spec.issuer.hash}`);
    }
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

export async function verifiesUnder(certPem: string, issuerPem: string): Promise<boolean> {
    const lib = loadX509Module();
    const cert = new lib.X509Certificate(certPem);
    const issuer = new lib.X509Certificate(issuerPem);
    return cert.verify({ publicKey: issuer.publicKey, signatureOnly: true });
}
