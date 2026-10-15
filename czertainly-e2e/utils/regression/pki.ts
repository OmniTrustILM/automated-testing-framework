/**
 * pki — key, CSR and certificate helpers for the REG-* issuance flows.
 *
 * node-forge (RSA) builds the CSRs the flows have always used; B1 adds DNS + IP SANs, the private key, CSRs from a
 * given key (same-key renew / rekey CSRs later) and an EC P-256 CSR through `@peculiar/x509` (WebCrypto: forge has no
 * EC). Certificates whose key may be EC (the ACME leaf) and chains are read with `@peculiar/x509` as well: SANs, the
 * public key (SPKI, compared byte for byte with the CSR's) and the signature of each chain link. `@peculiar/x509`
 * needs `reflect-metadata` (B0 §7 #5) and is loaded lazily, on the first call that needs it.
 * No openssl, no network: everything runs in-process.
 */
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import type * as X509 from '@peculiar/x509';

export interface SanSet {
    dns: string[];
    ip: string[];
}

export interface GeneratedCsr {
    pem: string;
    /** Base64 DER (the PEM body): what the v2 issue API takes in `request`. */
    derBase64: string;
    /** Base64url DER: what ACME finalize takes in `csr`. */
    derBase64Url: string;
    /** PEM of the public key (forge format; RSA only, kept for the existing callers). */
    publicKeyPem: string;
    /** Base64 DER of the SubjectPublicKeyInfo: compared with a certificate's `spkiBase64` (any key type). */
    spkiBase64: string;
    /** PKCS#8 PEM of the private key. */
    privateKeyPem: string;
    /** The SANs put into the request. */
    sans: SanSet;
    keyType: 'rsa-2048' | 'ec-p256';
}

export interface CsrOptions {
    /** IP addresses for iPAddress SANs (IPv4 dotted or IPv6). */
    ip?: string[];
    /** An existing RSA key pair (same-key CSR); default: a fresh RSA-2048 pair. */
    key?: forge.pki.rsa.KeyPair;
}

/** The PEM body of a block as base64 (no armour, no whitespace). */
const pemBody = (pem: string): string => pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '');

const spkiOfForgeKey = (key: forge.pki.PublicKey): string =>
    Buffer.from(forge.asn1.toDer(forge.pki.publicKeyToAsn1(key)).getBytes(), 'binary').toString('base64');

/**
 * RSA CSR with CN and, when given, a subjectAltName of DNS names and IP addresses (ACME needs the SAN). The CSR is
 * signed with SHA-256. Without `opts.key` a fresh RSA-2048 key pair is generated; its private key is returned.
 */
export function csrWithSan(commonName: string, dnsNames: string[] = [], opts: CsrOptions = {}): GeneratedCsr {
    const keys = opts.key ?? forge.pki.rsa.generateKeyPair(2048);
    return csrFromKey(keys, commonName, { dns: dnsNames, ip: opts.ip ?? [] });
}

/** RSA CSR for a given key pair (renew keeps the key, rekey uses a new one with the same subject). */
export function csrFromKey(keys: forge.pki.rsa.KeyPair, commonName: string, sans: Partial<SanSet> = {}): GeneratedCsr {
    const dns = sans.dns ?? [];
    const ip = sans.ip ?? [];
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    csr.setSubject([{ name: 'commonName', value: commonName }]);
    const altNames = [...dns.map((value) => ({ type: 2, value })), ...ip.map((value) => ({ type: 7, ip: value }))];
    if (altNames.length) csr.setAttributes([{ name: 'extensionRequest', extensions: [{ name: 'subjectAltName', altNames }] }]);
    csr.sign(keys.privateKey, forge.md.sha256.create());
    const der = forge.asn1.toDer(forge.pki.certificationRequestToAsn1(csr)).getBytes();
    const derBuffer = Buffer.from(der, 'binary');
    return {
        pem: forge.pki.certificationRequestToPem(csr),
        derBase64: derBuffer.toString('base64'),
        derBase64Url: derBuffer.toString('base64url'),
        publicKeyPem: forge.pki.publicKeyToPem(keys.publicKey),
        spkiBase64: spkiOfForgeKey(keys.publicKey),
        privateKeyPem: forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keys.privateKey))),
        sans: { dns: [...dns], ip: [...ip] },
        keyType: 'rsa-2048',
    };
}

// ------------------------------------------------------------------ @peculiar/x509 (EC CSRs, certificates of any key type)

let x509Lib: typeof X509 | undefined;

