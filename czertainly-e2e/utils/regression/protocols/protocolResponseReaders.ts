/**
 * protocolResponseReaders — pure readers of protocol answers: the degenerate PKCS#7 of a SCEP GetCACert, the GetCACaps list, CA-chain
 * checks and certificate facts.
 */
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import { fromDerRaw } from './cmpMessageParser';
import { derToPem, pemToDer, sha256Hex } from '../pkiBuilders';

export function parseGetCaCaps(text: string): string[] {
    return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

export interface Pkcs7Certificate {
    pem: string;
    fingerprint: string;
    subject: string;
    issuer: string;
}

const dnLine = (s: string): string => s.split('\n').filter((l) => l).join(', ');

function x509Facts(der: Buffer): Pkcs7Certificate {
    const cert = new crypto.X509Certificate(der);
    return { pem: derToPem(der), fingerprint: sha256Hex(der), subject: dnLine(cert.subject), issuer: dnLine(cert.issuer) };
}

type Asn1 = forge.asn1.Asn1;
const SIGNED_DATA_OID = '1.2.840.113549.1.7.2';

/** The certificates of a degenerate PKCS#7 (SignedData with certificates, no signers), in message order; throws when the bytes are not one. */
export function parseDegeneratePkcs7(der: Buffer): Pkcs7Certificate[] {
    const a = forge.asn1;
    const root = fromDerRaw(der);
    const kids = (n: Asn1): Asn1[] => (Array.isArray(n.value) ? (n.value as Asn1[]) : []);
    const [oidNode, contentNode] = kids(root);
    const oid = oidNode && oidNode.type === a.Type.OID ? a.derToOid(oidNode.value as string) : undefined;
    if (oid !== SIGNED_DATA_OID) throw new Error(`not a PKCS#7 SignedData (content type ${oid ?? 'unreadable'})`);
    const signedData = kids(contentNode ?? ({} as Asn1))[0];
    if (!signedData) throw new Error('PKCS#7 SignedData without content');
    const certSet = kids(signedData).find((n) => n.tagClass === a.Class.CONTEXT_SPECIFIC && n.type === 0);
    if (!certSet) return [];
    return kids(certSet).map((c) => x509Facts(Buffer.from(a.toDer(c).getBytes(), 'binary')));
}

/**
 * Why `certificates` is not the set a SCEP GetCACert must carry (the CA
 * certificate plus its chain): set equality by fingerprint. Empty = equal.
 */
export function scepCaSetProblems(certificates: Pkcs7Certificate[], expectedFingerprints: string[]): string[] {
    const got = new Set(certificates.map((c) => c.fingerprint));
    const want = new Set(expectedFingerprints.map((f) => f.toLowerCase()));
    const problems: string[] = [];
    for (const f of want) if (!got.has(f)) problems.push(`missing ${f}`);
    for (const f of got) if (!want.has(f)) problems.push(`unexpected ${f}`);
    return problems;
}

/** A degenerate PKCS#7 holding the given PEM certificates: a fixture for unit tests and malformed-request pins only. */
export function degeneratePkcs7Of(certificatePems: string[]): Buffer {
    const a = forge.asn1;
    const node = (cls: number, type: number, constructed: boolean, value: Asn1[] | string): Asn1 => a.create(cls, type, constructed, value);
    const certs = certificatePems.map((pem) => fromDerRaw(pemToDer(pem)));
    const signedData = node(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
        node(a.Class.UNIVERSAL, a.Type.INTEGER, false, String.fromCharCode(1)),
        node(a.Class.UNIVERSAL, a.Type.SET, true, []),
        node(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [node(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer(forge.pki.oids.data).getBytes())]),
        node(a.Class.CONTEXT_SPECIFIC, 0, true, certs),
        node(a.Class.UNIVERSAL, a.Type.SET, true, []),
    ]);
    const contentInfo = node(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
        node(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer(SIGNED_DATA_OID).getBytes()),
        node(a.Class.CONTEXT_SPECIFIC, 0, true, [signedData]),
    ]);
    return Buffer.from(a.toDer(contentInfo).getBytes(), 'binary');
}

/** Why `certificates` does not carry the CA certificate with `leafFingerprint`: presence only. Empty = present. */
export function caChainProblems(certificates: Pkcs7Certificate[], leafFingerprint: string): string[] {
    return certificates.some((c) => c.fingerprint === leafFingerprint.toLowerCase()) ? [] : [`the CA certificate ${leafFingerprint} is not in the message`];
}

export function certificateFacts(pemOrDer: string | Buffer): { commonName?: string; spkiBase64: string; fingerprint: string; subject: string } {
    const der = typeof pemOrDer === 'string' ? pemToDer(pemOrDer) : pemOrDer;
    const cert = new crypto.X509Certificate(der);
    const cn = /^CN=(.*)$/m.exec(cert.subject)?.[1];
    return {
        ...(cn !== undefined ? { commonName: cn } : {}),
        spkiBase64: Buffer.from(cert.publicKey.export({ type: 'spki', format: 'der' })).toString('base64'),
        fingerprint: sha256Hex(der),
        subject: dnLine(cert.subject),
    };
}

export const certificatePems = (text: string): string[] => text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
