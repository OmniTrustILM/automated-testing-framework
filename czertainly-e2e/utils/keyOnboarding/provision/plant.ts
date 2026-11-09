/**
 * plant — plants and removes the run's key pairs on the SoftHSM token: a throwaway container locally, `kubectl exec` into the sidecar
 * on a shared tier. Removal is keyed by the run prefix; while any plant attempt is uncertain the teardown fails closed.
 */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../Logger';
import { DEFAULT_RUN_IDS, RUN_ID_FORMAT, regressionStateDir } from '../../regression/run/runId';
import { scrubSecrets, TierError } from '../../devBlocks/provision/transport';
import { KeyOnboardingConfig, keyOnboardingConfig, plantingMarkerFile } from '../config';
import type { PlantedKeys } from '../types';
import { certificateForPublicKey } from './certify';
import { defaultDockerRunner, DockerRunner, dockerAvailable, scriptRunArgs, sidecarEnvironment, sidecarFacts, sidecarRunning } from './docker';
import { canIAnswer, clusterKubectl, clusterPin, execLineResolvingPod, execScriptIn, KubectlRunner, kubectlAvailable, shellQuote, sidecarPod, theSidecarPod } from './kubectl';

const logger = new Logger('KeyOnboardingSetup');

export const PLANT_SCRIPT = path.join(__dirname, '..', 'plant-keys.sh');
export const UNPLANT_SCRIPT = path.join(__dirname, '..', 'unplant-keys.sh');
export const PLANT_EXEC_SCRIPT = path.join(__dirname, '..', 'plant-keys.exec.sh');
export const UNPLANT_EXEC_SCRIPT = path.join(__dirname, '..', 'unplant-keys.exec.sh');
const UNPLANT_SCRIPT_SHOWN = 'utils/keyOnboarding/unplant-keys.sh';
const UNPLANT_EXEC_SCRIPT_SHOWN = 'utils/keyOnboarding/unplant-keys.exec.sh';

export interface TokenRunners {
    docker?: DockerRunner;
    kubectl?: KubectlRunner;
}

export function dockerOf(runners: TokenRunners, env: NodeJS.ProcessEnv): DockerRunner {
    return runners.docker ?? defaultDockerRunner(env);
}

function kubectlOrTierError(runners: TokenRunners, env: NodeJS.ProcessEnv): KubectlRunner {
    const k = clusterKubectl(runners.kubectl, env);
    if ('reason' in k) throw new TierError(k.reason);
    return k;
}

const tail = (text: string, pin: string | undefined, n = 1500) => scrubSecrets(text, [pin]).trim().slice(-n);
const head = (text: string, pin: string | undefined, n = 300) => scrubSecrets(text, [pin]).slice(0, n);

const SHA1_SIZED_ID_BYTES = 20;
const SHORT_ID_BYTES = 8;

const randomId = (bytes: number): string => randomBytes(bytes).toString('hex');

export function plannedLabels(stamp: string, runId: string): PlantedKeys {
    const label = (role: string) => `${runId}-ko-${role}-${stamp}`;
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
    cfg: KeyOnboardingConfig;
    env: NodeJS.ProcessEnv;
    runners: TokenRunners;
    pin: string;
    stamp: string;
    runId: string;
}

export interface Planting {
    planted: PlantedKeys;
    certifiedCertificate: string;
}

export function labelsOf(planted: PlantedKeys): string[] {
    return [planted.rsa, planted.ec, planted.noIdEc, ...planted.idSharingEc, planted.orphan, planted.removable, ...planted.bulkRemovable, planted.compromised, planted.certified];
}

export interface PlantAttempt {
    stamp: string;
    labels: string[];
    certain: boolean;
}

export interface Marker {
    attempts: PlantAttempt[];
}

const UNKNOWN_ATTEMPT: PlantAttempt = { stamp: '', labels: [], certain: false };

