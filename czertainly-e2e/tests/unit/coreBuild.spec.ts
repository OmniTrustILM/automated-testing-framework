/**
 * Unit tests for coreBuild.ts: /v1/info parsing, a failed read that is never cached (the next call reads again) and a
 * successful read that is.
 */
import { APIRequestContext, test, expect } from '@playwright/test';
import { BuildInfoStore, getBuildInfo, parseBuildInfo } from '../../utils/regression/coreBuild';
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

const BUILD = { app: { name: 'core', version: '2.21.0-SNAPSHOT' }, build: { branch: 'main', commitId: 'abc' } };

test('parseBuildInfo reads the version, the branch and the commit', () => {
    expect(parseBuildInfo(BUILD)).toEqual({ version: '2.21.0-SNAPSHOT', branch: 'main', commitId: 'abc' });
    expect(parseBuildInfo({ app: { version: '1' } })).toEqual({ version: '1' });
    expect(parseBuildInfo(undefined)).toEqual({});
});

test('a failed read is never cached: the next call reads again and caches the success', async () => {
    const store = memoryStore();
    const { api, calls } = infoApi([{ status: 503 }, new Error('ECONNRESET'), { status: 200, body: BUILD }]);
    expect(await getBuildInfo(api, store)).toEqual({});
    expect(await getBuildInfo(api, store)).toEqual({});
    expect(store.writes, 'nothing cached after two failures').toBe(0);
    expect((await getBuildInfo(api, store)).branch).toBe('main');
    expect(store.writes).toBe(1);
    await getBuildInfo(api, store);
    expect(calls(), 'the success is cached: no fourth read').toBe(3);
});
