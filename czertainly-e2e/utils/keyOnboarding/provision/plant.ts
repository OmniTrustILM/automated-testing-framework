/**
 * plant — the key pairs of the run on the SoftHSM token, planted and removed the way a tool outside the platform would.
 *
 * WHAT: `plannedLabels` (every label `<run id>-ko-<role>-<stamp>`), `plantKeys` (runs plant-keys.sh in a throwaway
 * container: the source suite's tests/utils/token.ts, with the same random IDs and the same environment contract) and
 * `unplantRunKeys` (runs unplant-keys.sh: deletes every private key, public key and certificate on the token whose
 * label starts with `<run id>-`, and reports how many). `unplantRunKeys(env, runId)` is the `after` step of the block
 * teardown (utils/devBlocks/blockTeardown.ts), so it runs only once every ILM key of the block is gone.
 * WHY: each run starts from key pairs the inventory has never seen, and ILM keys onboarded under the suggested name
 * (the label) carry the run prefix, so the teardown's live-name check accepts them. The token objects are not platform
 * objects (no ledger line); their removal is keyed by the run prefix alone, and refuses a prefix that could match
 * other runs' labels. The stamp keeps a retried setup attempt from planting a second pair under a label of the first.
 * HOW: both scripts run as root in the sidecar's image with `--volumes-from` the sidecar; every value (the PIN
 * included) goes through the environment as `-e NAME`, never on the command line. A failing script or an output that
 * is not what the script prints is a TierError (the setup becomes `unavailable`; what was planted is removed by the
 * teardown's `after` step).
 */
import { randomBytes } from 'crypto';
import * as path from 'path';
import { Logger } from '../../Logger';
import { isLocalTier } from '../../regression/tier/kind';
import { DEFAULT_RUN_IDS, RUN_ID_FORMAT } from '../../regression/run/runId';
import { runName } from '../../regression/ledger/runState';
import { TierError } from '../../devBlocks/provision/transport';
import { keyOnboardingConfig } from '../config';
import type { PlantedKeys } from '../types';
import { defaultDockerRunner, DockerRunner, scriptRunArgs, sidecarEnvironment, sidecarFacts } from './docker';
import { runnerBlocker } from './preflight';

const logger = new Logger('KeyOnboardingSetup');

export const PLANT_SCRIPT = path.join(__dirname, '..', 'plant-keys.sh');
export const UNPLANT_SCRIPT = path.join(__dirname, '..', 'unplant-keys.sh');

/** A SHA-1 sized ID, as tools outside the platform commonly derive one from the public key. */
const SHA1_SIZED_ID_BYTES = 20;
const SHORT_ID_BYTES = 8;

const randomId = (bytes: number): string => randomBytes(bytes).toString('hex');

/** The labels of one setup attempt: `<run id>-ko-<role>-<stamp>`. */
export function plannedLabels(stamp: string): PlantedKeys {
    const label = (role: string) => runName(`ko-${role}-${stamp}`);
    return {
        rsa: label('rsa'),
        ec: label('ec'),
        noIdEc: label('no-id-ec'),
        idSharingEc: [label('id-sharing-ec-1'), label('id-sharing-ec-2')],
        orphan: label('orphan'),
        removable: label('removable'),
        bulkRemovable: [label('bulk-removable-1'), label('bulk-removable-2')],
        compromised: label('compromised'),
        certified: label('certified'),
    };
}

