/**
 * In-memory builders of the files the import, inspection and upload rows send (certificates, PKCS#7, PKCS#12, PEM
 * bundles, CSRs, garbage bytes) and the exact refusal texts core answers for them. No network, no file system, no ledger:
 * a builder returns bytes and the reference values a test recomputes; names are run-prefixed (`importCn`).
 */
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import { csrWithSan, newKeyMaterial, pemToDer, sha256Hex } from '../pkiBuilders';
import { runName } from '../ledger/runState';

// ------------------------------------------------------------------ limits and exact texts

/** The limits core holds one uploaded file to (names of the code constants in the comments). */
export const LIMITS = {
    /** `UploadedFile.MAXIMUM_LENGTH` (interfaces model/core/secret/UploadedFile.java:25), decoded bytes. */
    fileBytes: 5 * 1024 * 1024,
    /** `ContainerLimits.MAXIMUM_CERTIFICATES` (container/ContainerLimits.java:10). */
    certificates: 200,
    /** `ContainerLimits.MAXIMUM_OTHER_ENTRIES` (container/ContainerLimits.java:13): keys, secret keys and requests together. */
    otherEntries: 100,
} as const;

/** `KeyFileRefusal.LIMIT_EXCEEDED` = "The file exceeds the %s limit of %s." (key/normalization/KeyFileRefusal.java:21). */
export const limitExceeded = (limit: string, maximum: number): string => `The file exceeds the ${limit} limit of ${maximum}.`;

/** The fixed 422 messages. Each is one element of the 422 JSON array (`["<text>"]`). */
export const REFUSAL = {
    /** ContainerRefusal.NOT_SUPPORTED_FORMAT (container/ContainerRefusal.java:13-15). */
    notSupportedFormat:
        'The file is not in a supported format: PKCS#12, JKS, JCEKS, PEM, PKCS#7, a certificate, a certificate request, a PKCS#8 key, an OpenSSL traditional key or an OpenSSH private key.',
    /** ContainerRefusal.PEM_TOO_MANY_KEYS (:19). */
    pemTooManyKeys: 'A PEM file can hold at most one private key.',
    /** ContainerRefusal.PEM_BLOCK_UNSUPPORTED (:17) with the block type, repeated when it matches `[A-Za-z0-9 .-]{1,64}` (KeyFileRefusal.REPEATABLE). */
    pemBlockUnsupported: (type: string): string => `The file holds a PEM block of type ${type}, which is not supported.`,
    /** ContainerRefusal.INTEGRITY_FAILED (:21-22): a PKCS#12 whose MAC does not verify — password wrong OR missing, one string. */
    integrityFailed: "The file's integrity check failed: the passphrase is wrong or missing, or the file is damaged.",
    /** ContainerRefusal.TWO_PASSPHRASES (:27-28). */
    twoPassphrases: 'The file protects its keys with a different passphrase than the file itself, which is not supported.',
    /** KeyFileRefusal.UNREADABLE (key/normalization/KeyFileRefusal.java:23-24): a protected key, passphrase wrong OR missing, one string. */
    keyUnreadable: 'The key could not be read: the passphrase is wrong or missing, or the file is damaged.',
    /** `LIMIT_EXCEEDED` with ContainerLimits.CERTIFICATE_LIMIT ("certificate count", :15) and the maximum (:10). */
    certificateCount: limitExceeded('certificate count', LIMITS.certificates),
    /** `LIMIT_EXCEEDED` with ContainerLimits.ENTRY_LIMIT ("entry count", :17) and the maximum (:13). */
    entryCount: limitExceeded('entry count', LIMITS.otherEntries),
    /** `UploadRequestDto.isFileWithinLimit` (interfaces model/client/upload/UploadRequestDto.java:48-51), prefixed with the property name by bean validation. */
    fileTooLarge: `fileWithinLimit file must not exceed ${LIMITS.fileBytes} bytes`,
    /** `@NotNull(message = "file is required")` (UploadRequestDto.java:36), prefixed with the field. */
    fileRequired: 'file file is required',
    /** FileInspectionServiceImpl.NOT_A_UUID (core service/impl/FileInspectionServiceImpl.java:56, thrown :109). */
    tokenProfileNotUuid: 'tokenProfileUuid must be a UUID',
    /** NotFoundException(TokenProfile.class, uuid) (FileInspectionServiceImpl.java:98 via KeyImportGates.requireAccess:94-99): the 404 `{message}`. */
    tokenProfileNotFound: (uuid: string): string => `Object of type 'TokenProfile' identified by ${uuid} is not found.`,
    /** `UploadedFileDeserializer.WRONG_FORMAT` (interfaces model/core/secret/UploadedFileDeserializer.java): answered as the 400 "Unable to read HTTP message" (ExceptionHandlingAdvice.java:397). */
    unreadableMessage: 'Unable to read HTTP message',
    // Plain upload (`POST /v1/certificates/upload`, `/upload/async`)
    /** CertificateUtil.parseUploadedCertificateContent (core util/CertificateUtil.java:318-320). */
    uploadKeystore: 'The file is a keystore. Import it with the certificate import operation.',
    /** CertificateUtil.java:339-340 with the PEM type. */
    uploadNotCertificate: (type: string): string => `Uploaded PEM encoded content is not certificate. Uploaded PEM type: ${type}`,
    /** CertificateUtil.java:353. */
    uploadInvalid: 'Uploaded certificate content has invalid or unsupported format.',
    /** CertificateUploadServiceImpl.java:65 → AlreadyExistException → 409 `{message}` (ExceptionHandlingAdvice.java:129-134). */
    uploadDuplicate: (fingerprint: string): string => `Certificate already exists with fingerprint ${fingerprint}`,
    /** The wizard's inline refusal of a certificate request (FE ImportWizard/importRequest.ts:38). */
    requestNotImported: 'Certificate requests are not imported',
} as const;

