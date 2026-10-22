/**
 * protocolResponseReaders — pure readers of protocol answers: the degenerate PKCS#7 a SCEP GetCACert returns, the
 * GetCACaps keyword list, CA-chain checks and the facts (fingerprint, subject, key) of the certificates a message
 * carries. No network, no external client.
 */
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import { fromDerRaw } from './cmpMessageParser';
import { derToPem, pemToDer, sha256Hex } from '../pkiBuilders';

/** The keywords of a GetCACaps body: one per line, either line ending, blanks dropped (RFC 8894 §3.5.2). */
export function parseGetCaCaps(text: string): string[] {
    return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

export interface Pkcs7Certificate {
    pem: string;
    /** SHA-256 of the DER, lowercase hex (the inventory's FINGERPRINT form). */
    fingerprint: string;
    subject: string;
    issuer: string;
}

/** One X.509 DN as node:crypto prints it (`CN=…\nO=…`), joined with ", ". */
const dnLine = (s: string): string => s.split('\n').filter((l) => l).join(', ');

/** A certificate's facts through node:crypto's X509Certificate (any key type: EC-safe, unlike forge). */
function x509Facts(der: Buffer): Pkcs7Certificate {
    const cert = new crypto.X509Certificate(der);
    return { pem: derToPem(der), fingerprint: sha256Hex(der), subject: dnLine(cert.subject), issuer: dnLine(cert.issuer) };
}

type Asn1 = forge.asn1.Asn1;
const SIGNED_DATA_OID = '1.2.840.113549.1.7.2';

/**
 * The certificates of a degenerate PKCS#7 (SignedData with certificates and no signers; `application/x-x509-ca-ra-cert`
 * of RFC 8894 §4.2.1.2), in the order the message lists them: the ASN.1 is walked with forge (ContentInfo → [0]
 * SignedData → certificates [0] IMPLICIT), each certificate's own DER is cut out and read with node:crypto (forge reads
 * RSA certificates only). Throws when the bytes are not a PKCS#7 SignedData.
 */
export function parseDegeneratePkcs7(der: Buffer): Pkcs7Certificate[] {
    const a = forge.asn1;
    const root = fromDerRaw(der);
    const kids = (n: Asn1): Asn1[] => (Array.isArray(n.value) ? (n.value as Asn1[]) : []);
    const [oidNode, contentNode] = kids(root);
    const oid = oidNode && oidNode.type === a.Type.OID ? a.derToOid(oidNode.value as string) : undefined;
    if (oid !== SIGNED_DATA_OID) throw new Error(`not a PKCS#7 SignedData (content type ${oid ?? 'unreadable'})`);
    const signedData = kids(contentNode ?? ({} as Asn1))[0];
    if (!signedData) throw new Error('PKCS#7 SignedData without content');
    // SignedData ::= SEQUENCE { version, digestAlgorithms SET, encapContentInfo SEQUENCE, certificates [0] IMPLICIT SET OPTIONAL, … }
    const certSet = kids(signedData).find((n) => n.tagClass === a.Class.CONTEXT_SPECIFIC && n.type === 0);
    if (!certSet) return [];
    return kids(certSet).map((c) => x509Facts(Buffer.from(a.toDer(c).getBytes(), 'binary')));
}

/**
 * Why `certificates` is not the set a SCEP GetCACert must carry (ScepServiceImpl.loadCertificateChain: the CA certificate
 * plus what `GET /v1/certificates/{uuid}/chain?withEndCertificate=true` returns): set equality by fingerprint. Empty = equal.
 */
export function scepCaSetProblems(certificates: Pkcs7Certificate[], expectedFingerprints: string[]): string[] {
    const got = new Set(certificates.map((c) => c.fingerprint));
    const want = new Set(expectedFingerprints.map((f) => f.toLowerCase()));
    const problems: string[] = [];
    for (const f of want) if (!got.has(f)) problems.push(`missing ${f}`);
    for (const f of got) if (!want.has(f)) problems.push(`unexpected ${f}`);
    return problems;
}

/**
 * A degenerate PKCS#7 holding the given certificates (PEM, any key type: built from their raw DER, no forge certificate parsing): the unit
 * tests' and the malformed-request pins' fixture, and nothing else. ContentInfo ::= SEQUENCE { contentType signedData, content [0] EXPLICIT
 * SignedData } SignedData ::= SEQUENCE { version 1, digestAlgorithms SET {}, encapContentInfo SEQUENCE { data }, certificates [0] IMPLICIT
 * SET, signerInfos SET {} }
 */
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

/**
 * Why `certificates` does not carry the CA certificate with `leafFingerprint` (RFC 8894 §4.2.1.2): presence only — which
 * issuers the message holds is core's chain (`scepCaSetProblems`), not a structural rule. Empty = present.
 */
export function caChainProblems(certificates: Pkcs7Certificate[], leafFingerprint: string): string[] {
    return certificates.some((c) => c.fingerprint === leafFingerprint.toLowerCase()) ? [] : [`the CA certificate ${leafFingerprint} is not in the message`];
}

/** Subject CN, SPKI (base64 DER), fingerprint and subject of a certificate (PEM or DER; any key type, node:crypto). */
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

/** Every `CERTIFICATE` PEM block of a text, in order. */
export const certificatePems = (text: string): string[] => text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