/** `@peculiar/x509` with `reflect-metadata` loaded first and Node's WebCrypto as its provider. */
function x509(): typeof X509 {
    if (!x509Lib) {
        require('reflect-metadata');
        x509Lib = require('@peculiar/x509') as typeof X509;
        x509Lib.cryptoProvider.set(crypto.webcrypto as unknown as Crypto);
    }
    return x509Lib;
}

const SAN_OID = '2.5.29.17';

function sanSetOf(ext: X509.Extension | null | undefined): SanSet {
    const out: SanSet = { dns: [], ip: [] };
    if (!ext) return out;
    const lib = x509();
    const san = ext instanceof lib.SubjectAlternativeNameExtension ? ext : new lib.SubjectAlternativeNameExtension(ext.rawData);
    for (const n of san.names.items) {
        if (n.type === 'dns') out.dns.push(n.value);
        else if (n.type === 'ip') out.ip.push(n.value);
    }
    return out;
}

/** EC P-256 CSR (ECDSA with SHA-256) with CN and the SANs, built with WebCrypto. */
export async function ecCsrWithSan(commonName: string, dnsNames: string[] = [], opts: { ip?: string[] } = {}): Promise<GeneratedCsr> {
    const lib = x509();
    const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const keys = (await crypto.webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
    const ip = opts.ip ?? [];
    const names = [...dnsNames.map((value) => ({ type: 'dns' as const, value })), ...ip.map((value) => ({ type: 'ip' as const, value }))];
    const csr = await lib.Pkcs10CertificateRequestGenerator.create({
        name: [{ CN: [commonName] }],
        keys,
        signingAlgorithm: algorithm,
        extensions: names.length ? [new lib.SubjectAlternativeNameExtension(names)] : [],
    });
    const der = Buffer.from(csr.rawData);
    const spki = Buffer.from(await crypto.webcrypto.subtle.exportKey('spki', keys.publicKey as unknown as crypto.webcrypto.CryptoKey));
    const pkcs8 = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey as unknown as crypto.webcrypto.CryptoKey));
    return {
        pem: csr.toString('pem'),
        derBase64: der.toString('base64'),
        derBase64Url: der.toString('base64url'),
        publicKeyPem: lib.PemConverter.encode(spki, 'PUBLIC KEY'),
        spkiBase64: spki.toString('base64'),
        privateKeyPem: lib.PemConverter.encode(pkcs8, 'PRIVATE KEY'),
        sans: { dns: [...dnsNames], ip: [...ip] },
        keyType: 'ec-p256',
    };
}

/** SANs and SPKI of a CSR (PEM or base64 DER), any key type. */
export function csrInfo(pemOrBase64Der: string): { sans: SanSet; spkiBase64: string; subject: string } {
    const lib = x509();
    const csr = new lib.Pkcs10CertificateRequest(pemOrBase64Der.includes('-----BEGIN') ? pemOrBase64Der : Buffer.from(pemOrBase64Der, 'base64'));
    return { sans: sanSetOf(csr.getExtension(SAN_OID)), spkiBase64: Buffer.from(csr.publicKey.rawData).toString('base64'), subject: csr.subject };
}

/** SANs, SPKI and subject of a certificate (PEM or base64 DER as `certificateContent`), any key type. */
export function certificateInfo(pemOrBase64Der: string): { sans: SanSet; spkiBase64: string; subject: string; issuer: string } {
    const lib = x509();
    const cert = new lib.X509Certificate(pemOrBase64Der.includes('-----BEGIN') ? pemOrBase64Der : Buffer.from(pemOrBase64Der, 'base64'));
    return { sans: sanSetOf(cert.getExtension(SAN_OID)), spkiBase64: Buffer.from(cert.publicKey.rawData).toString('base64'), subject: cert.subject, issuer: cert.issuer };
}