/** The red alert of the wizard for a refused inspection: `extractError(err, 'Failed to read the uploaded file')` (FE ducks/inspections-epics.ts:18, utils/net.ts). */
export const inspectionAlert = (status: number, text: string): string => `Failed to read the uploaded file (${status}): ${text}`;

// ------------------------------------------------------------------ names, encodings, references

let counter = 0;

/** A run-prefixed common name, unique per call (safe under `--repeat-each`): `<run id>-imp-<time>-<n>-<suffix>`. */
export function importCn(suffix: string): string {
    counter += 1;
    return runName(`imp-${Date.now().toString(36)}-${counter}-${suffix}`);
}

export const toBase64 = (bytes: Buffer | Uint8Array | string): string => Buffer.from(bytes as Buffer).toString('base64');

/** `entryReference` of a certificate / request entry: lowercase hex SHA-256 of its DER (InspectedEntryDto.entryReference, interfaces). */
export const entryReference = (der: Buffer): string => sha256Hex(der);

/** The certificate fingerprint the inventory search uses (`FINGERPRINT`): lowercase hex SHA-256 of the DER. */
export const certificateFingerprint = (derOrPem: Buffer | string): string => sha256Hex(typeof derOrPem === 'string' ? pemToDer(derOrPem) : derOrPem);

/** `containerDigest` of an inspection answer: lowercase hex SHA-256 of the uploaded file. */
export const containerDigest = (file: Buffer): string => sha256Hex(file);

/** `entryReference` of a key pair / private key entry: lowercase hex SHA-256 of the key's SubjectPublicKeyInfo DER. */
export const keyReference = (spkiDer: Buffer): string => sha256Hex(spkiDer);

/** forge writes PEM with CRLF line ends; the suite's fixtures use LF (core reads both). */
const lf = (pem: string): string => pem.replace(/\r\n/g, '\n');

