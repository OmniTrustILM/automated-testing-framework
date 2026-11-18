/** importFixtures — in-memory builders of the import, inspection and upload files and the refusal texts core answers for them. */
import { expectRefused, type RefusedAnswer } from '../errorContract';
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import { csrWithSan, newKeyMaterial, pemToDer, sha256Hex } from '../pkiBuilders';
import { ownName, checkedCommonName } from '../ledger/runState';


/** Limits core holds one uploaded file to. */
export const LIMITS = {
    fileBytes: 5 * 1024 * 1024,
    certificates: 200,
    otherEntries: 100,
} as const;

export const limitExceeded = (limit: string, maximum: number): string => `The file exceeds the ${limit} limit of ${maximum}.`;

/** Fixed 422 messages; each is one element of the 422 JSON array. */
export const REFUSAL = {
    notSupportedFormat:
        'The file is not in a supported format: PKCS#12, JKS, JCEKS, PEM, PKCS#7, a certificate, a certificate request, a PKCS#8 key, an OpenSSL traditional key or an OpenSSH private key.',
    pemTooManyKeys: 'A PEM file can hold at most one private key.',
    /** Repeated when the type matches `[A-Za-z0-9 .-]{1,64}`. */
    pemBlockUnsupported: (type: string): string => `The file holds a PEM block of type ${type}, which is not supported.`,
    /** A PKCS#12 whose MAC does not verify: password wrong or missing, one string. */
    integrityFailed: "The file's integrity check failed: the passphrase is wrong or missing, or the file is damaged.",
    twoPassphrases: 'The file protects its keys with a different passphrase than the file itself, which is not supported.',
    /** A protected key, passphrase wrong or missing, one string. */
    keyUnreadable: 'The key could not be read: the passphrase is wrong or missing, or the file is damaged.',
    certificateCount: limitExceeded('certificate count', LIMITS.certificates),
    entryCount: limitExceeded('entry count', LIMITS.otherEntries),
    fileTooLarge: `fileWithinLimit file must not exceed ${LIMITS.fileBytes} bytes`,
    fileRequired: 'file file is required',
    tokenProfileNotUuid: 'tokenProfileUuid must be a UUID',
    tokenProfileNotFound: (uuid: string): string => `Object of type 'TokenProfile' identified by ${uuid} is not found.`,
    /** Answered as the 400 "Unable to read HTTP message". */
    unreadableMessage: 'Unable to read HTTP message',
    // Plain upload (`POST /v1/certificates/upload`, `/upload/async`)
    uploadKeystore: 'The file is a keystore. Import it with the certificate import operation.',
    uploadNotCertificate: (type: string): string => `Uploaded PEM encoded content is not certificate. Uploaded PEM type: ${type}`,
    uploadInvalid: 'Uploaded certificate content has invalid or unsupported format.',
    uploadDuplicate: (fingerprint: string): string => `Certificate already exists with fingerprint ${fingerprint}`,
    requestNotImported: 'Certificate requests are not imported',
} as const;

/** The red alert of the wizard for a refused inspection. */
export const inspectionAlert = (status: number, text: string): string => `Failed to read the uploaded file (${status}): ${text}`;



/** A run-prefixed common name, unique per call (safe under `--repeat-each`). */
export function importCn(suffix: string): string {
    return checkedCommonName(ownName(`imp-${suffix}`));
}

/** Asserts the 422 refusal of an import or inspection file: exactly one message equal to (string) or matching (regexp) `text`. */
export const expectImportRefused = (answer: RefusedAnswer, text: string | RegExp, what?: string): string[] => expectRefused(answer, { status: 422, text, what });

export const toBase64 = (bytes: Buffer | Uint8Array | string): string => Buffer.from(bytes as Buffer).toString('base64');

export const entryReference = (der: Buffer): string => sha256Hex(der);

/** The fingerprint the inventory search uses: lowercase hex SHA-256 of the DER. */
export const certificateFingerprint = (derOrPem: Buffer | string): string => sha256Hex(typeof derOrPem === 'string' ? pemToDer(derOrPem) : derOrPem);

export const containerDigest = (file: Buffer): string => sha256Hex(file);

export const keyReference = (spkiDer: Buffer): string => sha256Hex(spkiDer);

/** forge writes PEM with CRLF; the fixtures use LF. */
const lf = (pem: string): string => pem.replace(/\r\n/g, '\n');

