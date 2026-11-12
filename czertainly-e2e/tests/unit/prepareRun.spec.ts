/**
 * Unit tests for what both configs do first (utils/regression/run/prepareRun.ts, utils/envFile.ts):
 * - REG_ENV_FILE (or API_ENV_FILE) set ⇒ the working directory's .env is never read, so a TIER_KIND=local left there
 *   cannot turn a shared run into a "local" one; TIER_KIND / AUTH_MODE / REG_RA_PROFILE_NAME are frozen after the load;
 * - the run id, API_RUN_ID and the switches are set and validated; the run lock is taken in the runner only;
 * - `--workers` / `-j` above 1 is refused; header auth and TIER_KIND=local follow the tier rules (probe injected);
 * - the pin marker REG_ENV_FILE_PINNED counts inside a worker only; the runner removes a stale
 *   local-backend proof of its run id, a worker never does.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { envFileFor, loadDotenv } from '../../utils/envFile';
import { assertSingleWorker, prepareRun, workersFromArgv, resetPinnedEnvFileForTests } from '../../utils/regression/run/prepareRun';
import { runLockFile } from '../../utils/regression/run/runId';
import { isLocalTier } from '../../utils/regression/tier/kind';
import { localProofFile, HttpProbe } from '../../utils/regression/tier/localProof';

// Each test loads its own env file: forget the one the previous test pinned.
test.afterEach(() => resetPinnedEnvFileForTests());

function dirWith(testInfo: { outputPath: (...p: string[]) => string }, files: Record<string, string>): string {
    const dir = testInfo.outputPath('cfg');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    return dir;
}

test('REG_ENV_FILE set + a .env with TIER_KIND=local in the working directory → still a shared tier', ({}, testInfo) => {
    const cwd = dirWith(testInfo, { '.env': 'TIER_KIND=local\nAUTH_MODE=header\nBASE_URL=http://localhost:3000\n', 'tier.env': 'BASE_URL=https://qa.example.com\n' });
    const env: NodeJS.ProcessEnv = { REG_ENV_FILE: path.join(cwd, 'tier.env') };
    expect(loadDotenv(env, cwd)).toBe(path.join(cwd, 'tier.env'));
    expect(env.BASE_URL).toBe('https://qa.example.com');
    expect(env.TIER_KIND, 'the cwd .env was not read').toBeUndefined();
    expect(isLocalTier(env)).toBe(false);
    // Control: without REG_ENV_FILE the cwd .env is the file.
    const plain: NodeJS.ProcessEnv = {};
    loadDotenv(plain, cwd);
    expect(isLocalTier(plain)).toBe(true);
    // API_ENV_FILE is honoured by the REG / API configs only, never by utils/env.ts (the smoke suite).
    expect(envFileFor({ API_ENV_FILE: 'api.env' }, cwd, { allowApiEnvFile: true })).toBe(path.resolve('api.env'));
    expect(envFileFor({ API_ENV_FILE: 'api.env' }, cwd)).toBe(path.join(cwd, '.env'));
    const smoke: NodeJS.ProcessEnv = { API_ENV_FILE: path.join(cwd, 'tier.env') };
    loadDotenv(smoke, cwd);
    expect(smoke.BASE_URL, 'a smoke load ignores API_ENV_FILE and reads the cwd .env').toBe('http://localhost:3000');
});

test('a named env file that does not exist stops prepareRun; a pinned default that does not exist does not', ({}, testInfo) => {
    const cwd = dirWith(testInfo, {});
    const state = testInfo.outputPath('state');
    expect(() => prepareRun({ configDir: cwd, env: { REG_ENV_FILE: path.join(cwd, 'typo.env'), REG_STATE_DIR: state, TEST_WORKER_INDEX: '0' } }))
        .toThrow(/^REG_ENV_FILE names an env file that does not exist/);
    expect(() => prepareRun({ configDir: cwd, env: { API_ENV_FILE: path.join(cwd, 'typo.env'), REG_STATE_DIR: state, TEST_WORKER_INDEX: '0' } }))
        .toThrow(/^API_ENV_FILE names an env file that does not exist/);
    // The default <config dir>/.env may be missing (CI); the pin the first load writes is accepted by a worker's load.
    const env: NodeJS.ProcessEnv = { REG_STATE_DIR: state, TEST_WORKER_INDEX: '0' };
    prepareRun({ configDir: cwd, env });
    expect(env.REG_ENV_FILE).toBe(path.join(cwd, '.env'));
    expect(() => prepareRun({ configDir: cwd, env: { ...env } }), 'a worker sees the pinned, missing default').not.toThrow();
});

// prepareRun pins the env file and freezes TIER_KIND / AUTH_MODE / REG_RA_PROFILE_NAME, so a later load cannot change them
test('prepareRun pins the env file and freezes TIER_KIND, AUTH_MODE and the RA profile name', ({}, testInfo) => {
    const cwd = dirWith(testInfo, { '.env': 'TIER_KIND=local\nAUTH_MODE=header\nREG_RA_PROFILE_NAME=EJBCA RA\n', 'tier.env': 'BASE_URL=https://qa.example.com\n' });
    const env: NodeJS.ProcessEnv = { REG_ENV_FILE: path.join(cwd, 'tier.env'), REG_STATE_DIR: testInfo.outputPath('state'), TEST_WORKER_INDEX: '0' };
    prepareRun({ configDir: cwd, env });
    expect(env).toMatchObject({ TIER_KIND: 'shared', AUTH_MODE: 'local', REG_RA_PROFILE_NAME: '', REG_ENV_FILE: path.join(cwd, 'tier.env') });
    // utils/env.ts in a worker, started in the folder whose .env says TIER_KIND=local: nothing changes.
    loadDotenv(env, cwd);
    delete env.REG_ENV_FILE;
    loadDotenv(env, cwd); // even a load of the cwd .env cannot override what was frozen
    expect(env).toMatchObject({ TIER_KIND: 'shared', AUTH_MODE: 'local', REG_RA_PROFILE_NAME: '' });
});

test('prepareRun sets one run id for both suites and validates the switches', ({}, testInfo) => {
    const cwd = dirWith(testInfo, {});
    const env: NodeJS.ProcessEnv = { REG_STATE_DIR: testInfo.outputPath('state'), TEST_WORKER_INDEX: '0', API_RUN_ID: 'qa-api-adhoc' };
    const id = prepareRun({ configDir: cwd, env });
    expect(env.API_RUN_ID).toBe(id);
    expect(env.API_DELETE_OWN).toBe('1');
    expect(() => prepareRun({ configDir: cwd, env: { REG_STATE_DIR: testInfo.outputPath('s2'), TEST_WORKER_INDEX: '0', API_TEARDOWN_DRY_RUN: 'sure' } }))
        .toThrow(/API_TEARDOWN_DRY_RUN="sure"/);
    expect(() => prepareRun({ configDir: cwd, env: { REG_STATE_DIR: testInfo.outputPath('s3'), TEST_WORKER_INDEX: '0', REG_RUN_ID: 'qa-api-adhoc' } }))
        .toThrow(/adhoc default/);
});

test('the runner takes the run lock and refuses more than one worker; a worker does neither', ({}, testInfo) => {
    const cwd = dirWith(testInfo, {});
    const state = testInfo.outputPath('state');
    const env: NodeJS.ProcessEnv = { REG_STATE_DIR: state };
    const id = prepareRun({ configDir: cwd, env, argv: ['node', 'playwright', 'test', '--list'] });
    expect(fs.readFileSync(runLockFile(id, env), 'utf8').trim()).toBe(String(process.pid));
    fs.rmSync(runLockFile(id, env));
    expect(() => prepareRun({ configDir: cwd, env: { REG_STATE_DIR: state }, argv: ['node', 'playwright', 'test', '--workers=4'] })).toThrow(/exactly one worker/);
    const worker: NodeJS.ProcessEnv = { REG_STATE_DIR: state, TEST_WORKER_INDEX: '0' };
    const wid = prepareRun({ configDir: cwd, env: worker, argv: ['node', 'worker', '-j', '8'] });
    expect(fs.existsSync(runLockFile(wid, worker)), 'workers never take the lock').toBe(false);
});

test('--workers / -j parsing', () => {
    expect(workersFromArgv(['test', '--workers', '3'])).toBe('3');
    expect(workersFromArgv(['test', '--workers=50%'])).toBe('50%');
    expect(workersFromArgv(['test', '-j', '2'])).toBe('2');
    expect(workersFromArgv(['test', '-j4'])).toBe('4');
    expect(workersFromArgv(['test', '--list', '--json'])).toBeUndefined();
    expect(() => assertSingleWorker(['test', '-j', '1'])).not.toThrow();
    expect(() => assertSingleWorker(['test', '--workers=50%'])).toThrow(/exactly one worker/);
});

test('prepareRun: TIER_KIND=local needs the local proof, header auth needs a loopback BASE_URL', ({}, testInfo) => {
    const cwd = dirWith(testInfo, {});
    const base = { REG_STATE_DIR: testInfo.outputPath('state'), TEST_WORKER_INDEX: '0' };
    const up: HttpProbe = () => ({ ok: true, status: 200, body: { app: { version: '1' }, build: { commitId: 'c' } } });
    const down: HttpProbe = () => ({ ok: false, error: 'ECONNREFUSED' });
    const local = { ...base, TIER_KIND: 'local', BASE_URL: 'http://localhost:3000', REG_LOCAL_CORE_URL: 'http://localhost:8280' };
    const containers = () => ({ ok: true });
    // The current docker context is injected (unit tests never run docker).
    const dockerContext = () => ({ host: 'unix:///var/run/docker.sock' });
    expect(() => prepareRun({ configDir: cwd, env: { ...local }, probe: up, containers, dockerContext })).not.toThrow();
    expect(() => prepareRun({ configDir: cwd, env: { ...local }, probe: down, containers, dockerContext })).toThrow(/did not answer/);
    expect(() => prepareRun({ configDir: cwd, env: { ...local }, probe: up, dockerContext, containers: () => ({ ok: false, error: 'no running container publishes the core port' }) }))
        .toThrow(/no container proof/);
    expect(() => prepareRun({ configDir: cwd, env: { ...base, AUTH_MODE: 'header', BASE_URL: 'https://qa.example.com' } })).toThrow(/AUTH_MODE=header/);
});

// REG_ENV_FILE_PINNED is honoured inside a worker only: in the runner a hand-set marker never waives a named file
test('REG_ENV_FILE_PINNED is honoured inside a worker only; in the runner it never waives a file', ({}, testInfo) => {
    const cwd = dirWith(testInfo, {});
    const state = testInfo.outputPath('state');
    const typo = path.join(cwd, 'typo.env');
    expect(() => prepareRun({ configDir: cwd, env: { REG_ENV_FILE: typo, REG_ENV_FILE_PINNED: typo, REG_STATE_DIR: state }, lock: false }), 'the runner')
        .toThrow(/^REG_ENV_FILE names an env file that does not exist/);
    expect(() => prepareRun({ configDir: cwd, env: { REG_ENV_FILE: typo, REG_ENV_FILE_PINNED: typo, REG_STATE_DIR: state, TEST_WORKER_INDEX: '0' } }), 'a worker')
        .not.toThrow();
    // A second load in the same runner process reads the file it pinned itself (the missing default is fine there).
    const env: NodeJS.ProcessEnv = { REG_STATE_DIR: state };
    prepareRun({ configDir: cwd, env, lock: false });
    expect(() => prepareRun({ configDir: cwd, env: { ...env }, lock: false }), 'the same runner process, same pin').not.toThrow();
});

test('the runner removes a stale local-backend proof of its run id; a worker keeps it', ({}, testInfo) => {
    const cwd = dirWith(testInfo, {});
    const state = testInfo.outputPath('state');
    const runId = 'qa-reg-20261014-100000-ab12';
    const env: NodeJS.ProcessEnv = { REG_STATE_DIR: state, REG_RUN_ID: runId, REG_RUN_ID_REUSE: '1', BASE_URL: 'https://qa.example.com' };
    fs.mkdirSync(state, { recursive: true });
    const stale = localProofFile(env);
    fs.writeFileSync(stale, '{}');
    prepareRun({ configDir: cwd, env: { ...env, TEST_WORKER_INDEX: '0' } });
    expect(fs.existsSync(stale), 'a worker leaves it').toBe(true);
    prepareRun({ configDir: cwd, env: { ...env }, lock: false });
    expect(fs.existsSync(stale), 'the runner removes it').toBe(false);
});
