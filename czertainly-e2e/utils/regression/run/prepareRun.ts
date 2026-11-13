/**
 * prepareRun — `prepareRun()`, the first call of both Playwright configs: loads the env file, freezes TIER_KIND / AUTH_MODE /
 * REG_RA_PROFILE_NAME, sets the run id and its defaults, checks the tier guards. In the runner only: one worker, the run lock.
 * All variables are written before the first test is listed; nothing else in utils/regression writes the environment.
 */
import { loadDotenv } from '../../envFile';
import { parseFlag } from './flags';
import { acquireRunLock, setRunEnvDefaults, releaseRunLock } from './runId';
import { assertAuthModeAllowed, assertLocalAllowed, LocalProofOptions, removeLocalProof } from '../tier/localProof';
import { freezeTierEnv, tierIdentity } from '../tier/kind';
import { settings } from './settings';

export interface PrepareRunOptions extends LocalProofOptions {
    configDir: string;
    env?: NodeJS.ProcessEnv;
    argv?: string[];
    lock?: boolean;
}

export function workersFromArgv(argv: string[]): string | undefined {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--workers' || a === '-j') return argv[i + 1];
        const m = /^(?:--workers=|-j=?)(.+)$/.exec(a);
        if (m) return m[1];
    }
    return undefined;
}

export function assertSingleWorker(argv: string[]): void {
    const w = workersFromArgv(argv);
    if (w !== undefined && w.trim() !== '1') {
        throw new Error(`--workers ${w}: the REG-* / API-* suites run on exactly one worker (run state, ledger and the ` +
            'non-interference snapshot assume it). Drop the option.');
    }
}

let pinnedInThisProcess: string | undefined;

export function resetPinnedEnvFileForTests(): void {
    pinnedInThisProcess = undefined;
}

export function prepareRun(opts: PrepareRunOptions): string {
    const env = opts.env ?? process.env;
    // A worker sees REG_ENV_FILE pinned by the runner, possibly to the missing default: only a file the USER named must exist.
    // The pin counts only inside a worker; the runner recognises its own second load by memory.
    const inWorker = env.TEST_WORKER_INDEX !== undefined;
    const named = settings(env).envFile;
    const pinned = !!named && ((inWorker && env.REG_ENV_FILE_PINNED === named) || pinnedInThisProcess === named);
    env.REG_ENV_FILE = loadDotenv(env, opts.configDir, { allowApiEnvFile: true, requireExplicit: !pinned });
    env.REG_ENV_FILE_PINNED = env.REG_ENV_FILE;
    pinnedInThisProcess = env.REG_ENV_FILE;
    freezeTierEnv(env);
    const runId = setRunEnvDefaults(env);
    parseFlag(settings(env).teardownDryRun, 'API_TEARDOWN_DRY_RUN', false);
    parseFlag(settings(env).keptStrict, 'REG_KEPT_STRICT', false);
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
