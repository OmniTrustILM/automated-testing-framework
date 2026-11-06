/**
 * plant — plants and removes the run's key pairs on the SoftHSM token, the way a tool outside the platform would (a throwaway container).
 * Token objects have no ledger line: removal is keyed by the run prefix and refuses a prefix that could match other runs' labels.
 * A failing plant script is a TierError; a failing removal throws and names the command to finish it by hand.
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

const SHA1_SIZED_ID_BYTES = 20;
const SHORT_ID_BYTES = 8;

const randomId = (bytes: number): string => randomBytes(bytes).toString('hex');

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
    certifiedCertificate: string;
}

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
 * The label prefix of a run's token objects, or why the run id cannot key a removal: only a generated run id is accepted, a shorter one
 * would match every run of that day.
 */
export function runLabelPrefix(runId: string): string | { refused: string } {
    if (!runId) return { refused: 'no run id: an empty prefix would match every label on the token' };
    if (DEFAULT_RUN_IDS.includes(runId)) return { refused: `the run id is an adhoc default (${runId}): its prefix is shared by every adhoc run` };
    if (!RUN_ID_FORMAT.test(runId)) return { refused: `the run id '${runId}' is not a generated run id (qa-reg-<yyyymmdd>-<hhmmss>-<4 base36>): its prefix could match other runs' labels` };
    return `${runId}-`;
}

function manualUnplant(container: string, image: string, prefix: string, environment: Record<string, string>): string {
    // The PIN is never written into a message.
    const shown = Object.keys(environment).filter((k) => k !== 'TOKEN_PIN').map((k) => `${k}='${environment[k]}'`).join(' ');
    return `to finish it by hand, export TOKEN_PIN with the value of KO_TOKEN_PIN and run: ${shown} docker run --rm --user 0 --volumes-from ${container} --entrypoint sh ` +
        `-v ${UNPLANT_SCRIPT}:/unplant-keys.sh:ro ${Object.keys(environment).map((k) => `-e ${k}`).join(' ')} ${image} /unplant-keys.sh ` +
        `(it deletes the private keys, public keys and certificates labelled ${prefix}…)`;
}

export interface UnplantDeps {
    docker?: DockerRunner;
}

/**
 * Removes the run's token objects and returns a short report; where nothing can have been planted it removes nothing and says why. A
 * refused prefix or a failing script throws.
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