const wrap64 = (text: string): string => text.match(/.{1,64}/g)?.join('\n') ?? '';

/** A PEM block of the given type around DER bytes (64-column lines, `\n` line ends, trailing newline). */
export function pemBlock(type: string, der: Buffer): string {
    return `-----BEGIN ${type}-----\n${wrap64(der.toString('base64'))}\n-----END ${type}-----\n`;
}

// ------------------------------------------------------------------ keys and certificates

let shared: { keys: forge.pki.rsa.KeyPair; spki: Buffer } | undefined;

function sharedKeys(): { keys: forge.pki.rsa.KeyPair; spki: Buffer } {
    if (!shared) shared = newKeyMaterial();
    return shared;
}

export interface Identity {
    cn: string;
    keys: forge.pki.rsa.KeyPair;
    cert: forge.pki.Certificate;
    /** PEM of the certificate (LF line ends, 64-column lines). */
    pem: string;
    der: Buffer;
    /** SHA-256 of the DER: the certificate fingerprint and the entry reference. */
    fingerprint: string;
    /** DER of the key's SubjectPublicKeyInfo and its reference. */
    spki: Buffer;
    keyReference: string;
    /** The private key as unencrypted PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`). */
    pkcs8Pem: string;
}

export interface CertificateOptions {
    /** Validity in days from now (default 30). */
    days?: number;
    /** An existing key pair (bulk builders share one). */
    keys?: { keys: forge.pki.rsa.KeyPair; spki: Buffer; pkcs8Pem?: string };
    /** `true` marks a CA (basicConstraints cA, keyCertSign). */
    ca?: boolean;
    /** The issuer; default: self-signed. */
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

/** An X.509 certificate with a fresh serial number, `CN=<cn>`, signed with SHA-256 (self-signed unless `issuer` is given). */
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

/** A PEM certificate and its DER / fingerprint (`REG-CERT-63`: nothing in it is imported; API-CERT-68: it is uploaded). */
export const certificatePem = (cn: string): Identity => certificate(cn);

// ------------------------------------------------------------------ PKCS#7 (degenerate SignedData with certificates)

/** The DER of a degenerate PKCS#7 `SignedData` that carries the certificates and nothing else. */
export function pkcs7Der(certs: Identity[]): Buffer {
    const p7 = forge.pkcs7.createSignedData();
    for (const c of certs) p7.addCertificate(c.cert);
    return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

/** The same as a `-----BEGIN PKCS7-----` block (the type PemFormat and the plain upload both accept). */
export const pkcs7Pem = (certs: Identity[]): string => pemBlock('PKCS7', pkcs7Der(certs));

// ------------------------------------------------------------------ PKCS#8 keys (node:crypto)

export interface Pkcs8Key {
    /** `-----BEGIN PRIVATE KEY-----` or `-----BEGIN ENCRYPTED PRIVATE KEY-----`. */
    pem: string;
    der: Buffer;
    /** SubjectPublicKeyInfo DER of the key pair and its entry reference. */
    spki: Buffer;
    keyReference: string;
}

/**
 * A fresh RSA-2048 key as PKCS#8. With a passphrase it is `ENCRYPTED PRIVATE KEY` under PBES2 (PBKDF2 with
 * HMAC-SHA256, AES-256-CBC), the protection core accepts (KeyProtection.PBKDF2_PRFS / PBES2_CIPHERS,
 * key/normalization/KeyProtection.java:55-70; SHA-1 as PRF would be refused as "protected with ... not supported").
 */
export function pkcs8Key(passphrase?: string): Pkcs8Key {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: passphrase === undefined ? { type: 'pkcs8', format: 'pem' } : { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
    });
    return { pem: privateKey, der: pemToDer(privateKey), spki: Buffer.from(publicKey), keyReference: sha256Hex(publicKey) };
}

// ------------------------------------------------------------------ PKCS#12 (node-forge)

export interface Pkcs12Fixture {
    bytes: Buffer;
    identity: Identity;
    password: string;
}

/**
 * A PKCS#12 with the certificate and its key (3DES / RC2 under PKCS#12 PBE, classic SHA-1 MAC), protected by `password`
 * (`''` = the empty password OpenSSL and keytool write; core opens such a file without a passphrase). The existing
 * `selfSignedPkcs12` of pkiBuilders.ts is the same construction.
 */
export function pkcs12(cn: string, password: string): Pkcs12Fixture {
    const identity = certificate(cn);
    const asn1 = forge.pkcs12.toPkcs12Asn1(identity.keys.privateKey, [identity.cert], password, { algorithm: '3des' });
    return { bytes: Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'), identity, password };
}

const OID = (id: string) => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer(id).getBytes());
const SEQ = (items: forge.asn1.Asn1[]) => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, items);
const EXPLICIT0 = (items: forge.asn1.Asn1[]) => forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, items);
const OCTETS = (bytes: string) => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, bytes);
const INT = (n: number) => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, forge.asn1.integerToDer(n).getBytes());

