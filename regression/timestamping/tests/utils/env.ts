import * as fs from 'fs';
import * as path from 'path';

export interface NamedUuid {
  name: string;
  uuid: string;
}

export interface TsaSet {
  qualified: boolean;
  /** KeyAlgorithm code of the signing key: `RSA` or `ML-DSA`. */
  keyAlgorithm?: string;
  policyOid: string;
  key: NamedUuid;
  raProfile: NamedUuid;
  certificate: { commonName: string; uuid: string };
  tspProfile: NamedUuid;
  signingProfile: NamedUuid;
}

export const MLDSA = 'ML-DSA';

export function isMldsa(set: TsaSet): boolean {
  return set.keyAlgorithm === MLDSA;
}

export interface Provisioning {
  ilmHost: string;
  connectorHost: string;
  certificateDnPrefix: string;
  connectors: {
    credentialProvider: NamedUuid;
    ejbca: NamedUuid;
    cryptographyProvider: NamedUuid;
    timestampFormatting: NamedUuid;
    vault: NamedUuid;
  };
  credential: NamedUuid;
  authority: NamedUuid;
  token: NamedUuid;
  tokenProfile: NamedUuid;
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
  sets: {
    nonQualified: TsaSet;
    qualified: TsaSet;
    /** Present only when the environment was provisioned with ML-DSA coverage. */
    mldsaNonQualified?: TsaSet;
    mldsaQualified?: TsaSet;
  };
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
    cachedProvisioning = JSON.parse(fs.readFileSync(file, 'utf8')) as Provisioning;
  }
  return cachedProvisioning;
}

/**
 * The provisioned TSA sets, labelled for test titles. The ML-DSA entries are absent on an
 * environment provisioned without them, so specs iterate over what exists rather than
 * failing on a shape they cannot influence.
 */
export function provisionedSets(): Array<{ label: string; set: TsaSet }> {
  const sets = provisioning().sets;
  const candidates: Array<[string, TsaSet | undefined]> = [
    ['non-qualified', sets.nonQualified],
    ['qualified', sets.qualified],
    ['ML-DSA non-qualified', sets.mldsaNonQualified],
    ['ML-DSA qualified', sets.mldsaQualified],
  ];
  return candidates
    .filter((entry): entry is [string, TsaSet] => entry[1] !== undefined)
    .map(([label, set]) => ({ label, set }));
}

export interface TsaFamily {
  /** Signing key algorithm the pair shares, used in test titles. */
  label: string;
  nonQualified: TsaSet;
  qualified: TsaSet;
}

/**
 * The provisioned sets grouped into qualified/non-qualified pairs of one key algorithm.
 *
 * The qualified/non-qualified distinction is a property of a pair: the assertions about it
 * compare two profiles that differ in nothing else, so they have to compare within a family.
 * Comparing an RSA token against an ML-DSA one would conflate the two axes.
 */
export function provisionedFamilies(): TsaFamily[] {
  const sets = provisioning().sets;
  const families: TsaFamily[] = [
    { label: 'RSA', nonQualified: sets.nonQualified, qualified: sets.qualified },
  ];
  if (sets.mldsaNonQualified && sets.mldsaQualified) {
    families.push({
      label: MLDSA,
      nonQualified: sets.mldsaNonQualified,
      qualified: sets.mldsaQualified,
    });
  }
  return families;
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