/** The environment of plant-keys.sh for these labels (the source suite's variables and random IDs). */
export function plantEnvironment(planted: PlantedKeys, tokenLabel: string, pin: string): Record<string, string> {
    return {
        TOKEN_LABEL: tokenLabel,
        TOKEN_PIN: pin,
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
}

export interface PlantInput {
    docker: DockerRunner;
    sidecarContainer: string;
    tokenLabel: string;
    pin: string;
    stamp: string;
}

export interface Planting {
    planted: PlantedKeys;
    /** The certificate carrying the certified pair's public key, base64-encoded DER. */
    certifiedCertificate: string;
}

/** Plants this attempt's key pairs on the sidecar's token (see the file header). */
export async function plantKeys(input: PlantInput): Promise<Planting> {
    const planted = plannedLabels(input.stamp);
    const facts = await sidecarFacts(input.docker, input.sidecarContainer);
    const environment = { ...sidecarEnvironment(facts), ...plantEnvironment(planted, input.tokenLabel, input.pin) };
    const r = await input.docker(scriptRunArgs(input.sidecarContainer, facts, PLANT_SCRIPT, '/plant-keys.sh', environment), { env: environment });
    if (r.code !== 0) {
        logger.warn(`plant-keys.sh exited ${r.code}: ${r.stderr.trim().slice(-1500)}`);
        throw new TierError(`plant-keys.sh exited ${r.code} (its output is in the setup log)`);
    }
    const certifiedCertificate = r.stdout.trim();
    if (!/^[A-Za-z0-9+/]+=*$/.test(certifiedCertificate)) {
        logger.warn(`plant-keys.sh printed no certificate: ${r.stdout.slice(0, 300)}`);
        throw new TierError('plant-keys.sh printed no certificate for the certified pair');
    }
    return { planted, certifiedCertificate };
}

/**
 * The label prefix of a run's token objects, or why the run id cannot key a removal. Only a generated run id
 * (`qa-reg-<yyyymmdd>-<hhmmss>-<4 base36>`, RUN_ID_FORMAT) is accepted: a shorter or hand-set id such as
 * `qa-reg-<yyyymmdd>` would be the prefix of every run of that day. (An API run shares the regression run's id:
 * runTeardown refuses an API_RUN_ID that differs from REG_RUN_ID.) unplant-keys.sh checks the same shape again.
 */
export function runLabelPrefix(runId: string): string | { refused: string } {
    if (!runId) return { refused: 'no run id: an empty prefix would match every label on the token' };
    if (DEFAULT_RUN_IDS.includes(runId)) return { refused: `the run id is an adhoc default (${runId}): its prefix is shared by every adhoc run` };
    if (!RUN_ID_FORMAT.test(runId)) return { refused: `the run id '${runId}' is not a generated run id (qa-reg-<yyyymmdd>-<hhmmss>-<4 base36>): its prefix could match other runs' labels` };
    return `${runId}-`;
}

/** What a person runs to finish a removal the teardown could not: the same container, the same variables. */
function manualUnplant(container: string, image: string, prefix: string, environment: Record<string, string>): string {
    // The PIN is never written into a message: the person exports it from KO_TOKEN_PIN.
    const shown = Object.keys(environment).filter((k) => k !== 'TOKEN_PIN').map((k) => `${k}='${environment[k]}'`).join(' ');
    return `to finish it by hand, export TOKEN_PIN with the value of KO_TOKEN_PIN and run: ${shown} docker run --rm --user 0 --volumes-from ${container} --entrypoint sh ` +
        `-v ${UNPLANT_SCRIPT}:/unplant-keys.sh:ro ${Object.keys(environment).map((k) => `-e ${k}`).join(' ')} ${image} /unplant-keys.sh ` +
        `(it deletes the private keys, public keys and certificates labelled ${prefix}…)`;
}

export interface UnplantDeps {
    docker?: DockerRunner;
}

/**
 * Removes the run's token objects (unplant-keys.sh with LABEL_PREFIX `<run id>-`); returns a short report. On a tier or
 * runner where nothing can have been planted (not a local stack, no PIN, no docker, no sidecar) it removes nothing and
 * says why; a refused prefix or a failing script throws.
 */
export async function unplantRunKeys(env: NodeJS.ProcessEnv, runId: string, deps: UnplantDeps = {}): Promise<string> {
    const prefix = runLabelPrefix(runId);
    if (typeof prefix !== 'string') throw new Error(`refusing to remove token objects: ${prefix.refused}`);
    const cfg = keyOnboardingConfig(env);
    if (!isLocalTier(env)) return 'no token objects removed: not a local stack (the setup plants nothing there)';
    if (!cfg.tokenPin) return 'no token objects removed: KO_TOKEN_PIN is not set (the setup planted nothing)';
    const docker = deps.docker ?? defaultDockerRunner(env);
    const blocked = await runnerBlocker(cfg, docker);
    if (blocked) return `no token objects removed: ${blocked}`;
    const facts = await sidecarFacts(docker, cfg.sidecarContainer);
    const environment = { ...sidecarEnvironment(facts), TOKEN_LABEL: cfg.pkcs11Token, TOKEN_PIN: cfg.tokenPin, LABEL_PREFIX: prefix };
    const r = await docker(scriptRunArgs(cfg.sidecarContainer, facts, UNPLANT_SCRIPT, '/unplant-keys.sh', environment), { env: environment });
    if (r.code !== 0) {
        logger.warn(`unplant-keys.sh exited ${r.code}: ${r.stderr.trim().slice(-1500)}`);
        throw new Error(`unplant-keys.sh exited ${r.code}: the token objects labelled ${prefix}… may still be on the token (the output is in the log); ` +
            manualUnplant(cfg.sidecarContainer, facts.image, prefix, environment));
    }
    const count = r.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!/^\d+$/.test(count)) {
        logger.warn(`unplant-keys.sh printed no count: ${r.stdout.slice(0, 300)}`);
        throw new Error(`unplant-keys.sh printed no count, so the removal of the token objects labelled ${prefix}… is not proven; ${manualUnplant(cfg.sidecarContainer, facts.image, prefix, environment)}`);
    }
    return `removed ${count} token object(s) of this run`;
}