export function readMarker(file: string): Marker | undefined {
    if (!fs.existsSync(file)) return undefined;
    let m: Partial<Marker>;
    try {
        m = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!m || typeof m !== 'object') throw new Error('not an object');
    } catch {
        return { attempts: [UNKNOWN_ATTEMPT] };
    }
    const raw = Array.isArray(m.attempts) ? (m.attempts as unknown[]) : [];
    const attempts = raw.map((a): PlantAttempt => {
        const x = (a ?? {}) as Partial<PlantAttempt>;
        const labels = Array.isArray(x.labels) && x.labels.length > 0 && x.labels.every((l) => typeof l === 'string') ? x.labels : [];
        return { stamp: typeof x.stamp === 'string' ? x.stamp : '', labels, certain: x.certain === true && labels.length > 0 && typeof x.stamp === 'string' && !!x.stamp };
    });
    return { attempts: attempts.length ? attempts : [UNKNOWN_ATTEMPT] };
}

function writeFileAtomic(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
}

function writeMarker(file: string, marker: Marker): void {
    writeFileAtomic(file, `${JSON.stringify({ ...marker, at: new Date().toISOString() })}\n`);
}

/** Appends an UNCERTAIN attempt; nothing is ever dropped or replaced (a known stamp is a TierError before the exec). */
function markAttempt(file: string, attempt: PlantAttempt): void {
    const prior = readMarker(file)?.attempts ?? [];
    if (prior.some((a) => a.stamp === attempt.stamp)) throw new TierError(`a plant attempt with the stamp ${attempt.stamp} is already in the run's planting marker (it is never replaced)`);
    writeMarker(file, { attempts: [...prior, attempt] });
}

function markCertain(file: string, stamp: string): void {
    const marker = fs.existsSync(file) ? readMarker(file) : undefined;
    if (!marker || !marker.attempts.some((a) => a.stamp === stamp)) {
        throw new Error(`the planting marker of attempt ${stamp} is gone (REG_STATE_DIR wiped or changed during the setup): the pairs it planted are not recorded for the teardown`);
    }
    writeMarker(file, { attempts: marker.attempts.map((a) => (a.stamp === stamp && a.labels.length ? { ...a, certain: true } : a)) });
}

/** The CLI never started (nothing was delivered): the attempt it marked is taken back out, the only case that may drop one. */
function unmarkNotStarted(file: string, stamp: string): void {
    const marker = readMarker(file);
    if (!marker) return;
    const attempts = marker.attempts.filter((a) => a.stamp !== stamp);
    if (attempts.length) writeMarker(file, { attempts });
    else fs.rmSync(file, { force: true });
}

