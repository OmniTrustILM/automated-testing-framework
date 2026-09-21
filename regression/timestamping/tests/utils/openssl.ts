import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type Digest = 'sha256' | 'sha384' | 'sha512' | 'sha1';

export interface OpensslResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function openssl(args: string[]): OpensslResult {
  try {
    const stdout = execFileSync('openssl', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Without this, openssl.cnf's [new_oids] section makes `ts -reply -text` print the
      // local alias (tsa_policy2) instead of the OID, so assertions would depend on the
      // machine's openssl configuration.
      env: { ...process.env, OPENSSL_CONF: '/dev/null' },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? String(error),
      exitCode: failure.status ?? 1,
    };
  }
}

export interface QueryOptions {
  dir: string;
  content?: string;
  digest?: Digest;
  nonce?: boolean;
  certReq?: boolean;
  policyOid?: string | null;
}

export interface BuiltQuery {
  queryPath: string;
  dataPath: string;
}

export interface QueryInfo {
  raw: string;
  nonce?: string;
  nonceHex?: string;
}

/** Builds a DER-encoded TimeStampReq with `openssl ts -query`. */
export function buildTimestampQuery(options: QueryOptions): BuiltQuery {
  const dataPath = path.join(options.dir, 'input.txt');
  const queryPath = path.join(options.dir, 'query.tsq');
  fs.writeFileSync(dataPath, options.content ?? `regression suite ${new Date().toISOString()}\n`);

  const args = ['ts', '-query', '-data', dataPath, `-${options.digest ?? 'sha256'}`, '-out', queryPath];
  if (options.certReq !== false) args.push('-cert');
  if (options.nonce === false) args.push('-no_nonce');
  if (options.policyOid) args.push('-tspolicy', options.policyOid);

  const result = openssl(args);
  if (result.exitCode !== 0) {
    throw new Error(`openssl ts -query failed: ${result.stderr}`);
  }
  return { queryPath, dataPath };
}

export function parseTimestampQuery(queryPath: string): QueryInfo {
  const result = openssl(['ts', '-query', '-in', queryPath, '-text']);
  if (result.exitCode !== 0) {
    throw new Error(`openssl ts -query -text failed: ${result.stderr}`);
  }

  const raw = result.stdout + result.stderr;
  const nonce = raw.match(/^Nonce:\s*(.+)$/m)?.[1].trim();
  return {
    raw,
    nonce,
    nonceHex: isSpecified(nonce) ? normalizeHexInteger(nonce!) : undefined,
  };
}

export interface ReplyInfo {
  raw: string;
  status: string;
  granted: boolean;
  statusDescription?: string;
  failureInfo?: string;
  version?: string;
  policyOid?: string;
  hashAlgorithm?: string;
  serialNumber?: string;
  serialNumberHex?: string;
  timestamp?: string;
  accuracy?: string;
  accuracySpecified: boolean;
  accuracyMicroseconds?: number;
  ordering?: string;
  nonce?: string;
  nonceSpecified: boolean;
  nonceHex?: string;
  tsa?: string;
  extensionsText: string;
  hasQcStatements: boolean;
}

const FIELD_PATTERNS: Array<[keyof ReplyInfo, RegExp]> = [
  ['status', /^Status:\s*(.+?)\.?\s*$/m],
  ['statusDescription', /^Status description:\s*(.+)$/m],
  ['failureInfo', /^Failure info:\s*(.+)$/m],
  ['version', /^Version:\s*(.+)$/m],
  ['policyOid', /^Policy OID:\s*(.+)$/m],
  ['hashAlgorithm', /^Hash Algorithm:\s*(.+)$/m],
  ['serialNumber', /^Serial number:\s*(.+)$/m],
  ['timestamp', /^Time stamp:\s*(.+)$/m],
  ['accuracy', /^Accuracy:\s*(.+)$/m],
  ['ordering', /^Ordering:\s*(.+)$/m],
  ['nonce', /^Nonce:\s*(.+)$/m],
  ['tsa', /^TSA:\s*(.+)$/m],
];

/**
 * Parses `openssl ts -reply -text`. Only the TimeStampResp is rendered, so the extension
 * block belongs to the TSTInfo — not to the signer certificate embedded in the token.
 */
