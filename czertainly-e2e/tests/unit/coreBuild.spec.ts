/**
 * Unit tests for coreBuild.ts: /v1/info parsing, the migrated / baseline
 * decision, a failed read that is never cached (the next call reads again), a successful read that is, and the
 * annotation an unreadable marker writes into the (required) testInfo.
 */
import { APIRequestContext, test, expect } from '@playwright/test';
import { BuildInfoStore, decideMigrated, getBuildInfo, isMigratedBuild, parseBuildInfo } from '../../utils/regression/coreBuild';
import { BuildInfo } from '../../utils/regression/ledger/runState';
import { fakeContext } from './helpers/guardRig';

function memoryStore(): BuildInfoStore & { value?: BuildInfo; writes: number } {
    const s = {
        value: undefined as BuildInfo | undefined,
        writes: 0,
        read: () => s.value,
        write: (info: BuildInfo) => {
            s.value = info;
            s.writes++;
        },
    };
    return s;
}

/** A context whose GET /api/v1/info answers from `answers` in order (a thrown Error = network failure). */
function infoApi(answers: Array<{ status: number; body?: unknown } | Error>): { api: APIRequestContext; calls: () => number } {
    let i = 0;
    const api = fakeContext({
        get: async () => {
            const a = answers[Math.min(i++, answers.length - 1)];
            if (a instanceof Error) throw a;
            return { status: () => a.status, ok: () => a.status < 300, json: async () => a.body };
        },
    });
    return { api, calls: () => i };
}

const SB41 = { app: { name: 'core', version: '2.16.0' }, build: { branch: 'integration/spring-boot-4.1', commitId: 'abc' } };
const MAIN = { app: { name: 'core', version: '2.15.0' }, build: { branch: 'main', commitId: 'def' } };

test('parseBuildInfo: branch present = readable marker', () => {
    expect(parseBuildInfo(SB41)).toEqual({ version: '2.16.0', branch: 'integration/spring-boot-4.1', commitId: 'abc', markerReadable: true });
    expect(parseBuildInfo({ app: { version: '1' } }).markerReadable).toBe(false);
    expect(parseBuildInfo(undefined).markerReadable).toBe(false);
});

test('decideMigrated: REG_BUILD wins, then build.branch, else a flagged guess', () => {
    expect(decideMigrated(parseBuildInfo(MAIN), { REG_BUILD: 'sb41' })).toMatchObject({ migrated: true, guessed: false });
    expect(decideMigrated(parseBuildInfo(SB41), { REG_BUILD: 'main' })).toMatchObject({ migrated: false, guessed: false });
    expect(decideMigrated(parseBuildInfo(SB41), {})).toMatchObject({ migrated: true, guessed: false });
    expect(decideMigrated(parseBuildInfo(MAIN), {})).toMatchObject({ migrated: false, guessed: false });
    expect(decideMigrated({ markerReadable: false }, {})).toMatchObject({ migrated: false, guessed: true });
});

test('a failed read is never cached: the next call reads again and caches the success', async () => {
    const store = memoryStore();
    const { api, calls } = infoApi([{ status: 503 }, new Error('ECONNRESET'), { status: 200, body: SB41 }]);
    expect((await getBuildInfo(api, store)).markerReadable).toBe(false);
    expect((await getBuildInfo(api, store)).markerReadable).toBe(false);
    expect(store.writes, 'nothing cached after two failures').toBe(0);
    expect((await getBuildInfo(api, store)).branch).toBe('integration/spring-boot-4.1');
    expect(store.writes).toBe(1);
    await getBuildInfo(api, store);
    expect(calls(), 'the success is cached: no fourth read').toBe(3);
});

test('isMigratedBuild writes the guess into the test annotations', async () => {
    const annotations: Array<{ type: string; description?: string }> = [];
    const { api } = infoApi([{ status: 500 }]);
    const saved = process.env.REG_BUILD;
    delete process.env.REG_BUILD;
    try {
        expect(await isMigratedBuild(api, { annotations }, memoryStore())).toBe(false);
    } finally {
        if (saved !== undefined) process.env.REG_BUILD = saved;
    }
    expect(annotations).toEqual([{ type: 'build-marker', description: expect.stringMatching(/unreadable: treated as baseline/) }]);
});