export async function plantKeys(input: PlantInput): Promise<Planting> {
    const { cfg, pin } = input;
    const prefix = runLabelPrefix(input.runId);
    if (typeof prefix !== 'string') throw new TierError(`refusing to plant key pairs: ${prefix.refused} (the teardown would refuse to remove them)`);
    const planted = plannedLabels(input.stamp, input.runId);
    const marker = plantingMarkerFile(input.runId, input.env);
    const attempt: PlantAttempt = { stamp: input.stamp, labels: labelsOf(planted), certain: false };
    if (cfg.mode === 'cluster') {
        const kubectl = kubectlOrTierError(input.runners, input.env);
        const environment = { PKCS11_MODULE: cfg.kube.module, ...plantEnvironment(planted, cfg.pkcs11Token, pin) };
        const pod = await theSidecarPod(kubectl, cfg.kube);
        // Right before the exec that delivers the script: from here on a key pair may be on the token.
        markAttempt(marker, attempt);
        const r = await execScriptIn(kubectl, cfg.kube, pod, fs.readFileSync(PLANT_EXEC_SCRIPT, 'utf8'), environment);
        if (r.notStarted) {
            unmarkNotStarted(marker, input.stamp);
            logger.warn(`kubectl did not start: ${tail(r.stderr, pin, 300)}`);
            throw new TierError('kubectl did not start: nothing was planted (the reason is in the setup log)');
        }
        if (r.code !== 0) {
            logger.warn(`plant-keys.exec.sh exited ${r.code}: ${tail(r.stderr, pin)}`);
            throw new TierError(`plant-keys.exec.sh exited ${r.code} (its output is in the setup log)`);
        }
        if (!/^PLANTED$/m.test(r.stdout)) {
            logger.warn(`plant-keys.exec.sh did not report its end: ${head(r.stdout, pin)}`);
            throw new TierError('plant-keys.exec.sh did not report that it planted every pair');
        }
        markCertain(marker, input.stamp);
        return { planted, certifiedCertificate: await certifyPrinted(r.stdout, planted.certified, pin) };
    }
    const docker = dockerOf(input.runners, input.env);
    const facts = await sidecarFacts(docker, cfg.sidecarContainer);
    const environment = { ...sidecarEnvironment(facts), ...plantEnvironment(planted, cfg.pkcs11Token, pin) };
    markAttempt(marker, attempt);
    const r = await docker(scriptRunArgs(cfg.sidecarContainer, facts, PLANT_SCRIPT, '/plant-keys.sh', environment), { env: environment });
    if (r.notStarted) {
        unmarkNotStarted(marker, input.stamp);
        logger.warn(`docker did not start: ${tail(r.stderr, pin, 300)}`);
        throw new TierError('docker did not start: nothing was planted (the reason is in the setup log)');
    }
    if (r.code !== 0) {
        logger.warn(`plant-keys.sh exited ${r.code}: ${tail(r.stderr, pin)}`);
        throw new TierError(`plant-keys.sh exited ${r.code} (its output is in the setup log)`);
    }
    const certifiedCertificate = r.stdout.trim();
    if (!/^[A-Za-z0-9+/]+=*$/.test(certifiedCertificate)) {
        logger.warn(`plant-keys.sh printed no certificate: ${head(r.stdout, pin)}`);
        throw new TierError('plant-keys.sh printed no certificate for the certified pair');
    }
    markCertain(marker, input.stamp);
    return { planted, certifiedCertificate };
}

// The DER header of every P-256 SubjectPublicKeyInfo (91 bytes): found in the dump, so a status line pkcs11-tool prints cannot shift it.
const P256_SPKI_HEADER = '3059301306072a8648ce3d020106082a8648ce3d030107034200';
const P256_SPKI_HEX_LENGTH = 182;

