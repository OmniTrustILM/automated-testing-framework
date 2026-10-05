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

export interface VerificationOptions {
  /** The request the token answers. */
  queryPath?: string;
  /** The timestamped data, hashed afresh in place of the request's imprint. */
  dataPath?: string;
  untrustedFile?: string;
}

/** RSA PKCS#1 v1.5 and ECDSA: the signatures PKCS#7, and so `openssl ts -verify`, can check. */
const PKCS7_SIGNATURE_ALGORITHMS = /^1\.2\.840\.(?:113549\.1\.1\.(?:5|11|12|13|14)|10045\.4\.(?:1|3\.[1-4]))$/;

/**
 * Verifies a token against a trusted chain and binds it to the request or the data. A
 * signature `ts -verify` cannot check, such as RSA-PSS, ML-DSA or SLH-DSA, goes through
 * `cms -verify` instead.
 */
export function verifyTimestamp(
  responsePath: string,
  caFile: string,
  options: VerificationOptions = {},
): VerificationResult {
  const tokenPath = extractToken(responsePath, path.dirname(responsePath));
  if (!tokenPath) return { ok: false, output: 'the response carries no token' };
  let algorithm: string | undefined;
  try {
    algorithm = signerSignature(tokenPath).algorithm;
  } catch {
    // `cms -verify` reports what is wrong with the token.
  }
  return algorithm !== undefined && PKCS7_SIGNATURE_ALGORITHMS.test(algorithm)
    ? verifyWithTs(responsePath, caFile, options)
    : verifyWithCms(responsePath, tokenPath, caFile, options);
}

function verifyWithTs(responsePath: string, caFile: string, options: VerificationOptions): VerificationResult {
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

/**
 * `cms -verify` checks the chain, the signature and that the signed messageDigest covers the
 * returned TSTInfo. The TSTInfo's binding to the request, which `ts -verify` adds, is checked here.
 */
function verifyWithCms(
  responsePath: string,
  tokenPath: string,
  caFile: string,
  options: VerificationOptions,
): VerificationResult {
  const tstInfoPath = path.join(path.dirname(tokenPath), 'tstinfo.der');
  // -purpose timestampsign is what `ts -verify` requires of the signer.
  const args = [
    'cms', '-verify', '-inform', 'DER', '-in', tokenPath, '-CAfile', caFile,
    '-purpose', 'timestampsign', '-binary', '-out', tstInfoPath,
  ];
  if (options.untrustedFile) args.push('-certfile', options.untrustedFile);
  const cms = openssl(args);
  const steps = [`cms -verify: ${cms.exitCode === 0 ? 'OK' : (cms.stdout + cms.stderr).trim()}`];
  if (cms.exitCode !== 0) return { ok: false, output: steps.join('; ') };

  let bindings: Array<{ ok: boolean; output: string }>;
  try {
    bindings = requestBindings(fs.readFileSync(tstInfoPath), responsePath, options);
  } catch (error) {
    return { ok: false, output: `${steps.join('; ')}; parse: ${String(error)}` };
  }
  steps.push(...bindings.map((binding) => binding.output));
  return { ok: bindings.every((binding) => binding.ok), output: steps.join('; ') };
}

/** The checks `ts -verify` makes of the TSTInfo against `-data` or `-queryfile`. */
function requestBindings(
  tstInfo: Buffer,
  responsePath: string,
  options: VerificationOptions,
): Array<{ ok: boolean; output: string }> {
  const token = messageImprint(tstInfo);
  if (options.dataPath) {
    const hashAlgorithm = parseTimestampReply(responsePath).hashAlgorithm ?? '';
    const digest = createHash(hashAlgorithm.toLowerCase()).update(fs.readFileSync(options.dataPath)).digest();
    return [compared(`imprint(${hashAlgorithm})`, 'the data', token.hashedMessage, digest)];
  }
  if (!options.queryPath) return [];

  const request = messageImprint(fs.readFileSync(options.queryPath));
  const bindings = [
    compared('imprint algorithm', 'the request', token.algorithm, request.algorithm),
    compared('imprint', 'the request', token.hashedMessage, request.hashedMessage),
  ];
  const requestNonce = parseTimestampQuery(options.queryPath).nonceHex;
  if (requestNonce) {
    const tokenNonce = parseTimestampReply(responsePath).nonceHex ?? 'none';
    bindings.push({
      ok: tokenNonce === requestNonce,
      output: tokenNonce === requestNonce ? 'nonce: matches the request' : `nonce: MISMATCH (${tokenNonce} != ${requestNonce})`,
    });
  }
  return bindings;
}

function compared(what: string, source: string, actual: Buffer, expected: Buffer): { ok: boolean; output: string } {
  return actual.equals(expected)
    ? { ok: true, output: `${what}: matches ${source}` }
    : { ok: false, output: `${what}: MISMATCH (${actual.toString('hex')} != ${expected.toString('hex')})` };
}

export interface TokenSignature {
  /** The SignerInfo's signatureAlgorithm OID. */
  algorithm: string;
  /** The hash OID of an RSASSA-PSS signature. */
  pssHash?: string;
}

export const RSASSA_PSS = '1.2.840.113549.1.1.10';
const SHA1 = '1.3.14.3.2.26';

/** How the token's signer says it signed, or null for a response without a token. */
export function tokenSignature(responsePath: string): TokenSignature | null {
  const tokenPath = extractToken(responsePath, path.dirname(responsePath));
  return tokenPath ? signerSignature(tokenPath) : null;
}

function signerSignature(tokenPath: string): TokenSignature {
  const der = fs.readFileSync(tokenPath);
  const [, explicitContent] = derChildren(der, readDerNode(der, 0));
  const signedData = readDerNode(der, explicitContent.contentStart);
  // digestAlgorithms is SignedData's first SET and signerInfos its last.
  const signerInfos = derChildren(der, signedData).filter((node) => node.tag === DER_SET).pop();
  if (!signerInfos) throw new Error('the token holds no signerInfos');
  const fields = derChildren(der, derChildren(der, signerInfos)[0]);
  // The signature is SignerInfo's only OCTET STRING, right after its signatureAlgorithm.
  const algorithmIdentifier = fields[fields.findIndex((node) => node.tag === DER_OCTET_STRING) - 1];
  if (algorithmIdentifier?.tag !== DER_SEQUENCE) throw new Error('the SignerInfo holds no signatureAlgorithm');

  const [oid, parameters] = derChildren(der, algorithmIdentifier);
  const algorithm = decodeOid(der, oid);
  if (algorithm !== RSASSA_PSS) return { algorithm };
  const hashAlgorithm = parameters && derChildren(der, parameters).find((node) => node.tag === DER_CONTEXT_0);
  // RFC 4055 makes SHA-1 the hash of PSS parameters that name none.
  if (!hashAlgorithm) return { algorithm, pssHash: SHA1 };
  return { algorithm, pssHash: decodeOid(der, derChildren(der, readDerNode(der, hashAlgorithm.contentStart))[0]) };
}

/** The OID of the key algorithm in a certificate's subjectPublicKeyInfo. */
export function certificateKeyAlgorithm(certificateContent: string): string {
  const der = Buffer.from(certificateContent, 'base64');
  const [tbsCertificate] = derChildren(der, readDerNode(der, 0));
  const fields = derChildren(der, tbsCertificate);
  // The [0] version is optional, so subjectPublicKeyInfo is counted from serialNumber.
  const subjectPublicKeyInfo = fields[fields.findIndex((node) => node.tag === DER_INTEGER) + 5];
  const [algorithmIdentifier] = derChildren(der, subjectPublicKeyInfo);
  return decodeOid(der, derChildren(der, algorithmIdentifier)[0]);
}

function decodeOid(der: Buffer, node: DerNode): string {
  if (node?.tag !== DER_OID) throw new Error('expected an OBJECT IDENTIFIER');
  const arcs: number[] = [];
  let value = 0;
  for (const byte of der.subarray(node.contentStart, node.end)) {
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0;
    }
  }
  const first = Math.min(Math.floor(arcs[0] / 40), 2);
  return [first, arcs[0] - first * 40, ...arcs.slice(1)].join('.');
}