const wrap64 = (text: string): string => text.match(/.{1,64}/g)?.join('\n') ?? '';

export function pemBlock(type: string, der: Buffer): string {
    return `-----BEGIN ${type}-----\n${wrap64(der.toString('base64'))}\n-----END ${type}-----\n`;
}


let shared: { keys: forge.pki.rsa.KeyPair; spki: Buffer } | undefined;

function sharedKeys(): { keys: forge.pki.rsa.KeyPair; spki: Buffer } {
    if (!shared) shared = newKeyMaterial();
    return shared;
}

export interface Identity {
    cn: string;
    keys: forge.pki.rsa.KeyPair;
    cert: forge.pki.Certificate;
    pem: string;
    der: Buffer;
    fingerprint: string;
    spki: Buffer;
    keyReference: string;
    pkcs8Pem: string;
}

export interface CertificateOptions {
    days?: number;
    keys?: { keys: forge.pki.rsa.KeyPair; spki: Buffer; pkcs8Pem?: string };
    ca?: boolean;
    issuer?: Identity;
}

function identityOf(cn: string, keys: { keys: forge.pki.rsa.KeyPair; spki: Buffer; pkcs8Pem?: string }, cert: forge.pki.Certificate): Identity {
    const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
    return {
        cn,
        keys: keys.keys,
        cert,
        pem: lf(forge.pki.certificateToPem(cert)),
        der,
        fingerprint: sha256Hex(der),
        spki: keys.spki,
        keyReference: sha256Hex(keys.spki),
        pkcs8Pem: keys.pkcs8Pem ?? lf(forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keys.keys.privateKey)))),
    };
}

/** An X.509 certificate, `CN=<cn>`, SHA-256 signed; self-signed unless `issuer` is given. */
export function certificate(cn: string, opts: CertificateOptions = {}): Identity {
    const k = opts.keys ?? newKeyMaterial();
    const cert = forge.pki.createCertificate();
    cert.publicKey = k.keys.publicKey;
    cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
    const now = new Date();
    cert.validity.notBefore = new Date(now.getTime() - 60_000);
    cert.validity.notAfter = new Date(now.getTime() + (opts.days ?? 30) * 24 * 3600 * 1000);
    const subject = [{ name: 'commonName', value: cn }];
    cert.setSubject(subject);
    cert.setIssuer(opts.issuer ? opts.issuer.cert.subject.attributes : subject);
    if (opts.ca) {
        cert.setExtensions([
            { name: 'basicConstraints', cA: true, critical: true },
            { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        ]);
    }
    cert.sign(opts.issuer ? opts.issuer.keys.privateKey : k.keys.privateKey, forge.md.sha256.create());
    return identityOf(cn, k, cert);
}

export const certificatePem = (cn: string): Identity => certificate(cn);


export function pkcs7Der(certs: Identity[]): Buffer {
    const p7 = forge.pkcs7.createSignedData();
    for (const c of certs) p7.addCertificate(c.cert);
    return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

export const pkcs7Pem = (certs: Identity[]): string => pemBlock('PKCS7', pkcs7Der(certs));


export interface Pkcs8Key {
    pem: string;
    der: Buffer;
    spki: Buffer;
    keyReference: string;
}

/** A fresh RSA-2048 key as PKCS#8; with a passphrase it is `ENCRYPTED PRIVATE KEY` (PBES2, PBKDF2-HMAC-SHA256, AES-256-CBC). */
export function pkcs8Key(passphrase?: string): Pkcs8Key {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: passphrase === undefined ? { type: 'pkcs8', format: 'pem' } : { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
    });
    return { pem: privateKey, der: pemToDer(privateKey), spki: Buffer.from(publicKey), keyReference: sha256Hex(publicKey) };
}


export interface Pkcs12Fixture {
    bytes: Buffer;
    identity: Identity;
    password: string;
}

/** A PKCS#12 with the certificate and its key, protected by `password` (`''` = empty password, opened without a passphrase). */
export function pkcs12(cn: string, password: string): Pkcs12Fixture {
    const identity = certificate(cn);
    const asn1 = forge.pkcs12.toPkcs12Asn1(identity.keys.privateKey, [identity.cert], password, { algorithm: '3des' });
    return { bytes: Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'), identity, password };
}

/** A PKCS#12 with a new end-entity certificate signed by `intermediate`, its key, and the chain `intermediate`, `root`. */
export function pkcs12Chain(cn: string, intermediate: Identity, root: Identity, password: string): Pkcs12Fixture {
    const identity = certificate(cn, { issuer: intermediate });
    const asn1 = forge.pkcs12.toPkcs12Asn1(identity.keys.privateKey, [identity.cert, intermediate.cert, root.cert], password, { algorithm: '3des' });
    return { bytes: Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'), identity, password };
}

const OID = (id: string) => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer(id).getBytes());
const SEQ = (items: forge.asn1.Asn1[]) => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, items);
const EXPLICIT0 = (items: forge.asn1.Asn1[]) => forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, items);
const OCTETS = (bytes: string) => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, bytes);
const INT = (n: number) => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, forge.asn1.integerToDer(n).getBytes());

