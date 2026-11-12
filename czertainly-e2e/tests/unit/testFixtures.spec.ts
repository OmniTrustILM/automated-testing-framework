/**
 * testFixtures — the own-object fixture `ownRaProfile` of fixtures/testFixtures.ts, run for real with only `env` and `api`
 * replaced (a guarded context to a loopback fake core). When the helper refuses, the test is SKIPPED with the helper's own
 * reason and nothing is created; when it succeeds, the object is created through the guard and recorded in the ledger under
 * the test's ledger id before the test body runs. (The dedicated second identity's user is not a fixture: its helper
 * `ensureRestrictedUser` is proven in rbacWire.spec.ts, and the `second-identity` need in regressionFixtures.spec.ts.)
 */
import { APIRequestContext, expect, request, TestInfo } from '@playwright/test';
import { ledgerSpecOf, test as fixtures } from '../../fixtures/testFixtures';
import type { TestEnv } from '../../utils/env';
import { guardApi } from '../../utils/regression/guard/createGuard';
import { GuardedApi } from '../../utils/regression/guard/types';
import { runId, updateRunState } from '../../utils/regression/ledger/runState';
import { Arrived, Answer, loopbackServer, LoopbackServer } from './helpers/loopbackServer';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ENV_KEYS = ['REG_STATE_DIR', 'BASE_URL', 'TIER_KIND', 'REG_RUN_ID', 'REG_RA_PROFILE_NAME', 'REG_CA_CONNECTORS'];

let server: LoopbackServer;
function answer(a: Arrived): Answer {
    // Connectors, authorities, RA profiles and custom-attribute definitions: none.
    if (a.method === 'GET') return { status: 200, body: [] };
    return { status: 404, body: { message: 'not in the fake core' } };
}

/** The real fixtures; only the environment and the authenticated context are replaced. */
const test = fixtures.extend<{ raw: APIRequestContext }>({
    env: async ({}, use) => use({ baseUrl: process.env.BASE_URL, authMode: 'local', username: 'admin', password: 'unused' } as TestEnv),
    raw: async ({}, use) => {
        // Only the loopback fake core may receive these requests, whatever BASE_URL the shell exported.
        const host = new URL(process.env.BASE_URL ?? 'http://invalid').hostname;
        if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`testFixtures unit: BASE_URL must point at the loopback fake core, got ${host}`);
        const raw = await request.newContext({ baseURL: process.env.BASE_URL, extraHTTPHeaders: { Authorization: 'Bearer UNIT' } });
        await use(raw);
        await raw.dispose();
    },
    api: async ({ raw }, use) => use(guardApi(raw) as GuardedApi),
});

/** The skip each test must end with (by title); a test without an entry must pass. */
const expectedSkip = new Map<string, string | RegExp>();
let saved: Record<string, string | undefined> = {};

test.beforeAll(async () => {
    server = await loopbackServer(answer);
});
test.afterAll(async () => {
    await server.close();
});
test.afterEach(({}, testInfo: TestInfo) => {
    const want = expectedSkip.get(testInfo.title);
    try {
        if (want === undefined) {
            expect(testInfo.status, 'a fixture that succeeds runs the test').toBe('passed');
            return;
        }
        expect(testInfo.status, 'the fixture skips the test').toBe('skipped');
        const reason = testInfo.annotations.find((a) => a.type === 'skip')?.description ?? '';
        if (typeof want === 'string') expect(reason).toBe(want);
        else expect(reason).toMatch(want);
        expect(server.mutations(), 'a skipped fixture sends no mutation').toEqual([]);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});

/** The process environment of one test: its own state dir (ledger, run state), the fake core as BASE_URL, a shared tier. */
function prepare(testInfo: TestInfo): void {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, {
        REG_STATE_DIR: testInfo.outputPath('state'),
        BASE_URL: `${server.origin}/administrator/`,
        TIER_KIND: 'shared',
        REG_RUN_ID: runId(),
    });
    server.reset();
}

/**
 * An auto fixture, set up before the fixtures under test (fixtures run before beforeEach hooks): the word in brackets in
 * the title picks the situation.
 */
const rows = test.extend<{ setup: void }>({
    setup: [async ({}, use, testInfo) => {
        prepare(testInfo);
        if (testInfo.title.includes('[run state]')) updateRunState({ raProfile: { uuid: U(3), name: `${runId()}-ra`, kind: 'own', authorityUuid: U(4) } });
        await use();
    }, { auto: true }],
});

expectedSkip.set('ownRaProfile skips with the deploy gate when no CA qualifies, and creates nothing', /^deploy gate: no healthy CA .*not registered/);
rows('ownRaProfile skips with the deploy gate when no CA qualifies, and creates nothing', async ({ ownRaProfile }) => {
    expect(ownRaProfile, 'not reached').toBeUndefined();
});

rows('ownRaProfile [run state] hands over the run RA profile of the run state without a request', async ({ ownRaProfile }) => {
    expect(ownRaProfile).toEqual({ uuid: U(3), name: `${runId()}-ra`, kind: 'own', authorityUuid: U(4) });
    expect(server.arrived, 'no request: the run state decides').toEqual([]);
});

test('ledgerSpecOf: the testMeta id, else the spec file stem without .spec.ts or .api.spec.ts', () => {
    const info = (file: string, id?: string) => ({ file, annotations: id ? [{ type: 'ledger-id', description: id }] : [] });
    expect(ledgerSpecOf(info('/t/tests/api/03-contract/errors.api.spec.ts'))).toBe('errors');
    expect(ledgerSpecOf(info('C:\\t\\tests\\api\\03-contract\\errors.api.spec.ts'))).toBe('errors');
    expect(ledgerSpecOf(info('/t/tests/regression/01-sign-in-and-access/01-sign-in-and-session.spec.ts'))).toBe('01-sign-in-and-session');
    expect(ledgerSpecOf(info('/t/tests/api/03-contract/errors.api.spec.ts', 'API-GEN-01'))).toBe('API-GEN-01');
});
