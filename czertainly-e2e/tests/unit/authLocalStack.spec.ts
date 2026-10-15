/**
 * auth-rbac area (B4) — the core restart of REG-AUTH-05 (now `platformStack.restartCore`, folded at the merge): it runs only on a proven local stack, restarts one named compose
 * service of one named project, and never touches the real docker CLI under the unit tests (a fake docker script inside the
 * test output logs its arguments).
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { restartCore, restartPlan } from '../../utils/regression/platformStack';
import { localProofFile, tierIdentity } from '../../utils/regression/tier';

const RUN = 'qa-reg-20261014-120000-ab12';

function localEnv(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { TIER_KIND: 'local', BASE_URL: 'http://127.0.0.1:8081/administrator/', REG_RUN_ID: RUN, REG_STATE_DIR: dir, ...extra };
}

function writeProof(env: NodeJS.ProcessEnv, at: Date = new Date()): void {
    fs.mkdirSync(env.REG_STATE_DIR!, { recursive: true });
    fs.writeFileSync(localProofFile(env), JSON.stringify({ runId: RUN, tier: tierIdentity(env), at: at.toISOString() }));
}

/** A fake docker (absolute path inside the test output): appends its arguments to a log. */
function fakeDocker(dir: string): { bin: string; calls: () => string[] } {
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, 'docker-calls.log');
    const bin = path.join(dir, 'fake-docker');
    fs.writeFileSync(bin, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n`);
    fs.chmodSync(bin, 0o755);
    return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

test('restartPlan refuses a shared tier, a run without the local-backend proof and a missing compose project; with all three it names the service', ({}, testInfo) => {
    const dir = testInfo.outputPath('state');
    expect(restartPlan({ TIER_KIND: 'shared' })).toEqual({ problem: expect.stringContaining('local stack') });
    const env = localEnv(dir, { REG_LOCAL_COMPOSE_PROJECT: 'ilm' });
    expect(restartPlan(env)).toEqual({ problem: expect.stringContaining('local-backend proof') });
    writeProof(env);
    expect(restartPlan(env)).toEqual({ args: ['compose', '-p', 'ilm', 'restart', 'core'] });
    expect(restartPlan({ ...env, REG_LOCAL_COMPOSE_FILE: '/abs/ilm-compose.yml', REG_LOCAL_SERVICE_CORE: 'core-api' })).toEqual({ args: ['compose', '-f', '/abs/ilm-compose.yml', '-p', 'ilm', 'restart', 'core-api'] });
    const noProject = localEnv(dir);
    writeProof(noProject);
    expect(restartPlan(noProject)).toEqual({ problem: expect.stringContaining('REG_LOCAL_COMPOSE_PROJECT') });
    // An expired proof (older than 6 h) does not unlock it.
    writeProof(env, new Date(Date.now() - 7 * 3600_000));
    expect(restartPlan(env)).toEqual({ problem: expect.stringContaining('local-backend proof') });
});

test('restartCore runs `docker compose -p <project> restart <service>` through REG_DOCKER_BIN once, and nothing when refused; the real docker is never used under the unit tests', ({}, testInfo) => {
    const dir = testInfo.outputPath('state');
    const docker = fakeDocker(testInfo.outputPath('bin'));
    const env = localEnv(dir, { REG_LOCAL_COMPOSE_PROJECT: 'ilm', REG_DOCKER_BIN: docker.bin });
    expect(() => restartCore(env)).toThrow(/local-backend proof/);
    expect(docker.calls()).toEqual([]);
    writeProof(env);
    restartCore(env);
    expect(docker.calls()).toEqual(['compose -p ilm restart core']);
    // Under REG_UNIT_NO_DOCKER only an absolute fake inside the test output may run: `docker` itself is refused.
    expect(process.env.REG_UNIT_NO_DOCKER).toBe('1');
    expect(() => restartCore({ ...env, REG_DOCKER_BIN: 'docker' })).toThrow(/real docker CLI is disabled/);
    expect(() => restartCore({ ...env, REG_DOCKER_BIN: '/usr/local/bin/docker' })).toThrow(/real docker CLI is disabled/);
    expect(docker.calls()).toHaveLength(1);
});