export function parseTimestampReply(responsePath: string): ReplyInfo {
  const result = openssl(['ts', '-reply', '-in', responsePath, '-text']);
  const raw = result.stdout + result.stderr;

  const info: ReplyInfo = {
    raw,
    status: '',
    granted: false,
    accuracySpecified: false,
    nonceSpecified: false,
    extensionsText: '',
    hasQcStatements: false,
  };

  for (const [field, pattern] of FIELD_PATTERNS) {
    const match = raw.match(pattern);
    if (match) {
      (info as unknown as Record<string, unknown>)[field] = match[1].trim();
    }
  }

  info.granted = /^Status:\s*Granted/m.test(raw);
  // openssl prints the literal "unspecified" for absent optional fields rather than
  // omitting the line.
  info.accuracySpecified = isSpecified(info.accuracy);
  info.nonceSpecified = isSpecified(info.nonce);
  if (info.accuracySpecified) {
    info.accuracyMicroseconds = parseAccuracyMicroseconds(info.accuracy!);
  }
  if (info.nonceSpecified) {
    info.nonceHex = normalizeHexInteger(info.nonce!);
  }
  if (info.serialNumber) {
    info.serialNumberHex = normalizeSerial(info.serialNumber);
  }

  const extensionsIndex = raw.indexOf('Extensions:');
  info.extensionsText = extensionsIndex >= 0 ? raw.slice(extensionsIndex) : '';
  info.hasQcStatements = /qcStatements|1\.3\.6\.1\.5\.5\.7\.1\.3/i.test(info.extensionsText);

  return info;
}

/**
 * Serial numbers are printed as 0x…; signing records carry them as unpadded lower-case hex
 * without a 0x prefix and without leading zeros.
 */
export function normalizeSerial(printed: string): string {
  return normalizeHexInteger(printed);
}

function normalizeHexInteger(printed: string): string {
  const hex = printed.trim().replace(/^0x/i, '').replace(/[\s:]+/g, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`Not a hexadecimal integer: '${printed}'`);
  }
  const stripped = hex.replace(/^0+/, '');
  return stripped.length > 0 ? stripped : '0';
}

function isSpecified(value: string | undefined): boolean {
  return value !== undefined && !/^unspecified$/i.test(value.trim());
}

export function parseAccuracyMicroseconds(printed: string): number {
  if (!isSpecified(printed)) {
    throw new Error('Cannot parse an unspecified timestamp accuracy');
  }

  const component = (unit: 'seconds' | 'millis' | 'micros'): number => {
    const match = printed.match(new RegExp(`(?:^|,\\s*)(unspecified|0x[0-9a-f]+|[0-9]+)\\s+${unit}\\b`, 'i'));
    if (!match) {
      throw new Error(`Cannot parse timestamp accuracy '${printed}'`);
    }
    return /^unspecified$/i.test(match[1]) ? 0 : Number(match[1]);
  };

  return component('seconds') * 1_000_000 + component('millis') * 1_000 + component('micros');
}

export function isoDurationToMicroseconds(duration: string): number {
  const match = duration.match(
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!match || !match.slice(1).some((part) => part !== undefined)) {
    throw new Error(`Unsupported ISO 8601 duration '${duration}'`);
  }

  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
  const microseconds =
    (Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds)) * 1_000_000;
  const rounded = Math.round(microseconds);
  if (!Number.isSafeInteger(rounded) || Math.abs(microseconds - rounded) > 1e-6) {
    throw new Error(`Duration '${duration}' cannot be represented as whole microseconds`);
  }
  return rounded;
}

export interface VerificationResult {
  ok: boolean;
  output: string;
}

/** Verifies a token against a trusted chain; optionally re-checks the message imprint. */
export function verifyTimestamp(
  responsePath: string,
  caFile: string,
  options: { queryPath?: string; dataPath?: string; untrustedFile?: string } = {},
): VerificationResult {
  const args = ['ts', '-verify', '-in', responsePath, '-CAfile', caFile];
  if (options.untrustedFile) {
    args.push('-untrusted', options.untrustedFile);
  }
  if (options.dataPath) {
    args.push('-data', options.dataPath);
  } else if (options.queryPath) {
    args.push('-queryfile', options.queryPath);
  }
  const result = openssl(args);
  const output = result.stdout + result.stderr;
  return { ok: result.exitCode === 0 && /Verification: OK/.test(output), output };
}

// --- ML-DSA token verification ------------------------------------------------
// `openssl ts -verify` cannot check a post-quantum token: PKCS7_signatureVerify drives the
// signature through EVP_DigestVerify, and OpenSSL's ML-DSA implementation refuses that
// interface ("provider signature not supported: ML-DSA-65 verify_init"). The token itself is
// well formed — openssl verifies the very same signature through `pkeyutl -rawin`.
//
// So the equivalent checks are performed one by one, which is what `ts -verify` does
// internally anyway: the signer's chain is trusted, the signature over signedAttrs is valid,
// and the signed messageDigest is the digest of the TSTInfo actually returned.

interface DerNode {
  tag: number;
  headerLength: number;
  length: number;
  start: number;
  contentStart: number;
  end: number;
}