interface DerNode {
  tag: number;
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
  return { tag, start: offset, contentStart, end: contentStart + length };
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

const DER_INTEGER = 0x02;
const DER_OCTET_STRING = 0x04;
const DER_OID = 0x06;
const DER_SEQUENCE = 0x30;
const DER_SET = 0x31;
const DER_CONTEXT_0 = 0xa0;

/**
 * The messageImprint of a TimeStampReq or a TSTInfo, the first SEQUENCE in either. The
 * algorithm is its OID alone, because one side may encode absent parameters as NULL.
 */
function messageImprint(der: Buffer): { algorithm: Buffer; hashedMessage: Buffer } {
  const imprint = derChildren(der, readDerNode(der, 0)).find((node) => node.tag === DER_SEQUENCE);
  const [algorithmIdentifier, hashedMessage] = imprint ? derChildren(der, imprint) : [];
  const oid = algorithmIdentifier?.tag === DER_SEQUENCE ? derChildren(der, algorithmIdentifier)[0] : undefined;
  if (oid?.tag !== DER_OID || hashedMessage?.tag !== DER_OCTET_STRING) {
    throw new Error('malformed messageImprint');
  }
  return {
    algorithm: der.subarray(oid.start, oid.end),
    hashedMessage: der.subarray(hashedMessage.contentStart, hashedMessage.end),
  };
}

function extractToken(responsePath: string, dir: string): string | null {
  const tokenPath = path.join(dir, 'token.der');
  const extract = openssl(['ts', '-reply', '-in', responsePath, '-token_out', '-out', tokenPath]);
  return extract.exitCode === 0 && fs.existsSync(tokenPath) ? tokenPath : null;
}

/** Certificate embedded in the timestamp token (present when the request set certReq). */
export function tokenSignerCertificate(responsePath: string, dir: string): string | null {
  const tokenPath = extractToken(responsePath, dir);
  if (!tokenPath) return null;

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