/**
 * A PKCS#12 whose MAC uses `filePassphrase` while its key is protected under `keyPassphrase` (core answers TWO_PASSPHRASES).
 * Built by hand: node-forge protects every part of a file with one password.
 */
export function pkcs12TwoPassphrases(cn: string, filePassphrase: string, keyPassphrase: string): Pkcs12Fixture {
    const identity = certificate(cn);
    const keyInfo = forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(identity.keys.privateKey));
    const shrouded = forge.pki.encryptPrivateKeyInfo(keyInfo, keyPassphrase, { algorithm: 'aes256', prfAlgorithm: 'sha256', count: 2048 });
    const keyBag = SEQ([OID(forge.pki.oids.pkcs8ShroudedKeyBag), EXPLICIT0([shrouded])]);
    const certBag = SEQ([
        OID(forge.pki.oids.certBag),
        EXPLICIT0([SEQ([OID(forge.pki.oids.x509Certificate), EXPLICIT0([OCTETS(identity.der.toString('binary'))])])]),
    ]);
    const safeContents = SEQ([keyBag, certBag]);
    const dataContent = (inner: forge.asn1.Asn1) => SEQ([OID(forge.pki.oids.data), EXPLICIT0([OCTETS(forge.asn1.toDer(inner).getBytes())])]);
    const authenticatedSafe = SEQ([dataContent(safeContents)]);
    const safeBytes = forge.asn1.toDer(authenticatedSafe).getBytes();
    const iterations = 2048;
    const salt = forge.random.getBytesSync(8);
    const generateKey = (forge.pkcs12 as unknown as { generateKey(password: string, salt: forge.util.ByteStringBuffer, id: number, iterations: number, n: number): forge.util.ByteStringBuffer }).generateKey;
    const macKey = generateKey(filePassphrase, new forge.util.ByteStringBuffer(salt), 3, iterations, 20);
    const hmac = forge.hmac.create();
    hmac.start(forge.md.sha1.create(), macKey.getBytes());
    hmac.update(safeBytes);
    const macData = SEQ([
        SEQ([SEQ([OID(forge.pki.oids.sha1), forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, '')]), OCTETS(hmac.getMac().getBytes())]),
        OCTETS(salt),
        INT(iterations),
    ]);
    const pfx = SEQ([INT(3), SEQ([OID(forge.pki.oids.data), EXPLICIT0([OCTETS(safeBytes)])]), macData]);
    return { bytes: Buffer.from(forge.asn1.toDer(pfx).getBytes(), 'binary'), identity, password: filePassphrase };
}


export function pemTwoKeys(): string {
    return `${pkcs8Key().pem}${pkcs8Key().pem}`;
}

/** A `DH PARAMETERS` PEM block (RFC 3526 group 14): a PEM type the reader does not take. */
export function dhParametersPem(): string {
    const group = crypto.getDiffieHellman('modp14');
    const asInteger = (bytes: Buffer) => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, (bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes).toString('binary'));
    const der = Buffer.from(forge.asn1.toDer(SEQ([asInteger(group.getPrime()), asInteger(group.getGenerator())])).getBytes(), 'binary');
    return pemBlock('DH PARAMETERS', der);
}

/** A PKCS#10 request as PEM, RSA-2048, `CN=<cn>`. */
export function csrPem(cn: string): { pem: string; der: Buffer; reference: string } {
    const csr = csrWithSan(cn);
    const der = Buffer.from(csr.derBase64, 'base64');
    return { pem: lf(csr.pem), der, reference: entryReference(der) };
}

