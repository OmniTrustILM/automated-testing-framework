/**
 * estPki — the PKI plumbing the EST specs need, on node-forge.
 *
 * WHAT: creates a CA and certificates signed by it (with SANs and extended key usages, including
 * dotted OIDs such as id-kp-cmcRA), creates PKCS#10 CSRs, converts and fingerprints certificates,
 * and parses what EST answers: a certs-only PKCS#7, a `multipart/mixed` body, a PKCS#8 key and a
 * CsrAttrs structure.
 * WHY: the specs build their own client and RA certificates and must read EST responses byte by
 * byte, which a real EST client hides.
 * HOW: RSA only, 2048 bits, generated through forge's native Node path (no workers, no pure-JS
 * fallback). DER travels as Node Buffers; forge's binary strings stay inside this module.
 */

import * as crypto from 'crypto';
import * as forge from 'node-forge';

const { pki, asn1 } = forge;

export type KeyPair = forge.pki.rsa.KeyPair;
export type Certificate = forge.pki.Certificate;

export interface Ca {
  cert: Certificate;
  key: forge.pki.rsa.PrivateKey;
}

export interface CertOptions {
  /** A common name, or a full list of subject attributes. */
  subject: string | forge.pki.CertificateField[];
  /** DNS names for the subjectAltName extension. */
  sans?: string[];
  /** Extended key usages: forge names (`clientAuth`) or dotted OIDs (`1.3.6.1.5.5.7.3.28`). */
  eku?: string[];
  notBefore?: Date;
  notAfter?: Date;
  key?: KeyPair;
}

export interface CsrOptions {
  subject: string | forge.pki.CertificateField[];
  sans?: string[];
  key?: KeyPair;
}

export interface Csr {
  der: Buffer;
  base64: string;
  key: KeyPair;
}