async function certifyPrinted(stdout: string, label: string, pin: string): Promise<string> {
    const dump = /^CERTIFIED_PUBKEY ([0-9a-f]*)$/m.exec(stdout)?.[1] ?? '';
    const at = dump.indexOf(P256_SPKI_HEADER);
    const hex = at >= 0 && at % 2 === 0 ? dump.slice(at, at + P256_SPKI_HEX_LENGTH) : '';
    if (hex.length !== P256_SPKI_HEX_LENGTH) {
        logger.warn(`plant-keys.exec.sh printed no public key for the certified pair: ${head(stdout, pin)}`);
        throw new TierError('plant-keys.exec.sh printed no public key for the certified pair');
    }
    try {
        return await certificateForPublicKey(Buffer.from(hex, 'hex'), label);
    } catch (e) {
        throw new TierError(`the certified pair's public key is no P-256 key the runner can certify (${String(e).slice(0, 120)})`);
    }
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

const VARIABLE_NAME = ['TOKEN', 'PIN'].join('_');
const EXPORT_LINE = `printf "export ${VARIABLE_NAME}='%s'\\n" "$(printf %s "$${VARIABLE_NAME}" | sed "s/'/'\\\\\\\\''/g")"`;

export function manualRemovalFile(runId: string, env: NodeJS.ProcessEnv): string {
    return path.join(regressionStateDir(env), `${runId}.key-onboarding.removal.sh`);
}

function manualCommand(cfg: KeyOnboardingConfig, env: NodeJS.ProcessEnv, prefix: string): string {
    if (cfg.mode === 'cluster') {
        const shown = Object.entries({ PKCS11_MODULE: cfg.kube.module, TOKEN_LABEL: cfg.pkcs11Token, LABEL_PREFIX: prefix }).map(([k, v]) => `export ${k}=${shellQuote(v)};`).join(' ');
        const pin = clusterPin(env);
        // The runner's in-cluster account is not the person's: they name the context of that cluster themselves.
        const guard = 'context' in pin ? '' : `# Planted through the API server ${'server' in pin ? pin.server : '(unknown)'} with the runner pod's service account.\n` +
            ': "${KO_KUBE_CONTEXT:?set KO_KUBE_CONTEXT to your kubectl context of that cluster}"\n';
        const contextFlag = 'context' in pin ? `--context ${shellQuote(pin.context)} ` : '--context "$KO_KUBE_CONTEXT" ';
        return `${guard}{ ${EXPORT_LINE}; echo ${shellQuote(shown)}; cat ${UNPLANT_EXEC_SCRIPT_SHOWN}; } | { ${execLineResolvingPod(cfg.kube, contextFlag)}; }`;
    }
    const environment = { TOKEN_LABEL: cfg.pkcs11Token, LABEL_PREFIX: prefix };
    const shown = Object.entries(environment).map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ');
    const c = shellQuote(cfg.sidecarContainer);
    return `SOFTHSM2_CONF="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${c} | sed -n 's/^SOFTHSM2_CONF=//p')" TOKEN_OWNER="$(docker inspect -f '{{.Config.User}}' ${c} | sed 's/^$/10001/; s/^\\([0-9]*\\)$/\\1:\\1/')" ` +
        `${shown} docker run --rm --user 0 --volumes-from ${c} --entrypoint sh -v "$PWD/${UNPLANT_SCRIPT_SHOWN}":/unplant-keys.sh:ro ` +
        `-e SOFTHSM2_CONF -e TOKEN_OWNER -e TOKEN_LABEL -e TOKEN_PIN -e LABEL_PREFIX "$(docker inspect -f '{{.Config.Image}}' ${c})" /unplant-keys.sh`;
}

function manualRemoval(cfg: KeyOnboardingConfig, env: NodeJS.ProcessEnv, runId: string, prefix: string): string {
    const file = manualRemovalFile(runId, env);
    writeFileAtomic(file, `# Removes the token objects labelled ${prefix}… (private keys, public keys, certificates, secret keys, data objects); nothing else.\n` +
        '# export TOKEN_PIN with the value of KO_TOKEN_PIN first, then run this file with sh from czertainly-e2e.\n' +
        `${manualCommand(cfg, env, prefix)}\n`);
    return `$REG_STATE_DIR/${path.basename(file)} (export TOKEN_PIN with the value of KO_TOKEN_PIN, then run it with sh from czertainly-e2e)`;
}

export interface RemovalBlock {
    reason: string;
    transient: boolean;
}

class BudgetSpent extends Error {}

function budgeted(kubectl: KubectlRunner, left: () => number): KubectlRunner {
    return (args, opts = {}) => {
        const remaining = left();
        if (remaining <= 0) return Promise.reject(new BudgetSpent('the teardown\'s time budget is spent'));
        return kubectl(args, { ...opts, ...(args[0] === 'exec' ? {} : { requestTimeoutMs: remaining }) });
    };
}

export async function removalBlocker(cfg: KeyOnboardingConfig, runners: TokenRunners, env: NodeJS.ProcessEnv, left: () => number = () => Infinity): Promise<RemovalBlock | undefined> {
    if (!cfg.tokenPin) return { reason: 'KO_TOKEN_PIN is not set', transient: false };
    if (cfg.mode === 'cluster') {
        const pinned = clusterKubectl(runners.kubectl, env);
        if ('reason' in pinned) return { reason: pinned.reason, transient: false };
        const kubectl = budgeted(pinned, left);
        if (!(await kubectlAvailable(kubectl))) return { reason: 'kubectl is not available on the runner', transient: false };
        const ns = cfg.kube.namespace;
        for (const [verb, resource] of [['get', 'pods'], ['list', 'pods'], ['create', 'pods/exec'], ['get', 'pods/exec']]) {
            const answer = await canIAnswer(kubectl, verb, resource, ns);
            if (answer === 'no') return { reason: `the runner may not ${verb} ${resource} in the namespace KO_KUBE_NAMESPACE names`, transient: false };
            if (answer === 'unknown') return { reason: `kubectl auth can-i ${verb} ${resource} got no answer from the API server`, transient: true };
        }
        const found = await sidecarPod(kubectl, cfg.kube);
        return 'reason' in found ? { reason: found.reason, transient: true } : undefined;
    }
    const docker = dockerOf(runners, env);
    if (!(await dockerAvailable(docker))) return { reason: 'docker is not available on the runner', transient: false };
    if (!(await sidecarRunning(docker, cfg.sidecarContainer))) return { reason: 'the SoftHSM sidecar container KO_SIDECAR_CONTAINER names is not running', transient: true };
    return undefined;
}

export const BUDGET_MARGIN_MS = 30_000;
const DEFAULT_BUDGET_MS = 400_000;
const MAX_EXEC_MS = 180_000;

export interface UnplantDeps extends TokenRunners {
    deadlineAt?: number;
    retryDelayMs?: number;
    now?: () => number;
}

class TransientRemoval extends Error {}

async function removalPass(cfg: KeyOnboardingConfig, env: NodeJS.ProcessEnv, deps: UnplantDeps, prefix: string, left: () => number): Promise<number> {
    const pin = cfg.tokenPin!;
    let r: { code: number; stdout: string; stderr: string };
    if (cfg.mode === 'cluster') {
        const kubectl = budgeted(kubectlOrTierError(deps, env), left);
        const environment = { PKCS11_MODULE: cfg.kube.module, TOKEN_LABEL: cfg.pkcs11Token, TOKEN_PIN: pin, LABEL_PREFIX: prefix };
        let pod: string;
        try {
            pod = await theSidecarPod(kubectl, cfg.kube);
        } catch (e) {
            if (e instanceof BudgetSpent) throw e;
            throw new TransientRemoval(e instanceof Error ? e.message : String(e));
        }
        const timeoutMs = Math.max(1, Math.min(MAX_EXEC_MS, left()));
        r = await execScriptIn(kubectl, cfg.kube, pod, fs.readFileSync(UNPLANT_EXEC_SCRIPT, 'utf8'), environment, timeoutMs);
    } else {
        const docker = dockerOf(deps, env);
        const facts = await sidecarFacts(docker, cfg.sidecarContainer);
        const environment = { ...sidecarEnvironment(facts), TOKEN_LABEL: cfg.pkcs11Token, TOKEN_PIN: pin, LABEL_PREFIX: prefix };
        r = await docker(scriptRunArgs(cfg.sidecarContainer, facts, UNPLANT_SCRIPT, '/unplant-keys.sh', environment), { env: environment });
    }
    const script = cfg.mode === 'cluster' ? 'unplant-keys.exec.sh' : 'unplant-keys.sh';
    if (r.code !== 0) {
        logger.warn(`${script} exited ${r.code}: ${tail(r.stderr, pin)}`);
        throw new TransientRemoval(`${script} exited ${r.code} (the output is in the log)`);
    }
    const last = r.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!/^\d+$/.test(last)) {
        logger.warn(`${script} printed no count: ${head(r.stdout, pin)}`);
        throw new TransientRemoval(`${script} printed no count, so the removal is not proven`);
    }
    return Number(last);
}