function readDerNode(buffer: Buffer, offset: number): DerNode {
  const tag = buffer[offset];
  const first = buffer[offset + 1];
  let length: number;
  let headerLength: number;

  if ((first & 0x80) === 0) {
    length = first;
    headerLength = 2;
  } else {
    const lengthBytes = first & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4) {
      throw new Error(`Unsupported DER length encoding at offset ${offset}`);
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + buffer[offset + 2 + index];
    }
    headerLength = 2 + lengthBytes;
  }

  const contentStart = offset + headerLength;
  return { tag, headerLength, length, start: offset, contentStart, end: contentStart + length };
}

function derChildren(buffer: Buffer, node: DerNode): DerNode[] {
  const children: DerNode[] = [];
  let offset = node.contentStart;
  while (offset < node.end) {
    const child = readDerNode(buffer, offset);
    children.push(child);
    offset = child.end;
  }
  return children;
}

function requireChild(children: DerNode[], predicate: (node: DerNode) => boolean, what: string): DerNode {
  const found = children.find(predicate);
  if (!found) throw new Error(`Malformed CMS token: ${what} not found`);
  return found;
}

const DER_SEQUENCE = 0x30;
const DER_SET = 0x31;
const DER_OCTET_STRING = 0x04;
const DER_CONTEXT_0 = 0xa0;

interface CmsSignerParts {
  /** signedAttrs re-tagged from [0] IMPLICIT to SET OF, which is what the signature covers. */
  signedAttributes: Buffer;
  signature: Buffer;
  encapsulatedContent: Buffer;
}

/** Pulls out the pieces of a single-signer CMS SignedData that a signature check needs. */
function parseCmsToken(tokenPath: string): CmsSignerParts {
  const buffer = fs.readFileSync(tokenPath);

  const contentInfo = readDerNode(buffer, 0);
  const contentInfoChildren = derChildren(buffer, contentInfo);
  const wrapper = requireChild(contentInfoChildren, (node) => node.tag === DER_CONTEXT_0, 'SignedData wrapper');
  const signedData = readDerNode(buffer, wrapper.contentStart);
  const signedDataChildren = derChildren(buffer, signedData);

  // encapContentInfo: SEQUENCE { eContentType OID, [0] { OCTET STRING eContent } }
  const encapContentInfo = requireChild(
    signedDataChildren,
    (node) => node.tag === DER_SEQUENCE,
    'encapContentInfo',
  );
  const eContentWrapper = requireChild(
    derChildren(buffer, encapContentInfo),
    (node) => node.tag === DER_CONTEXT_0,
    'eContent',
  );
  const eContent = readDerNode(buffer, eContentWrapper.contentStart);

  // signerInfos is the last SET, after the optional [0] certificates and [1] crls.
  const signerInfos = [...signedDataChildren].reverse().find((node) => node.tag === DER_SET);
  if (!signerInfos) throw new Error('Malformed CMS token: signerInfos not found');
  const signerInfo = readDerNode(buffer, signerInfos.contentStart);
  const signerInfoChildren = derChildren(buffer, signerInfo);

  const signedAttrsNode = requireChild(signerInfoChildren, (node) => node.tag === DER_CONTEXT_0, 'signedAttrs');
  // The signature is computed over the DER SET OF encoding, not over the [0] IMPLICIT tag
  // the token carries (RFC 5652 §5.4).
  const signedAttributes = Buffer.from(buffer.subarray(signedAttrsNode.start, signedAttrsNode.end));
  signedAttributes[0] = DER_SET;

  const signatureNode = [...signerInfoChildren]
    .reverse()
    .find((node) => node.tag === DER_OCTET_STRING && node.start > signedAttrsNode.end);
  if (!signatureNode) throw new Error('Malformed CMS token: signature not found');

  return {
    signedAttributes,
    signature: buffer.subarray(signatureNode.contentStart, signatureNode.end),
    encapsulatedContent: buffer.subarray(eContent.contentStart, eContent.end),
  };
}

/** The messageDigest attribute value, and the digest algorithm it was produced with. */
function signedMessageDigest(signedAttributes: Buffer, dir: string): { digest: string; algorithm: string } {
  const attributesPath = path.join(dir, 'signedattrs.der');
  fs.writeFileSync(attributesPath, signedAttributes);
  const printed = openssl(['asn1parse', '-inform', 'DER', '-in', attributesPath]);
  const lines = (printed.stdout + printed.stderr).split('\n');

  const index = lines.findIndex((line) => /:messageDigest$/.test(line.trim()));
  if (index < 0) throw new Error('Malformed CMS token: no messageDigest attribute');
  const value = lines
    .slice(index + 1)
    .map((line) => line.match(/OCTET STRING\s+\[HEX DUMP\]:([0-9A-F]+)/i)?.[1])
    .find((hex) => hex !== undefined);
  if (!value) throw new Error('Malformed CMS token: messageDigest carries no value');

  // The digest algorithm follows from the length: the platform signs ML-DSA with SHA-512.
  const algorithm = { 32: 'sha256', 48: 'sha384', 64: 'sha512' }[value.length / 2];
  if (!algorithm) throw new Error(`Unexpected messageDigest length ${value.length / 2}`);
  return { digest: value.toLowerCase(), algorithm };
}