export interface MultipartPart {
  headers: Record<string, string>;
  /** Media type of the part, without parameters, lowercased. */
  contentType: string;
  /** Body with any base64 Content-Transfer-Encoding already decoded. */
  body: Buffer;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toBinary(buf: Buffer): string {
  return buf.toString('binary');
}

function fromBinary(bin: string): Buffer {
  return Buffer.from(bin, 'binary');
}

function toName(subject: CertOptions['subject']): forge.pki.CertificateField[] {
  return typeof subject === 'string' ? [{ name: 'commonName', value: subject }] : subject;
}

function generateKey(): KeyPair {
  return pki.rsa.generateKeyPair({ bits: 2048 });
}

function newSerial(): string {
  return `01${crypto.randomBytes(15).toString('hex')}`;
}

function sanExtension(sans: string[]): Record<string, unknown> {
  return { name: 'subjectAltName', altNames: sans.map((value) => ({ type: 2, value })) };
}

export function createCa(opts: { cn: string; validityDays?: number }): Ca {
  const keys = generateKey();
  const cert = pki.createCertificate();
  const name = [{ name: 'commonName', value: opts.cn }];
  cert.publicKey = keys.publicKey;
  cert.serialNumber = newSerial();
  cert.validity.notBefore = new Date(Date.now() - DAY_MS);
  cert.validity.notAfter = new Date(Date.now() + (opts.validityDays ?? 365) * DAY_MS);
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

/** Issues a certificate signed by `ca`; returns it with its key (generated unless supplied). */
export function issueCert(ca: Ca, opts: CertOptions): { cert: Certificate; key: KeyPair } {
  const key = opts.key ?? generateKey();
  const cert = pki.createCertificate();
  cert.publicKey = key.publicKey;
  cert.serialNumber = newSerial();
  cert.validity.notBefore = opts.notBefore ?? new Date(Date.now() - DAY_MS);
  cert.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 30 * DAY_MS);
  cert.setSubject(toName(opts.subject));
  cert.setIssuer(ca.cert.subject.attributes);

  const extensions: Array<Record<string, unknown>> = [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
  ];
  if (opts.sans?.length) extensions.push(sanExtension(opts.sans));
  if (opts.eku?.length) {
    extensions.push({ name: 'extKeyUsage', ...Object.fromEntries(opts.eku.map((usage) => [usage, true])) });
  }
  cert.setExtensions(extensions);
  cert.sign(ca.key, forge.md.sha256.create());
  return { cert, key };
}

export function createCsr(opts: CsrOptions): Csr {
  const key = opts.key ?? generateKey();
  const csr = pki.createCertificationRequest();
  csr.publicKey = key.publicKey;
  csr.setSubject(toName(opts.subject));
  if (opts.sans?.length) {
    csr.setAttributes([{ name: 'extensionRequest', extensions: [sanExtension(opts.sans)] }]);
  }
  csr.sign(key.privateKey, forge.md.sha256.create());
  const der = fromBinary(asn1.toDer(pki.certificationRequestToAsn1(csr)).getBytes());
  return { der, base64: der.toString('base64'), key };
}

export function certToDer(cert: Certificate): Buffer {
  return fromBinary(asn1.toDer(pki.certificateToAsn1(cert)).getBytes());
}

export function certToPem(cert: Certificate): string {
  return pki.certificateToPem(cert);
}

export function derToCert(der: Buffer): Certificate {
  return pki.certificateFromAsn1(asn1.fromDer(toBinary(der)));
}

export function keyToPem(key: KeyPair): string {
  return pki.privateKeyToPem(key.privateKey);
}

/** Lowercase hex SHA-256 of the certificate's DER, the form the platform reports. */
export function sha256Fingerprint(certOrDer: Certificate | Buffer): string {
  const der = Buffer.isBuffer(certOrDer) ? certOrDer : certToDer(certOrDer);
  return crypto.createHash('sha256').update(der).digest('hex');
}

/** Certificates of a certs-only PKCS#7 (SignedData) in DER. */
export function parseCertsOnly(der: Buffer): Certificate[] {
  const message = forge.pkcs7.messageFromAsn1(asn1.fromDer(toBinary(der))) as unknown as { certificates: Certificate[] };
  return message.certificates;
}

const SIGNED_DATA_OID = '1.2.840.113549.1.7.2';

/**
 * DER of each certificate in a certs-only PKCS#7, read from the structure rather than parsed as
 * certificates, so chains with non-RSA keys (which forge cannot read) are handled. Anything that
 * is not certs-only — another content type, enclosed content, signers — throws.
 */
export function parseCertsOnlyDer(der: Buffer): Buffer[] {
  const contentInfo = asn1.fromDer(toBinary(der));
  const [contentType, explicitContent] = contentInfo.value as forge.asn1.Asn1[];
  if (asn1.derToOid(contentType.value as string) !== SIGNED_DATA_OID) {
    throw new Error('Not a PKCS#7 SignedData');
  }
  const signedData = (explicitContent.value as forge.asn1.Asn1[])[0];
  const fields = signedData.value as forge.asn1.Asn1[];
  const [, , encapContentInfo] = fields;
  const signerInfos = fields[fields.length - 1];
  if ((encapContentInfo.value as forge.asn1.Asn1[]).length !== 1) {
    throw new Error('Not certs-only: SignedData carries content');
  }
  if (signerInfos.type !== asn1.Type.SET || (signerInfos.value as forge.asn1.Asn1[]).length !== 0) {
    throw new Error('Not certs-only: SignedData carries signers');
  }
  const certificates = fields.find((node) => node.tagClass === asn1.Class.CONTEXT_SPECIFIC && node.type === 0);
  if (!certificates) return [];
  return (certificates.value as forge.asn1.Asn1[]).map((node) => Buffer.from(asn1.toDer(node).getBytes(), 'binary'));
}

/** Parses a `multipart/mixed` body into its parts, decoding base64 parts. */
export function parseMultipartMixed(contentTypeHeader: string, body: Buffer): MultipartPart[] {
  const boundary = /boundary="?([^";\s]+)"?/i.exec(contentTypeHeader)?.[1];
  if (!boundary) throw new Error(`No boundary in Content-Type: ${contentTypeHeader}`);

  // latin1 maps bytes to code points one to one, so splitting the text never alters the bytes.
  const segments = body.toString('latin1').split(`--${boundary}`).slice(1);
  const parts: MultipartPart[] = [];
  let closed = false;
  for (const segment of segments) {
    if (segment.startsWith('--')) {
      closed = true;
      break;
    }
    const content = segment.replace(/^\r?\n/, '');
    const split = /\r?\n\r?\n/.exec(content);
    if (!split) throw new Error('Multipart part has no header/body separator');

    const headers: Record<string, string> = {};
    for (const line of content.slice(0, split.index).split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    let partBody = Buffer.from(content.slice(split.index + split[0].length).replace(/\r?\n$/, ''), 'latin1');
    if (headers['content-transfer-encoding']?.toLowerCase() === 'base64') {
      partBody = Buffer.from(partBody.toString('latin1').replace(/\s+/g, ''), 'base64');
    }
    parts.push({ headers, contentType: (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(), body: partBody });
  }
  if (!closed) throw new Error(`Multipart body has no closing delimiter --${boundary}--`);
  return parts;
}

/** Reads an unencrypted PKCS#8 PrivateKeyInfo in DER. */
export function parsePkcs8Der(der: Buffer): forge.pki.rsa.PrivateKey {
  return pki.privateKeyFromAsn1(asn1.fromDer(toBinary(der))) as forge.pki.rsa.PrivateKey;
}

/** Whether the private key (or PKCS#8 DER) belongs to the certificate's public key. */
export function keyMatchesCert(key: forge.pki.rsa.PrivateKey | Buffer, cert: Certificate): boolean {
  const privateKey = Buffer.isBuffer(key) ? parsePkcs8Der(key) : key;
  const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;
  return privateKey.n.equals(publicKey.n) && privateKey.e.equals(publicKey.e);
}

/**
 * Whether the bytes are a DER CsrAttrs: a SEQUENCE of OBJECT IDENTIFIERs and Attributes, an
 * Attribute being a SEQUENCE of an OBJECT IDENTIFIER and a SET.
 */
export function isDerCsrAttrs(der: Buffer): boolean {
  try {
    const parsed = asn1.fromDer(toBinary(der));
    if (!isUniversal(parsed, asn1.Type.SEQUENCE)) return false;
    return (parsed.value as forge.asn1.Asn1[]).every((element) => {
      if (isOid(element)) return true;
      if (!isUniversal(element, asn1.Type.SEQUENCE)) return false;
      const parts = element.value as forge.asn1.Asn1[];
      return parts.length === 2 && isOid(parts[0]) && isUniversal(parts[1], asn1.Type.SET);
    });
  } catch {
    return false;
  }
}

function isUniversal(node: forge.asn1.Asn1, type: number): boolean {
  return node.tagClass === asn1.Class.UNIVERSAL && node.type === type;
}

/** A primitive OBJECT IDENTIFIER with content whose last subidentifier is terminated. */
function isOid(node: forge.asn1.Asn1): boolean {
  if (!isUniversal(node, asn1.Type.OID) || typeof node.value !== 'string') return false;
  return node.value.length > 0 && (node.value.charCodeAt(node.value.length - 1) & 0x80) === 0;
}
