/**
 * testFixtures — the own-object fixtures `ownRaProfile` and `restrictedUser` of fixtures/testFixtures.ts, run for real
 * with only `env` and `api` replaced (a guarded context to a loopback fake core). When the helper refuses, the test is
 * SKIPPED with the helper's own reason and nothing is created; when it succeeds, the object is created through the
 * guard and recorded in the ledger under the test's ledger id before the test body runs.
 */
import { APIRequestContext, expect, request, TestInfo } from '@playwright/test';
import { ledgerSpecOf, test as fixtures } from '../../fixtures/testFixtures';
import type { TestEnv } from '../../utils/env';
import { guardApi } from '../../utils/regression/guard/createGuard';
import { GuardedApi } from '../../utils/regression/guard/types';
import { secondIdentityBlocker } from '../../utils/regression/rbac/identities';
import { RESTRICTED_USER_NOT_OWN_REASON } from '../../utils/regression/rbac/permissionFixtures';
import { readLedger } from '../../utils/regression/ledger/ledger';
import { runId, updateRunState } from '../../utils/regression/ledger/runState';
import { Arrived, Answer, loopbackServer, LoopbackServer } from './helpers/loopbackServer';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DED = 'qa-dedicated-user';
const ENV_KEYS = ['REG_STATE_DIR', 'BASE_URL', 'TIER_KIND', 'REG_RUN_ID', 'REG_RESTRICTED_USERNAME', 'REG_RESTRICTED_PASSWORD', 'REG_RA_PROFILE_NAME', 'REG_CA_CONNECTORS'];

/** How the fake core answers this test: the users list, and the answer to POST /api/v1/users. */
let users: Array<Record<string, unknown>> = [];
let server: LoopbackServer;
function answer(a: Arrived): Answer {
    const path = a.url.split('?')[0];
    if (a.method === 'GET' && path === '/api/v1/users') return { status: 200, body: users };
    if (a.method === 'POST' && path === '/api/v1/users') return { status: 201, body: { uuid: U(7), username: JSON.parse(a.body).username } };
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
        // The identity checks refuse before the helper is even loaded: not a single request, reads included.
        if (/\[(no|admin) identity\]/.test(testInfo.title)) expect(server.arrived, 'nothing is sent').toEqual([]);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});

/** The process environment of one test: its own state dir (ledger, run state), the fake core as BASE_URL, a shared tier. */
function prepare(testInfo: TestInfo, vars: Record<string, string> = {}): void {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, {
        REG_STATE_DIR: testInfo.outputPath('state'),
        BASE_URL: `${server.origin}/administrator/`,
        TIER_KIND: 'shared',
        REG_RUN_ID: runId(),
        ...vars,
    });
    users = [];
    server.reset();
}

/**
 * An auto fixture, set up before the fixtures under test (fixtures run before beforeEach hooks): the word in brackets in
 * the title picks the situation.
 */
const rows = test.extend<{ setup: void }>({
    setup: [async ({}, use, testInfo) => {
        const ded = { REG_RESTRICTED_USERNAME: DED, REG_RESTRICTED_PASSWORD: 'unused-secret' };
        if (testInfo.title.includes('[no identity]')) prepare(testInfo);
        else if (testInfo.title.includes('[admin identity]')) prepare(testInfo, { ...ded, REG_RESTRICTED_USERNAME: 'Admin' });
        else prepare(testInfo, ded);
        if (testInfo.title.includes('[left behind]')) users = [{ uuid: U(9), username: DED }];
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

expectedSkip.set('restrictedUser [no identity] skips naming the second-identity request', secondIdentityBlocker('admin', {}) ?? '');
rows('restrictedUser [no identity] skips naming the second-identity request', async ({ restrictedUser }) => {
    expect(restrictedUser, 'not reached').toBeUndefined();
});

expectedSkip.set('restrictedUser [admin identity] skips when the second identity is the admin test user', /^REG_RESTRICTED_USERNAME equals the admin test user/);
rows('restrictedUser [admin identity] skips when the second identity is the admin test user', async ({ restrictedUser }) => {
    expect(restrictedUser, 'not reached').toBeUndefined();
});

expectedSkip.set('restrictedUser [left behind] skips when a user of that name exists that this run did not create', RESTRICTED_USER_NOT_OWN_REASON);
rows('restrictedUser [left behind] skips when a user of that name exists that this run did not create', async ({ restrictedUser }) => {
    expect(restrictedUser, 'not reached').toBeUndefined();
});

rows('restrictedUser creates the dedicated user through the guard and records it under the test\'s ledger id first', { annotation: { type: 'ledger-id', description: 'FIX-USER-01' } }, async ({ restrictedUser }) => {
    expect(restrictedUser).toMatchObject({ uuid: U(7), name: DED });
    expect(server.mutations().map((a) => `${a.method} ${a.url}`)).toEqual(['POST /api/v1/users']);
    const lines = readLedger().filter((l) => l.type === 'users' && l.uuid === U(7));
    expect(lines.map((l) => [l.event, l.name, l.spec])).toEqual([['created', DED, 'FIX-USER-01']]);
});

test('ledgerSpecOf: the testMeta id, else the spec file stem without .spec.ts or .api.spec.ts', () => {
    const info = (file: string, id?: string) => ({ file, annotations: id ? [{ type: 'ledger-id', description: id }] : [] });
    expect(ledgerSpecOf(info('/t/tests/api/contract-errors.api.spec.ts'))).toBe('contract-errors');
    expect(ledgerSpecOf(info('C:\\t\\tests\\api\\contract-errors.api.spec.ts'))).toBe('contract-errors');
    expect(ledgerSpecOf(info('/t/tests/regression/REG-AUTH-01-sign-in-and-session.spec.ts'))).toBe('REG-AUTH-01-sign-in-and-session');
    expect(ledgerSpecOf(info('/t/tests/api/contract-errors.api.spec.ts', 'API-GEN-01'))).toBe('API-GEN-01');
});
