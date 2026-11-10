/** pkiBuilders — keys, CSRs, certificates and their encodings, built in process (node-forge for RSA, `@peculiar/x509` for EC and parsing). */
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import type * as X509 from '@peculiar/x509';

export interface SanSet {
    dns: string[];
    ip: string[];
}

export interface GeneratedCsr {
    pem: string;
    derBase64: string;
    derBase64Url: string;
    /** Forge format; RSA only. */
    publicKeyPem: string;
    /** Base64 DER of the SubjectPublicKeyInfo (any key type). */
    spkiBase64: string;
    privateKeyPem: string;
    sans: SanSet;
    keyType: 'rsa-2048' | 'ec-p256';
}

export interface CsrOptions {
    ip?: string[];
    key?: forge.pki.rsa.KeyPair;
}

const pemBody = (pem: string): string => pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '');

export const pemToDer = (pem: string): Buffer => Buffer.from(pemBody(pem), 'base64');

export const derToPem = (der: Buffer): string => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()}\n-----END CERTIFICATE-----`;

/** SHA-256 (lowercase hex): the fingerprint form of the inventory search and the import references. */
export const sha256Hex = (bytes: Buffer | Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex');

const spkiOfForgeKey = (key: forge.pki.PublicKey): string =>
    Buffer.from(forge.asn1.toDer(forge.pki.publicKeyToAsn1(key)).getBytes(), 'binary').toString('base64');

export const newKeyPair = (): forge.pki.rsa.KeyPair => forge.pki.rsa.generateKeyPair(2048);

/** An RSA-2048 key pair from the native generator (fast), with the encodings the import fixtures and TLS target need. */
export interface KeyMaterial {
    keys: forge.pki.rsa.KeyPair;
    spki: Buffer;
    pkcs8Pem: string;
}

export function newKeyMaterial(): KeyMaterial {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    const keys: forge.pki.rsa.KeyPair = {
        privateKey: forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey,
        publicKey: forge.pki.publicKeyFromAsn1(forge.asn1.fromDer(publicKey.toString('binary'))) as forge.pki.rsa.PublicKey,
    };
    return { keys, spki: Buffer.from(publicKey), pkcs8Pem: privateKey };
}

type ForgeCsr = ReturnType<typeof forge.pki.createCertificationRequest>;
type SubjectAttribute = { name?: string; shortName?: string; value: string };
type CsrAttribute = Record<string, unknown>;

function signedCsr(keys: forge.pki.rsa.KeyPair, subject: SubjectAttribute[], attributes: CsrAttribute[]): { csr: ForgeCsr; der: Buffer } {
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    csr.setSubject(subject as forge.pki.CertificateField[]);
    if (attributes.length) csr.setAttributes(attributes as forge.pki.CertificateField[]);
    csr.sign(keys.privateKey, forge.md.sha256.create());
    return { csr, der: Buffer.from(forge.asn1.toDer(forge.pki.certificationRequestToAsn1(csr)).getBytes(), 'binary') };
}

type AltName = { type: number; value?: string; ip?: string };

const extensionRequest = (altNames: AltName[]): CsrAttribute[] =>
    altNames.length ? [{ name: 'extensionRequest', extensions: [{ name: 'subjectAltName', altNames }] }] : [];

const dnsAndIpAltNames = (sans: SanSet): AltName[] => [...sans.dns.map((value) => ({ type: 2, value })), ...sans.ip.map((value) => ({ type: 7, ip: value }))];

function describeCsr(keys: forge.pki.rsa.KeyPair, csr: ForgeCsr, der: Buffer, sans: SanSet): GeneratedCsr {
    return {
        pem: forge.pki.certificationRequestToPem(csr),
        derBase64: der.toString('base64'),
        derBase64Url: der.toString('base64url'),
        publicKeyPem: forge.pki.publicKeyToPem(keys.publicKey),
        spkiBase64: spkiOfForgeKey(keys.publicKey),
        privateKeyPem: forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keys.privateKey))),
        sans: { dns: [...sans.dns], ip: [...sans.ip] },
        keyType: 'rsa-2048',
    };
}

function csrFromSubject(keys: forge.pki.rsa.KeyPair, subject: SubjectAttribute[], sans: Partial<SanSet>): GeneratedCsr {
    const set: SanSet = { dns: sans.dns ?? [], ip: sans.ip ?? [] };
    const { csr, der } = signedCsr(keys, subject, extensionRequest(dnsAndIpAltNames(set)));
    return describeCsr(keys, csr, der, set);
}

/** RSA CSR with CN and, when given, a SAN of DNS names and IP addresses; a fresh key pair unless `opts.key`. */
export function csrWithSan(commonName: string, dnsNames: string[] = [], opts: CsrOptions = {}): GeneratedCsr {
    const keys = opts.key ?? newKeyPair();
    return csrFromKey(keys, commonName, { dns: dnsNames, ip: opts.ip ?? [] });
}

export function csrFromKey(keys: forge.pki.rsa.KeyPair, commonName: string, sans: Partial<SanSet> = {}): GeneratedCsr {
    return csrFromSubject(keys, [{ name: 'commonName', value: commonName }], sans);
}

const RDN_NAMES: Readonly<Record<string, string>> = {
    CN: 'commonName', O: 'organizationName', OU: 'organizationalUnitName', L: 'localityName', ST: 'stateOrProvinceName', C: 'countryName',
    E: 'emailAddress', EMAILADDRESS: 'emailAddress', EMAIL: 'emailAddress', DC: 'domainComponent', SN: 'surname', GN: 'givenName', SERIALNUMBER: 'serialNumber',
    STREET: 'streetAddress', T: 'title',
};

/** The RDNs of an RFC 4514 subject DN string as forge attributes, in order. A rekey CSR must carry the issued certificate's subject. */
export function subjectAttributesOf(subjectDn: string): SubjectAttribute[] {
    const parts: string[] = [];
    let cur = '';
    for (let i = 0; i < subjectDn.length; i++) {
        const ch = subjectDn[i];
        if (ch === '\\' && i + 1 < subjectDn.length) {
            cur += subjectDn[i + 1];
            i++;
        } else if (ch === ',') {
            parts.push(cur);
            cur = '';
        } else cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean).map((p) => {
        const eq = p.indexOf('=');
        const type = p.slice(0, eq).trim().toUpperCase();
        const value = p.slice(eq + 1).trim();
        const name = RDN_NAMES[type];
        return name ? { name, value } : { shortName: type, value };
    });
}

export function csrFromKeyWithSubject(keys: forge.pki.rsa.KeyPair, subjectDn: string, sans: Partial<SanSet> = {}): GeneratedCsr {
    return csrFromSubject(keys, subjectAttributesOf(subjectDn), sans);
}

/** An RSA CSR with an e-mail SAN, which the EJBCA end-entity profile of the tiers refuses (ilm#429): the way to get a `failed` certificate. */
export function csrWithEmailSan(commonName: string, email: string): GeneratedCsr {
    const keys = newKeyPair();
    const { csr, der } = signedCsr(keys, [{ name: 'commonName', value: commonName }], extensionRequest([{ type: 2, value: commonName }, { type: 1, value: email }]));
    return describeCsr(keys, csr, der, { dns: [commonName], ip: [] });
}

export interface ChallengeCsr {
    pem: string;
    derBase64: string;
    /** PKCS#1 PEM ("RSA PRIVATE KEY"), as sscep and openssl read it. */
    privateKeyPem: string;
    publicKeyPem: string;
    spkiBase64: string;
    commonName: string;
    challengePassword?: string;
}

export interface ChallengeCsrOptions {
    dns?: string[];
    key?: forge.pki.rsa.KeyPair;
}

/** RSA CSR with the CN, an optional `challengePassword` attribute (absent when undefined) and optional DNS SANs. */
export function csrWithChallengePassword(commonName: string, challengePassword: string | undefined, opts: ChallengeCsrOptions = {}): ChallengeCsr {
    const keys = opts.key ?? newKeyPair();
    const attributes: CsrAttribute[] = [];
    if (challengePassword !== undefined) attributes.push({ name: 'challengePassword', value: challengePassword });
    attributes.push(...extensionRequest((opts.dns ?? []).map((value) => ({ type: 2, value }))));
    const { csr, der } = signedCsr(keys, [{ name: 'commonName', value: commonName }], attributes);
    return {
        pem: forge.pki.certificationRequestToPem(csr),
        derBase64: der.toString('base64'),
        privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
        publicKeyPem: forge.pki.publicKeyToPem(keys.publicKey),
        spkiBase64: spkiOfForgeKey(keys.publicKey),
        commonName,
        ...(challengePassword !== undefined ? { challengePassword } : {}),
    };
}

export function challengePasswordOf(csrPem: string): string | undefined {
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    const attr = csr.getAttribute({ name: 'challengePassword' }) as { value?: unknown } | null;
    return attr && typeof attr.value === 'string' ? attr.value : undefined;
}


let x509Lib: typeof X509 | undefined;

export function loadX509Module(): typeof X509 {
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
    const lib = loadX509Module();
    const san = ext instanceof lib.SubjectAlternativeNameExtension ? ext : new lib.SubjectAlternativeNameExtension(ext.rawData);
    for (const n of san.names.items) {
        if (n.type === 'dns') out.dns.push(n.value);
        else if (n.type === 'ip') out.ip.push(n.value);
    }
    return out;
}

export async function ecCsrWithSan(commonName: string, dnsNames: string[] = [], opts: { ip?: string[] } = {}): Promise<GeneratedCsr> {
    const lib = loadX509Module();
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

export function csrInfo(pemOrBase64Der: string): { sans: SanSet; spkiBase64: string; subject: string } {
    const lib = loadX509Module();
    const csr = new lib.Pkcs10CertificateRequest(pemOrBase64Der.includes('-----BEGIN') ? pemOrBase64Der : Buffer.from(pemOrBase64Der, 'base64'));
    return { sans: sanSetOf(csr.getExtension(SAN_OID)), spkiBase64: Buffer.from(csr.publicKey.rawData).toString('base64'), subject: csr.subject };
}

export function certificateInfo(pemOrBase64Der: string): { sans: SanSet; spkiBase64: string; subject: string; issuer: string } {
    const lib = loadX509Module();
    const cert = new lib.X509Certificate(pemOrBase64Der.includes('-----BEGIN') ? pemOrBase64Der : Buffer.from(pemOrBase64Der, 'base64'));
    return { sans: sanSetOf(cert.getExtension(SAN_OID)), spkiBase64: Buffer.from(cert.publicKey.rawData).toString('base64'), subject: cert.subject, issuer: cert.issuer };
}

export function pemBlocks(chain: string): string[] {
    return chain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

/** Chain order check: each block's signature verifies with the next block's key; the last need not be a root. Returns the problems. */
export async function chainProblems(blocks: string[]): Promise<string[]> {
    const lib = loadX509Module();
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
 * Whether a refusal text says the CA refuses the KEY (EC / curve / key-type word near a "not allowed" word); a bare "key" in a history line
 * is not a CA policy.
 */
export function ecRefusalWording(text: string): boolean {
    const KEY = String.raw`(?:EC|ECDSA|elliptic(?: curve)?|curve|key (?:type|algorithm)|public key algorithm|key specification)`;
    const NO = String.raw`(?:not (?:allowed|permitted|supported|accepted)|unsupported|refused|rejected|denied|invalid)`;
    const NO_ONLY = String.raw`(?:not (?:allowed|permitted|supported|accepted)|unsupported|refused|rejected|denied)`;
    return new RegExp(String.raw`\b${KEY}\b.{0,80}\b${NO}\b|\b${NO_ONLY}\b.{0,80}\b${KEY}\b`, 'i').test(text);
}

export function sameSans(a: SanSet, b: SanSet): boolean {
    const norm = (s: SanSet) => ({ dns: [...new Set(s.dns.map((d) => d.toLowerCase()))].sort(), ip: [...new Set(s.ip)].sort() });
    const x = norm(a);
    const y = norm(b);
    return JSON.stringify(x) === JSON.stringify(y);
}

/** The SAN set of an ILM certificate or request detail: DNS names and IP addresses only. */
/** An IPv4 SAN in the octet hex core stores for a CSR (`#c000020a`) as its address text; any other value unchanged. */
export const decodedIpSan = (value: string): string => (/^#[0-9a-f]{8}$/i.test(value) ? [...Buffer.from(value.slice(1), 'hex')].join('.') : value);

export function sansOfDetail(subjectAlternativeNames: Record<string, unknown> | undefined | null): SanSet {
    const list = (k: string): string[] => {
        const v = subjectAlternativeNames?.[k];
        return Array.isArray(v) ? v.map(String) : [];
    };
    return { dns: list('dNSName'), ip: list('iPAddress') };
}


export function parseCertificate(pemOrBase64Der: string): forge.pki.Certificate {
    if (pemOrBase64Der.includes('-----BEGIN')) return forge.pki.certificateFromPem(pemOrBase64Der);
    const der = Buffer.from(pemOrBase64Der, 'base64').toString('binary');
    return forge.pki.certificateFromAsn1(forge.asn1.fromDer(der));
}

export function publicKeyPemOf(cert: forge.pki.Certificate): string {
    return forge.pki.publicKeyToPem(cert.publicKey);
}

export function sha256Fingerprint(cert: forge.pki.Certificate): string {
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const md = forge.md.sha256.create();
    md.update(der);
    return md.digest().toHex();
}

export function sha256FingerprintOfPem(pem: string): string {
    return sha256Hex(pemToDer(pem));
}

export function firstPem(chain: string): string {
    const m = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(chain);
    if (!m) throw new Error('no certificate in PEM chain');
    return m[0];
}

export function selfSignedPem(commonName: string, days = 30, now: Date = new Date()): { pem: string; privateKeyPem: string } {
    const keys = newKeyPair();
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

export function selfSignedPkcs12(commonName: string, password: string): Buffer {
    const keys = newKeyPair();
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
