import * as fs from 'fs';
import * as path from 'path';

export interface NamedUuid {
  name: string;
  uuid: string;
}

export interface TsaSet {
  qualified: boolean;
  /** KeyAlgorithm code of the signing key, such as `RSA` or `ML-DSA`, taken from its family. */
  keyAlgorithm: string;
  policyOid: string;
  key: NamedUuid;
  raProfile: NamedUuid;
  certificate: { commonName: string; uuid: string };
  tspProfile: NamedUuid;
  signingProfile: NamedUuid;
}

export const RSA = 'RSA';
export const MLDSA = 'ML-DSA';

export function isMldsa(set: TsaSet): boolean {
  return set.keyAlgorithm === MLDSA;
}

/** One named set of the provisioning summary: a qualified/non-qualified pair on one token. */
interface SummarySet {
  cryptoProvider: string;
  connector: NamedUuid;
  token: NamedUuid;
  tokenProfile: NamedUuid;
  keyAlgorithm: string;
  /** The family's name in test titles, added by the matrix runner. */
  label?: string;
  nonQualified: Omit<TsaSet, 'keyAlgorithm'>;
  qualified: Omit<TsaSet, 'keyAlgorithm'>;
}

export interface Provisioning {
  ilmHost: string;
  connectorHost: string;
  connectors: {
    credentialProvider: NamedUuid;
    ejbca: NamedUuid;
    timestampFormatting: NamedUuid;
    vault: NamedUuid;
  };
  credential: NamedUuid;
  authority: NamedUuid;
  vaultInstance: NamedUuid;
  vaultProfile: NamedUuid;
  mappedUser: { username: string; uuid: string };
  role: NamedUuid;
  tspCredential: { username: string; password: string };
  timeQuality: {
    name: string;
    uuid: string;
    accuracy: string;
    ntpServers: string[];
    maxClockDrift: string;
  };
  /** Keyed by set name. */
  sets: Record<string, SummarySet>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set — start the suite through run.sh`);
  }
  return value;
}

export const ilmHost = process.env.ILM_HOST ?? 'http://localhost:8080';
export const runDir = process.env.RUN_DIR ?? path.join(__dirname, '..', '..', 'runs', 'manual');

let cachedProvisioning: Provisioning | undefined;

export function provisioning(): Provisioning {
  if (!cachedProvisioning) {
    const file = required('PROVISIONING_JSON');
    if (!fs.existsSync(file)) {
      throw new Error(`Provisioning summary not found: ${file}`);
    }
    const summary = JSON.parse(fs.readFileSync(file, 'utf8')) as Provisioning;
    requireNamedSets(summary, file);
    cachedProvisioning = summary;
  }
  return cachedProvisioning;
}

/** A summary from a setup script older than development-environment a0c3297 lists one unnamed pair instead. */
function requireNamedSets(summary: Provisioning, file: string): void {
  const entries = Object.entries(summary.sets ?? {});
  if (entries.length === 0) {
    throw new Error(`${file} lists no TSA sets`);
  }
  for (const [name, set] of entries) {
    if (!set?.nonQualified || !set?.qualified || !set?.keyAlgorithm) {
      throw new Error(
        `${file}: '${name}' is not a named TSA set. Re-provision with a timestamping-setup.sh from ` +
          'development-environment a0c3297 or later.',
      );
    }
  }
}

export interface TsaFamily {
  /** The set's name in the provisioning summary. */
  name: string;
  /** The family's name in test titles: the runner's label, or else the key algorithm. */
  label: string;
  connector: NamedUuid;
  nonQualified: TsaSet;
  qualified: TsaSet;
}

/**
 * The provisioned sets as qualified/non-qualified pairs of one key algorithm, in summary order.
 *
 * The qualified/non-qualified distinction is a property of a pair: the assertions about it
 * compare two profiles that differ in nothing else, so they have to compare within a family.
 * Comparing an RSA token against an ML-DSA one would conflate the two axes.
 */
export function provisionedFamilies(): TsaFamily[] {
  return Object.entries(provisioning().sets).map(([name, set]) => ({
    name,
    label: set.label ?? set.keyAlgorithm,
    connector: set.connector,
    nonQualified: { ...set.nonQualified, keyAlgorithm: set.keyAlgorithm },
    qualified: { ...set.qualified, keyAlgorithm: set.keyAlgorithm },
  }));
}

/**
 * Every provisioned TSA set, labelled for test titles. Specs iterate over what exists, so an
 * environment provisioned without a family has fewer tests rather than failures.
 */
export function provisionedSets(): Array<{ label: string; set: TsaSet }> {
  const families = provisionedFamilies();
  const primary = firstRsaFamily(families);
  return families.flatMap((family) => {
    // The primary family's titles stay unprefixed so each test keeps its title, and its history.
    const prefix = family === primary ? '' : `${family.label} `;
    return [
      { label: `${prefix}non-qualified`, set: family.nonQualified },
      { label: `${prefix}qualified`, set: family.qualified },
    ];
  });
}

function firstRsaFamily(families: TsaFamily[]): TsaFamily | undefined {
  return families.find((candidate) => candidate.nonQualified.keyAlgorithm === RSA);
}

/**
 * The first RSA family. The protocol and canary specs exercise the TSP endpoints rather than
 * the signing key, so they run once, on the plainest signer.
 */
export function primaryFamily(): TsaFamily {
  const family = firstRsaFamily(provisionedFamilies());
  if (!family) {
    throw new Error(`${process.env.PROVISIONING_JSON} has no RSA set, which the protocol specs run on`);
  }
  return family;
}

/** The cryptography provider connectors behind the provisioned sets, each once. */
export function cryptographyConnectors(): NamedUuid[] {
  const byUuid = new Map(provisionedFamilies().map((family) => [family.connector.uuid, family.connector]));
  return [...byUuid.values()];
}

export function adminCertificateHeader(): string {
  const pem = fs.readFileSync(required('ADMIN_CERT_PEM'), 'utf8');
  // The file may carry an openssl text dump before the PEM block, so take only what lies
  // between the markers — everything else would corrupt the header and yield a plain 401.
  const match = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!match) {
    throw new Error(`No certificate block found in ${process.env.ADMIN_CERT_PEM}`);
  }
  const body = match[1].replace(/\s+/g, '');
  return body.replace(/\+/g, '%2B').replace(/\//g, '%2F').replace(/=/g, '%3D');
}

// Per-test scratch space kept with the run artifacts, so a failed assertion can be
// re-examined against the exact bytes that produced it.
export function artifactDir(label: string): string {
  const dir = path.join(runDir, 'artifacts', label.replace(/[^A-Za-z0-9._-]+/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const processStart = Date.now();

/**
 * When this run began, as epoch milliseconds. Taken from the runner's manifest so it covers
 * the whole run rather than the moment a particular spec file happened to be loaded; falls
 * back to this process's start when the suite is invoked outside the runner.
 */
export function runStartedAt(): number {
  const manifest = path.join(runDir, 'manifest.json');
  if (fs.existsSync(manifest)) {
    const startedAt = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { startedAt?: string }).startedAt;
    const parsed = startedAt ? Date.parse(startedAt) : NaN;
    if (!Number.isNaN(parsed)) return parsed;
  }
  return processStart;
}