/**
 * A PKCS#12 whose MAC is computed with `filePassphrase` while its key is protected (PBES2, SHA-256 PRF, AES-256) under
 * `keyPassphrase`: core verifies the MAC with the passphrase it is given, then finds that the key does not open and
 * answers TWO_PASSPHRASES (ContainerAssembler.description, ContainerAssembler.java:137-146; Pkcs12Format class comment).
 * Built by hand because node-forge protects every part of a file with one password: AuthenticatedSafe = one plain
 * `data` safe holding a shrouded key bag and a certificate bag; MacData = SHA-1 HMAC over the AuthenticatedSafe, key
 * derived with the PKCS#12 KDF (id 3), 2048 iterations (the construction of forge's own `toPkcs12Asn1`).
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

// ------------------------------------------------------------------ PEM compositions

export interface Bundle {
    /** Leaf certificate, then its CA, then the leaf's key (PKCS#8): the order OpenSSL users paste. */
    pem: string;
    leaf: Identity;
    ca: Identity;
}

/** A PEM with two private keys (PKCS#8 plain): refused whole, whatever else it holds. */
export function pemTwoKeys(): string {
    return `${pkcs8Key().pem}${pkcs8Key().pem}`;
}

/**
 * A `-----BEGIN DH PARAMETERS-----` block: DER SEQUENCE { INTEGER p, INTEGER g } of RFC 3526 group 14 (2048 bits, g = 2),
 * the form `openssl dhparam` writes. It is a PEM type the reader does not take.
 */
export function dhParametersPem(): string {
    const group = crypto.getDiffieHellman('modp14');
    const asInteger = (bytes: Buffer) => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, (bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes).toString('binary'));
    const der = Buffer.from(forge.asn1.toDer(SEQ([asInteger(group.getPrime()), asInteger(group.getGenerator())])).getBytes(), 'binary');
    return pemBlock('DH PARAMETERS', der);
}

/** A PKCS#10 request as PEM (`CERTIFICATE REQUEST`), RSA-2048, `CN=<cn>`; its entry reference is the SHA-256 of `der`. */
export function csrPem(cn: string): { pem: string; der: Buffer; reference: string } {
    const csr = csrWithSan(cn);
    const der = Buffer.from(csr.derBase64, 'base64');
    return { pem: lf(csr.pem), der, reference: entryReference(der) };
}