/** Every `CERTIFICATE` PEM block of a chain, in order. */
export function pemBlocks(chain: string): string[] {
    return chain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

/**
 * Chain order check (RFC 8555 §7.4.2: the leaf first, each next certificate certifies the one before): for every link,
 * the signature of block i verifies with the public key of block i+1. A single block passes (nothing to link). The
 * last block is not required to be a root. Returns the problems (empty = ordered).
 */
export async function chainProblems(blocks: string[]): Promise<string[]> {
    const lib = x509();
    const certs = blocks.map((b) => new lib.X509Certificate(b));
    const problems: string[] = [];
    for (let i = 0; i + 1 < certs.length; i++) {
        const ok = await certs[i].verify({ publicKey: certs[i + 1].publicKey, signatureOnly: true });
        if (!ok) problems.push(`block ${i} is not signed by block ${i + 1}`);
        if (certs[i].issuer !== certs[i + 1].subject) problems.push(`block ${i} issuer does not name block ${i + 1}'s subject`);
    }
    return problems;
}

/**
 * Does a refusal text (an ACME problem detail, an order error, a certificate history message) say that the CA refuses the
 * KEY — an EC / ECDSA / curve / key-type word within 80 characters of a "not allowed / unsupported / refused / rejected /
 * denied / invalid" word, either order? REG-USE-05.1[ec-p256] skips only on such wording from THIS order's own refusal
 * (B1 fix pass, Sonnet F9): a bare "algorithm" or "key" in some history line is not a CA policy.
 */
export function ecRefusalWording(text: string): boolean {
    const KEY = String.raw`(?:EC|ECDSA|elliptic(?: curve)?|curve|key (?:type|algorithm)|public key algorithm|key specification)`;
    const NO = String.raw`(?:not (?:allowed|permitted|supported|accepted)|unsupported|refused|rejected|denied|invalid)`;
    const NO_ONLY = String.raw`(?:not (?:allowed|permitted|supported|accepted)|unsupported|refused|rejected|denied)`;
    return new RegExp(String.raw`\b${KEY}\b.{0,80}\b${NO}\b|\b${NO_ONLY}\b.{0,80}\b${KEY}\b`, 'i').test(text);
}

/** Set equality of two SAN sets (order-insensitive; DNS names compared case-insensitively, IPs as written). */
export function sameSans(a: SanSet, b: SanSet): boolean {
    const norm = (s: SanSet) => ({ dns: [...new Set(s.dns.map((d) => d.toLowerCase()))].sort(), ip: [...new Set(s.ip)].sort() });
    const x = norm(a);
    const y = norm(b);
    return JSON.stringify(x) === JSON.stringify(y);
}

/**
 * The SAN set of an ILM certificate or request detail (`subjectAlternativeNames`: `{ dNSName: [...], iPAddress: [...],
 * … }`): DNS names and IP addresses only (the two kinds the suite puts into its CSRs).
 */
export function sansOfDetail(subjectAlternativeNames: Record<string, unknown> | undefined | null): SanSet {
    const list = (k: string): string[] => {
        const v = subjectAlternativeNames?.[k];
        return Array.isArray(v) ? v.map(String) : [];
    };
    return { dns: list('dNSName'), ip: list('iPAddress') };
}

// ------------------------------------------------------------------ forge (RSA) helpers kept for the existing callers

/** Parse a certificate from PEM, or from base64 DER as the API returns it in `certificateContent` (RSA keys only). */
export function parseCertificate(pemOrBase64Der: string): forge.pki.Certificate {
    if (pemOrBase64Der.includes('-----BEGIN')) return forge.pki.certificateFromPem(pemOrBase64Der);
    const der = Buffer.from(pemOrBase64Der, 'base64').toString('binary');
    return forge.pki.certificateFromAsn1(forge.asn1.fromDer(der));
}

export function publicKeyPemOf(cert: forge.pki.Certificate): string {
    return forge.pki.publicKeyToPem(cert.publicKey);
}

/** SHA-256 fingerprint (lowercase hex of the DER), the form the inventory search uses. */
export function sha256Fingerprint(cert: forge.pki.Certificate): string {
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const md = forge.md.sha256.create();
    md.update(der);
    return md.digest().toHex();
}

/** SHA-256 fingerprint of a certificate PEM of any key type (lowercase hex of the DER). */
export function sha256FingerprintOfPem(pem: string): string {
    return crypto.createHash('sha256').update(Buffer.from(pemBody(pem), 'base64')).digest('hex');
}

/** First certificate of a PEM chain. */
export function firstPem(chain: string): string {
    const m = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(chain);
    if (!m) throw new Error('no certificate in PEM chain');
    return m[0];
}

/** A fresh self-signed RSA-2048 certificate (PEM) with the given CN and validity in days (seed certificates). */
export function selfSignedPem(commonName: string, days = 30, now: Date = new Date()): { pem: string; privateKeyPem: string } {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date(now.getTime() + days * 24 * 3600 * 1000);
    const attrs = [{ name: 'commonName', value: commonName }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return { pem: forge.pki.certificateToPem(cert), privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

/** Password-protected PKCS#12 holding a fresh self-signed certificate and its key (for the import password flow). */
export function selfSignedPkcs12(commonName: string, password: string): Buffer {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const attrs = [{ name: 'commonName', value: commonName }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
    return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}