/**
 * Bytes no container format reads (not PEM, keystore or DER). Keep `length` away from 16: its base64 would read as a
 * padded uuid for the guard.
 */
export function garbageBytes(length = 64): Buffer {
    const out = Buffer.alloc(length);
    let x = 0x9e3779b9;
    for (let i = 0; i < length; i++) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        out[i] = i < 4 ? 0xff : (x >>> 24) & 0xff;
    }
    return out;
}

/**
 * A file of exactly `bytes` bytes that core reads as one certificate (PEM plus comment lines). One byte over
 * `LIMITS.fileBytes` hits the size rule before the format is read.
 */
export function paddedCertificatePem(cn: string, bytes: number): { file: Buffer; identity: Identity } {
    const identity = certificate(cn);
    const head = Buffer.from(`${identity.pem}\n`, 'ascii');
    if (bytes < head.length) throw new Error(`paddedCertificatePem: ${bytes} bytes cannot hold the certificate (${head.length})`);
    const line = Buffer.from(`# padding ${'.'.repeat(60)}\n`, 'ascii');
    const file = Buffer.alloc(bytes);
    head.copy(file, 0);
    for (let at = head.length; at < bytes; at += line.length) line.copy(file, at, 0, Math.min(line.length, bytes - at));
    return { file, identity };
}

/** `count` distinct self-signed certificates sharing one key pair, as one PEM bundle. */
export function certificatesInOnePem(count: number, cnPrefix: string): { pem: string; certs: Identity[] } {
    const k = sharedKeys();
    const certs = Array.from({ length: count }, (_, i) => certificate(`${cnPrefix}-${i + 1}`, { keys: k }));
    return { pem: certs.map((c) => c.pem).join(''), certs };
}

/** `count` distinct requests sharing one key pair, as one PEM file; they count as "other entries". */
export function requestsInOnePem(count: number, cnPrefix: string): { pem: string; references: string[] } {
    const k = sharedKeys();
    const csrs = Array.from({ length: count }, (_, i) => csrWithSan(`${cnPrefix}-${i + 1}`, [], { key: k.keys }));
    return { pem: csrs.map((c) => lf(c.pem)).join(''), references: csrs.map((c) => entryReference(Buffer.from(c.derBase64, 'base64'))) };
}


export interface UploadFile {
    name: string;
    mimeType: string;
    buffer: Buffer;
}

export const asFile = (name: string, buffer: Buffer | string, mimeType = 'application/octet-stream'): UploadFile => ({
    name,
    mimeType,
    buffer: typeof buffer === 'string' ? Buffer.from(buffer, 'utf8') : buffer,
});


export const ROUTES = {
    upload: '/api/v1/certificates/upload',
    uploadAsync: '/api/v1/certificates/upload/async',
    inspect: '/api/v1/inspections',
    import: '/api/v1/certificates/import',
} as const;

export const uploadBody = (file: Buffer, customAttributes: unknown[] = []): { certificate: string; customAttributes: unknown[] } => ({ certificate: toBase64(file), customAttributes });

/** What the `file` member holds: bytes (sent as base64), a raw value (malformed member) or nothing (missing member). */
export type FileMember = Buffer | { raw: unknown } | undefined;

const withFile = (file: FileMember): { file?: unknown } => (file === undefined ? {} : Buffer.isBuffer(file) ? { file: toBase64(file) } : { file: file.raw });

export function inspectionBody(file: FileMember, opts: { passphrase?: string; tokenProfileUuid?: unknown } = {}): Record<string, unknown> {
    return {
        ...withFile(file),
        ...(opts.passphrase === undefined ? {} : { passphrase: opts.passphrase }),
        ...(opts.tokenProfileUuid === undefined ? {} : { tokenProfileUuid: opts.tokenProfileUuid }),
    };
}

/** The body of a certificate-only import: the file and the entries named by their references; no `keyDestination`. */
export function importBody(file: Buffer, references: string[], opts: { passphrase?: string; customAttributes?: unknown[] } = {}): Record<string, unknown> {
    return {
        file: toBase64(file),
        entries: references.map((entryReference) => ({ entryReference })),
        ...(opts.passphrase === undefined ? {} : { passphrase: opts.passphrase }),
        ...(opts.customAttributes === undefined ? {} : { customAttributes: opts.customAttributes }),
    };
}