/**
 * Bytes no container format reads: not PEM (no `-----BEGIN `), not a keystore (no JKS / JCEKS magic, no PFX version),
 * and not a DER structure (the first byte 0xFF opens a high-tag-number form that runs out of bytes). `length` defaults
 * to 64; keep it away from 16 raw bytes, whose base64 is a 22-character token ending `==` that the guard reads as a
 * padded uuid (guard/uuids.ts, rule 3 "Jackson's padded base64 form").
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
 * A file of EXACTLY `bytes` decoded bytes that core reads as one certificate: the certificate PEM, then comment lines
 * (text around the PEM blocks is left aside, PemFormat class comment), cut to the length. At `LIMITS.fileBytes` the size
 * rule lets it through (the inspection answers one `certificate` entry); at `LIMITS.fileBytes + 1` the size rule refuses
 * it before the content is read (UploadRequestDto.isFileWithinLimit), so the refusal is the limit's, not the format's.
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

/** `count` distinct self-signed certificates, one key pair shared, as one PEM bundle (201 → "certificate count" refusal; 200 → accepted). */
export function certificatesInOnePem(count: number, cnPrefix: string): { pem: string; certs: Identity[] } {
    const k = sharedKeys();
    const certs = Array.from({ length: count }, (_, i) => certificate(`${cnPrefix}-${i + 1}`, { keys: k }));
    return { pem: certs.map((c) => c.pem).join(''), certs };
}

/** `count` distinct certificate requests (one key pair shared) as one PEM file: they count as "other entries" (101 → "entry count" refusal; 100 → accepted). */
export function requestsInOnePem(count: number, cnPrefix: string): { pem: string; references: string[] } {
    const k = sharedKeys();
    const csrs = Array.from({ length: count }, (_, i) => csrWithSan(`${cnPrefix}-${i + 1}`, [], { key: k.keys }));
    return { pem: csrs.map((c) => lf(c.pem)).join(''), references: csrs.map((c) => entryReference(Buffer.from(c.derBase64, 'base64'))) };
}

// ------------------------------------------------------------------ bytes of a PEM text as an upload file

/** The file the browser chooser takes: name, MIME type and bytes. */
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

// ------------------------------------------------------------------ request shapes (pure)

/** The routes of the surfaces (paths as the suite sends them; the guard judges each — see the guard requests of the area). */
export const ROUTES = {
    upload: '/api/v1/certificates/upload',
    uploadAsync: '/api/v1/certificates/upload/async',
    inspect: '/api/v1/inspections',
    import: '/api/v1/certificates/import',
} as const;

/** The body of a plain upload: the file as base64 in `certificate` (`UploadCertificateRequestDto`), plus the custom attributes. */
export const uploadBody = (file: Buffer, customAttributes: unknown[] = []): { certificate: string; customAttributes: unknown[] } => ({ certificate: toBase64(file), customAttributes });

/** What the `file` member holds: the bytes (sent as base64), a value sent as it is (a malformed file member), or nothing (a missing member). */
export type FileMember = Buffer | { raw: unknown } | undefined;

const withFile = (file: FileMember): { file?: unknown } => (file === undefined ? {} : Buffer.isBuffer(file) ? { file: toBase64(file) } : { file: file.raw });

/** The body of an inspection (`InspectionRequestDto`): `file`, an optional `passphrase`, an optional `tokenProfileUuid`. */
export function inspectionBody(file: FileMember, opts: { passphrase?: string; tokenProfileUuid?: unknown } = {}): Record<string, unknown> {
    return {
        ...withFile(file),
        ...(opts.passphrase === undefined ? {} : { passphrase: opts.passphrase }),
        ...(opts.tokenProfileUuid === undefined ? {} : { tokenProfileUuid: opts.tokenProfileUuid }),
    };
}

/** The body of a certificate-only import (`CertificateImportRequestDto`): the file and the entries named by their references; no `keyDestination`. */
export function importBody(file: Buffer, references: string[], opts: { passphrase?: string; customAttributes?: unknown[] } = {}): Record<string, unknown> {
    return {
        file: toBase64(file),
        entries: references.map((entryReference) => ({ entryReference })),
        ...(opts.passphrase === undefined ? {} : { passphrase: opts.passphrase }),
        ...(opts.customAttributes === undefined ? {} : { customAttributes: opts.customAttributes }),
    };
}
