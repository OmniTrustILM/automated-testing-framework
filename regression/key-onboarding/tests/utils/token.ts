import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { config, PlantedKeys } from './env';

export interface Planting {
  planted: PlantedKeys;
  certifiedCertificate: string;
}

const PLANT_SCRIPT = path.join(__dirname, '..', '..', 'lib', 'plant-keys.sh');

/** Owner of the token files when the sidecar container declares no user. */
const SIDECAR_IMAGE_USER = '10001';

/** A SHA-1 sized ID, as tools outside the platform commonly derive one from the public key. */
const SHA1_SIZED_ID_BYTES = 20;
const SHORT_ID_BYTES = 8;
const SOFTHSM2_CONF_VARIABLE = 'SOFTHSM2_CONF';

function inspect(format: string): string {
  return execFileSync('docker', ['inspect', '-f', format, config.sidecarContainer], { encoding: 'utf8' }).trim();
}

/** The value the sidecar container sets for an environment variable. */
function containerEnvValue(name: string): string | undefined {
  const entry = inspect('{{range .Config.Env}}{{println .}}{{end}}')
    .split('\n')
    .find((line) => line.startsWith(`${name}=`));
  return entry?.slice(name.length + '='.length);
}

/** Docker copies each named variable from its own environment, which keeps TOKEN_PIN off the docker command line. */
function passThroughClientEnvironment(environment: Record<string, string>): { flags: string[]; env: NodeJS.ProcessEnv } {
  return {
    flags: Object.keys(environment).flatMap((name) => ['-e', name]),
    env: { ...process.env, ...environment },
  };
}

/** A container user as `uid:gid`, the form su-exec takes. */
function withGroup(user: string): string {
  return user.includes(':') ? user : `${user}:${user}`;
}

function randomId(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** Plants this run's key pairs on the sidecar's token, under labels unique to this run. */
export function plantKeys(): Planting {
  const prefix = `ko-${Date.now().toString(36)}`;
  const planted: PlantedKeys = {
    rsa: `${prefix}-rsa`,
    ec: `${prefix}-ec`,
    noIdEc: `${prefix}-no-id-ec`,
    idSharingEc: [`${prefix}-id-sharing-ec-1`, `${prefix}-id-sharing-ec-2`],
    orphan: `${prefix}-orphan`,
    removable: `${prefix}-removable`,
    bulkRemovable: [`${prefix}-bulk-removable-1`, `${prefix}-bulk-removable-2`],
    compromised: `${prefix}-compromised`,
    certified: `${prefix}-certified`,
  };
  const image = inspect('{{.Config.Image}}');
  const owner = withGroup(inspect('{{.Config.User}}') || SIDECAR_IMAGE_USER);
  const softhsmConfPath = containerEnvValue(SOFTHSM2_CONF_VARIABLE);
  const environment: Record<string, string> = {
    ...(softhsmConfPath ? { [SOFTHSM2_CONF_VARIABLE]: softhsmConfPath } : {}),
    TOKEN_OWNER: owner,
    TOKEN_LABEL: config.pkcs11Token,
    TOKEN_PIN: config.tokenPin,
    RSA_LABEL: planted.rsa,
    RSA_ID: randomId(SHA1_SIZED_ID_BYTES),
    EC_LABEL: planted.ec,
    EC_ID: randomId(SHORT_ID_BYTES),
    NO_ID_EC_LABEL: planted.noIdEc,
    SHARED_ID: randomId(SHORT_ID_BYTES),
    SHARED_ID_FIRST_LABEL: planted.idSharingEc[0],
    SHARED_ID_SECOND_LABEL: planted.idSharingEc[1],
    ORPHAN_LABEL: planted.orphan,
    ORPHAN_ID: randomId(SHORT_ID_BYTES),
    REMOVABLE_LABEL: planted.removable,
    REMOVABLE_ID: randomId(SHORT_ID_BYTES),
    BULK_REMOVABLE_FIRST_LABEL: planted.bulkRemovable[0],
    BULK_REMOVABLE_FIRST_ID: randomId(SHORT_ID_BYTES),
    BULK_REMOVABLE_SECOND_LABEL: planted.bulkRemovable[1],
    BULK_REMOVABLE_SECOND_ID: randomId(SHORT_ID_BYTES),
    COMPROMISED_LABEL: planted.compromised,
    COMPROMISED_ID: randomId(SHORT_ID_BYTES),
    CERTIFIED_LABEL: planted.certified,
    CERTIFIED_ID: randomId(SHORT_ID_BYTES),
  };
  const passThrough = passThroughClientEnvironment(environment);
  const printed = execFileSync(
    'docker',
    [
      'run', '--rm', '--user', '0', '--volumes-from', config.sidecarContainer,
      '--entrypoint', 'sh',
      '-v', `${PLANT_SCRIPT}:/plant-keys.sh:ro`,
      ...passThrough.flags,
      image, '/plant-keys.sh',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], env: passThrough.env, encoding: 'utf8' },
  );
  const certifiedCertificate = printed.trim();
  if (!/^[A-Za-z0-9+/]+=*$/.test(certifiedCertificate)) {
    throw new Error(`Planting printed no certificate for ${planted.certified}`);
  }
  return { planted, certifiedCertificate };
}
