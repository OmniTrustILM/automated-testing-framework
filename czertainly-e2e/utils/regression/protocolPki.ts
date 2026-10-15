/**
 * protocolPki — pure PKI helpers of the protocol rows (no network, no runner tool, node-forge only):
 * - a PKCS#10 CSR carrying a `challengePassword` attribute (what sscep sends to a SCEP profile with a password;
 *   RFC 8894 §3.3.1) and its RSA key in the PEM form the tools read;
 * - the degenerate PKCS#7 (certs-only SignedData) a SCEP `GetCACert` answers with (RFC 8894 §4.2.1.2: the CA
 *   certificate and its issuers, `application/x-x509-ca-ra-cert`);
 * - the `GetCACaps` keyword list (RFC 8894 §3.5.2; protocols rules §7.2 r13: ScepServiceImpl advertises eight);
 * - PEM / DER conversions and SHA-256 fingerprints in the form the inventory search takes.
 */
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import { fromDerRaw } from './cmpAsn1';

/** The eight keywords ScepServiceImpl advertises (protocols rules §7.2 r13; docs scep/overview.md). */
export const SCEP_CA_CAPS: readonly string[] = ['POSTPKIOperation', 'SHA-1', 'SHA-256', 'SHA-512', 'DES3', 'AES', 'Renewal', 'SCEPStandard'];

export interface ChallengeCsr {
    pem: string;
    /** Base64 DER (the PEM body). */
    derBase64: string;
    /** PKCS#1 PEM of the private key ("RSA PRIVATE KEY"): what sscep's `-k` and openssl's `-newkey` read. */
    privateKeyPem: string;
    publicKeyPem: string;
    /** Base64 DER of the SubjectPublicKeyInfo: compared with the issued certificate's. */
    spkiBase64: string;
    commonName: string;
    challengePassword?: string;
}

export interface ChallengeCsrOptions {
    /** DNS names for a subjectAltName extension request. */
    dns?: string[];
    /** An existing RSA key pair (default: a fresh RSA-2048 pair). */
    key?: forge.pki.rsa.KeyPair;
}

const spkiBase64Of = (key: forge.pki.PublicKey): string => Buffer.from(forge.asn1.toDer(forge.pki.publicKeyToAsn1(key)).getBytes(), 'binary').toString('base64');

/**
 * RSA CSR (SHA-256) with the CN, an optional `challengePassword` attribute (absent when `challengePassword` is
 * undefined: the "absent password" negative) and optional DNS SANs.
 */
export function csrWithChallengePassword(commonName: string, challengePassword: string | undefined, opts: ChallengeCsrOptions = {}): ChallengeCsr {
    const keys = opts.key ?? forge.pki.rsa.generateKeyPair(2048);
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    csr.setSubject([{ name: 'commonName', value: commonName }]);
    const attributes: Array<Record<string, unknown>> = [];
    if (challengePassword !== undefined) attributes.push({ name: 'challengePassword', value: challengePassword });
    if (opts.dns?.length) attributes.push({ name: 'extensionRequest', extensions: [{ name: 'subjectAltName', altNames: opts.dns.map((value) => ({ type: 2, value })) }] });
    if (attributes.length) csr.setAttributes(attributes as forge.pki.CertificateField[]);
    csr.sign(keys.privateKey, forge.md.sha256.create());
    const der = Buffer.from(forge.asn1.toDer(forge.pki.certificationRequestToAsn1(csr)).getBytes(), 'binary');
    return {
        pem: forge.pki.certificationRequestToPem(csr),
        derBase64: der.toString('base64'),
        privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
        publicKeyPem: forge.pki.publicKeyToPem(keys.publicKey),
        spkiBase64: spkiBase64Of(keys.publicKey),
        commonName,
        ...(challengePassword !== undefined ? { challengePassword } : {}),
    };
}

/** The `challengePassword` attribute of a CSR (PEM), or undefined. */
export function challengePasswordOf(csrPem: string): string | undefined {
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    const attr = csr.getAttribute({ name: 'challengePassword' }) as { value?: unknown } | null;
    return attr && typeof attr.value === 'string' ? attr.value : undefined;
}

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

/** SHA-256 fingerprint (lowercase hex) of DER bytes. */
export const sha256Hex = (der: Buffer): string => crypto.createHash('sha256').update(der).digest('hex');

/** The DER of a PEM block (its base64 body). */
export const pemToDer = (pem: string): Buffer => Buffer.from(pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');

/** PEM armour around DER bytes. */
export const derToPem = (der: Buffer): string => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()}\n-----END CERTIFICATE-----`;

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
 * A degenerate PKCS#7 holding the given certificates (PEM, any key type: built from their raw DER, no forge certificate
 * parsing): the unit tests' and the malformed-request pins' fixture, and nothing else.
 *   ContentInfo ::= SEQUENCE { contentType signedData, content [0] EXPLICIT SignedData }
 *   SignedData ::= SEQUENCE { version 1, digestAlgorithms SET {}, encapContentInfo SEQUENCE { data }, certificates [0] IMPLICIT SET, signerInfos SET {} }
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
