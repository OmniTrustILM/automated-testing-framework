/**
 * prepareRun — `prepareRun()`, the first call of playwright.regression.config.ts and playwright.api.config.ts.
 *
 * In this order:
 * 1. the env file: REG_ENV_FILE, else API_ENV_FILE, else `<config dir>/.env` (envFile.ts); an env file NAMED by
 *    REG_ENV_FILE / API_ENV_FILE that does not exist stops the run (a typo must not turn into a green, empty
 *    run); the default `<config dir>/.env` may be missing (CI). REG_ENV_FILE is then pinned to that file, so every
 *    later load (utils/env.ts in a worker) reads the same file and never the cwd `.env`. The pin marker
 *    REG_ENV_FILE_PINNED is honoured only inside a worker (TEST_WORKER_INDEX set): in the runner a
 *    hand-set marker can never waive the existence check of a named file;
 * 2. freeze TIER_KIND (always set), AUTH_MODE and REG_RA_PROFILE_NAME;
 * 3. the run id and its defaults (runId.ts `setRunEnvDefaults`), and the switches parsed once;
 * 4. the tier guards: positive local proof for TIER_KIND=local (private hosts only, the core's build marker,
 *    a container proof), header auth only on a local BASE_URL, the tier identity REG_TIER_ID;
 * 5. in the runner only (not in a worker, which loads the config again): one worker (`--workers` / `-j` > 1 refused:
 *    run state, ledger and the non-interference snapshot assume a single worker), the run lock, released when
 *    the runner exits, and the removal of a stale local-backend proof of this run id (only the setup of
 *    THIS invocation may write it).
 *
 * Variables written (all before the first test is listed; workers inherit them): REG_ENV_FILE, REG_ENV_FILE_PINNED
 * (here), TIER_KIND, AUTH_MODE, REG_RA_PROFILE_NAME (tier/kind.ts `freezeTierEnv`), REG_RUN_ID, API_RUN_ID, API_DELETE_OWN
 * (runId.ts `setRunEnvDefaults`), REG_TIER_ID (here, runner only) and REG_LOCAL_CORE_MARKER (tier/localProof.ts, the local proof).
 * Nothing else in utils/regression writes the environment.
 */
import { loadDotenv } from '../../envFile';
import { parseFlag } from './flags';
import { acquireRunLock, setRunEnvDefaults, releaseRunLock } from './runId';
import { assertAuthModeAllowed, assertLocalAllowed, LocalProofOptions, removeLocalProof } from '../tier/localProof';
import { freezeTierEnv, tierIdentity } from '../tier/kind';

export interface PrepareRunOptions extends LocalProofOptions {
    /** The config's folder (`__dirname`): its `.env` is the default env file. */
    configDir: string;
    env?: NodeJS.ProcessEnv;
    argv?: string[];
    /** Take the run lock (default: in the runner, i.e. when TEST_WORKER_INDEX is unset). */
    lock?: boolean;
}

/** The `--workers` / `-j` value of a Playwright command line, if any. */
export function workersFromArgv(argv: string[]): string | undefined {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--workers' || a === '-j') return argv[i + 1];
        const m = /^(?:--workers=|-j=?)(.+)$/.exec(a);
        if (m) return m[1];
    }
    return undefined;
}

/** Throws when the command line asks for more than one worker. */
export function assertSingleWorker(argv: string[]): void {
    const w = workersFromArgv(argv);
    if (w !== undefined && w.trim() !== '1') {
        throw new Error(`--workers ${w}: the REG-* / API-* suites run on exactly one worker (run state, ledger and the ` +
            'non-interference snapshot assume it). Drop the option.');
    }
}

/** The env file this process pinned itself (a second config load in the runner reads the same file). */
let pinnedInThisProcess: string | undefined;

/** Forget the env file this process pinned (unit tests that load a config twice with different files). */
export function resetPinnedEnvFileForTests(): void {
    pinnedInThisProcess = undefined;
}

export function prepareRun(opts: PrepareRunOptions): string {
    const env = opts.env ?? process.env;
    // A worker sees REG_ENV_FILE pinned by the runner's load, possibly to the missing default `<config dir>/.env`: only a
    // file the USER named must exist. REG_ENV_FILE_PINNED marks the pin and counts ONLY inside a worker.
    // A second load in the runner process itself is recognised by this module's memory, never by the variable.
    const inWorker = env.TEST_WORKER_INDEX !== undefined;
    const pinned = !!env.REG_ENV_FILE && ((inWorker && env.REG_ENV_FILE_PINNED === env.REG_ENV_FILE) || pinnedInThisProcess === env.REG_ENV_FILE);
    env.REG_ENV_FILE = loadDotenv(env, opts.configDir, { allowApiEnvFile: true, requireExplicit: !pinned });
    env.REG_ENV_FILE_PINNED = env.REG_ENV_FILE;
    pinnedInThisProcess = env.REG_ENV_FILE;
    freezeTierEnv(env);
    const runId = setRunEnvDefaults(env);
    parseFlag(env.API_TEARDOWN_DRY_RUN, 'API_TEARDOWN_DRY_RUN', false);
    parseFlag(env.REG_KEPT_STRICT, 'REG_KEPT_STRICT', false);
    const proof = {
        probe: opts.probe, resolve: opts.resolve, containers: opts.containers, interfaces: opts.interfaces,
        dockerContext: opts.dockerContext, daemonId: opts.daemonId, inContainer: opts.inContainer,
    };
    assertLocalAllowed(env, proof);
    assertAuthModeAllowed(env, proof);
    const inRunner = !inWorker;
    if (inRunner) env.REG_TIER_ID = tierIdentity(env) ?? '';
    if (inRunner) removeLocalProof(env);
    if (inRunner) assertSingleWorker(opts.argv ?? process.argv);
    if (opts.lock ?? inRunner) {
        acquireRunLock(runId, env);
        process.once('exit', () => releaseRunLock(runId, env));
    }
    return runId;
}