/**
 * Verifies an ML-DSA timestamp token the way `ts -verify` would, minus the OpenSSL
 * limitation: chain, signature over signedAttrs, and the binding to the returned TSTInfo.
 */
export function verifyMldsaTimestamp(
  responsePath: string,
  caFile: string,
  dir: string,
  options: { untrustedFile?: string } = {},
): VerificationResult {
  const steps: string[] = [];

  const tokenPath = path.join(dir, 'verify-token.der');
  const extract = openssl(['ts', '-reply', '-in', responsePath, '-token_out', '-out', tokenPath]);
  if (extract.exitCode !== 0) {
    return { ok: false, output: `could not extract the token: ${extract.stderr}` };
  }

  const signerPath = tokenSignerCertificate(responsePath, dir);
  if (!signerPath) {
    return { ok: false, output: 'the token embeds no signer certificate' };
  }

  const chainArgs = ['verify', '-CAfile', caFile];
  if (options.untrustedFile) chainArgs.push('-untrusted', options.untrustedFile);
  // -purpose timestampsign is what `ts -verify` requires of the signer.
  chainArgs.push('-purpose', 'timestampsign', signerPath);
  const chain = openssl(chainArgs);
  steps.push(`chain: ${(chain.stdout + chain.stderr).trim()}`);
  if (chain.exitCode !== 0) return { ok: false, output: steps.join('; ') };

  let parts: CmsSignerParts;
  let messageDigest: { digest: string; algorithm: string };
  try {
    parts = parseCmsToken(tokenPath);
    messageDigest = signedMessageDigest(parts.signedAttributes, dir);
  } catch (error) {
    return { ok: false, output: `${steps.join('; ')}; parse: ${String(error)}` };
  }

  const attributesPath = path.join(dir, 'signedattrs.der');
  const signaturePath = path.join(dir, 'signature.bin');
  const publicKeyPath = path.join(dir, 'signer-public.pem');
  fs.writeFileSync(signaturePath, parts.signature);
  const publicKey = openssl(['x509', '-in', signerPath, '-pubkey', '-noout']);
  fs.writeFileSync(publicKeyPath, publicKey.stdout);

  // -rawin is the message-signature interface ML-DSA requires; the digest-then-sign
  // interface PKCS#7 uses is exactly what OpenSSL refuses for ML-DSA.
  const signature = openssl([
    'pkeyutl', '-verify', '-pubin', '-inkey', publicKeyPath,
    '-rawin', '-in', attributesPath, '-sigfile', signaturePath,
  ]);
  const signatureOutput = (signature.stdout + signature.stderr).trim();
  steps.push(`signature: ${signatureOutput}`);
  if (signature.exitCode !== 0 || !/Signature Verified Successfully/i.test(signatureOutput)) {
    return { ok: false, output: steps.join('; ') };
  }

  // Without this the signature would only prove that *some* TSTInfo was signed, not the one
  // in the response being asserted on.
  const actualDigest = createHash(messageDigest.algorithm).update(parts.encapsulatedContent).digest('hex');
  const bound = actualDigest === messageDigest.digest;
  steps.push(`messageDigest(${messageDigest.algorithm}): ${bound ? 'binds the returned TSTInfo' : 'MISMATCH'}`);

  return { ok: bound, output: steps.join('; ') };
}

/** Certificate embedded in the timestamp token (present when the request set certReq). */
export function tokenSignerCertificate(responsePath: string, dir: string): string | null {
  const tokenPath = path.join(dir, 'token.der');
  const extract = openssl(['ts', '-reply', '-in', responsePath, '-token_out', '-out', tokenPath]);
  if (extract.exitCode !== 0 || !fs.existsSync(tokenPath)) return null;

  const certsPath = path.join(dir, 'signer.pem');
  const certs = openssl(['pkcs7', '-inform', 'DER', '-in', tokenPath, '-print_certs', '-out', certsPath]);
  if (certs.exitCode !== 0 || !fs.existsSync(certsPath) || fs.statSync(certsPath).size === 0) return null;
  return certsPath;
}

export function certificateSubject(pemPath: string): string {
  return openssl(['x509', '-in', pemPath, '-noout', '-subject']).stdout.trim();
}

export function certificateSerial(pemPath: string): string {
  const printed = openssl(['x509', '-in', pemPath, '-noout', '-serial']).stdout.trim();
  return normalizeSerial(printed.replace(/^serial=/, ''));
}