function refusedRunIdLeftover(runId: string): string | undefined {
    const prefix = runLabelPrefix(runId);
    if (typeof prefix === 'string') return undefined;
    return `the run's planting marker exists, but its run id cannot key a removal (${prefix.refused}); no manual command is offered: a person must check the token by hand`;
}

export function plantingMarkerExists(env: NodeJS.ProcessEnv, runId: string): boolean {
    return fs.existsSync(plantingMarkerFile(runId, env));
}

export function plantingLeftover(env: NodeJS.ProcessEnv, runId: string): string | undefined {
    if (!plantingMarkerExists(env, runId)) return undefined;
    const refused = refusedRunIdLeftover(runId);
    if (refused) return refused;
    const prefix = `${runId}-`;
    return `key pairs labelled ${prefix}… may still be on the token; the command that removes them by hand is in ${manualRemoval(keyOnboardingConfig(env), env, runId, prefix)}`;
}

/**
 * Removes the run's token objects (LABEL_PREFIX `<run id>-`). No marker: nothing was planted, the token is not touched. A permanent
 * block fails at once, a transient one is retried within the budget; any uncertain attempt ends RED after the pass (fail closed).
 */
export async function unplantRunKeys(env: NodeJS.ProcessEnv, runId: string, deps: UnplantDeps = {}): Promise<string> {
    const cfg = keyOnboardingConfig(env);
    const markerFile = plantingMarkerFile(runId, env);
    const marker = readMarker(markerFile);
    const prefix = runLabelPrefix(runId);
    if (!marker) {
        return typeof prefix === 'string' ? 'no token objects removed: the run planted nothing (no planting marker)'
            : `no token objects removed: ${prefix.refused} (nothing was planted under it)`;
    }
    if (typeof prefix !== 'string') throw new Error(`refusing to remove token objects: ${refusedRunIdLeftover(runId)}`);
    const manual = () => manualRemoval(cfg, env, runId, prefix);
    const fail = (why: string): Error => new Error(`the run planted key pairs labelled ${prefix}… but they cannot be removed: ${why}; ` +
        `key pairs labelled ${prefix}… may still be on the token; the command that removes them by hand is in ${manual()}`);
    const now = deps.now ?? Date.now;
    const deadlineAt = deps.deadlineAt ?? now() + DEFAULT_BUDGET_MS;
    const delay = deps.retryDelayMs ?? 15_000;
    const left = () => deadlineAt - now();
    let removed: number | undefined;
    for (let tries = 1; removed === undefined; tries++) {
        let why: string;
        try {
            if (left() <= 0) throw new BudgetSpent('the teardown\'s time budget is spent');
            const blocked = await removalBlocker(cfg, deps, env, left);
            if (blocked && !blocked.transient) throw fail(blocked.reason);
            if (blocked) {
                why = blocked.reason;
            } else {
                if (left() <= 0) throw new BudgetSpent('the teardown\'s time budget is spent');
                removed = await removalPass(cfg, env, deps, prefix, left);
                break;
            }
        } catch (e) {
            if (e instanceof BudgetSpent) throw fail(`${e.message} (${tries} tries)`);
            if (!(e instanceof TransientRemoval)) {
                if (e instanceof Error && e.message.startsWith('the run planted key pairs')) throw e;
                throw fail(e instanceof Error ? e.message : String(e));
            }
            why = e.message;
        }
        if (left() <= delay) throw fail(`${why} (still so after ${tries} tries, the teardown's time budget is spent)`);
        logger.warn(`the token objects of this run are not all removed yet (${why}); trying again`);
        await new Promise((r) => setTimeout(r, delay));
    }
    if (marker.attempts.some((a) => !a.certain)) {
        throw new Error(`planting did not finish cleanly (an attempt of the run never reported its end); removed ${removed} of this run's objects; ` +
            `a person must re-check the token later with ${manual()}`);
    }
    // Re-read before going green: a plant attempt added meanwhile may have planted after the pass.
    const now_ = readMarker(markerFile);
    const known = new Set(marker.attempts.map((a) => a.stamp));
    if (!now_ || now_.attempts.some((a) => !a.certain || !known.has(a.stamp))) {
        throw new Error(`the run's planting marker changed during the removal (a plant of the run ran meanwhile, or the marker went); removed ${removed} of this run's objects; ` +
            `a person must re-check the token later with ${manual()}`);
    }
    fs.rmSync(markerFile, { force: true });
    fs.rmSync(manualRemovalFile(runId, env), { force: true });
    return `removed ${removed} token object(s) of this run`;
}
