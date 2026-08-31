import { execFileSync } from 'child_process';
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
