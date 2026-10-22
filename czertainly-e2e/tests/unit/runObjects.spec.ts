/**
 * runObjects — the objects of the `run-setup` project (utils/regression/run/runObjects.ts) against a loopback fake core: the five objects
 * and their order; what a tier without a CA, an MS ADCS authority or a cryptography connector gets (a named reason, nothing created for
 * the object it cannot offer, no throw); that the objects it can make are created through the guard, recorded in the ledger under the
 * setup's id and written to the run state; that a second pass (a reused run id) sends no mutation; and that an unexpected error becomes a
 * named skip, never a failure (a failed dependency would stop the whole regression project).
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { guardApi } from '../../utils/regression/guard/createGuard';
import type { GuardedApi } from '../../utils/regression/guard/types';
import { readLedger, recordCreated } from '../../utils/regression/ledger/ledger';
import { readRunState, runId } from '../../utils/regression/ledger/runState';
import { prepareRunObject, RUN_OBJECT_DEADLINE_MS, RUN_OBJECT_GRACE_MS, RUN_OBJECTS, RUN_SETUP_TEST_TIMEOUT_MS, type RunObject } from '../../utils/regression/run/runObjects';
import { Answer, Arrived, loopbackServer, LoopbackServer } from './helpers/loopbackServer';

const SPEC = 'REG-RUN-01';
const ENV_KEYS = ['REG_STATE_DIR', 'BASE_URL', 'TIER_KIND', 'REG_RUN_ID', 'REG_RA_PROFILE_NAME', 'REG_CA_CONNECTORS', 'REG_ADCS_CONNECTOR'];

let server: LoopbackServer;
let saved: Record<string, string | undefined> = {};
let raw: APIRequestContext;
let api: GuardedApi;
let seq = 7000;
const store = new Map<string, Record<string, unknown>>();
/** When set, `POST /api/v1/roles` answers this status (the unexpected-error case). */
let roleCreateStatus = 200;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A tier with no connector, no authority and no RA profile; custom attributes none; roles and ACME profiles can be created. */
function answer(a: Arrived): Answer {
    const path = a.url.split('?')[0];
    const body = a.body ? (JSON.parse(a.body) as Record<string, unknown>) : undefined;
    if (a.method === 'GET') {
        if (store.has(path)) return { status: 200, body: store.get(path) };
        return /\/(connectors|authorities|raProfiles|resources\/\w+)$/.test(path) ? { status: 200, body: [] } : { status: 404, body: { message: 'not found' } };
    }
    if (a.method === 'POST' && path === '/api/v1/roles') {
        if (roleCreateStatus !== 200) return { status: roleCreateStatus, body: { message: 'boom' } };
        seq += 1;
        store.set(`/api/v1/roles/${U(seq)}`, { uuid: U(seq), name: body?.name });
        return { status: 200, body: { uuid: U(seq) } };
    }
    if (a.method === 'POST' && path === '/api/v1/acmeProfiles') {
        seq += 1;
        store.set(`/api/v1/acmeProfiles/${U(seq)}`, { uuid: U(seq), name: body?.name });
        return { status: 200, body: { uuid: U(seq) } };
    }
    if (a.method === 'PATCH' && /^\/api\/v1\/acmeProfiles\/[0-9a-f-]{36}\/enable$/.test(path)) return { status: 204 };
    return { status: 404, body: { message: `no fake route ${a.method} ${path}` } };
}

test.beforeAll(async () => {
    server = await loopbackServer(answer);
});
test.afterAll(async () => {
    await server.close();
});
test.beforeEach(async ({}, testInfo) => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, {
        REG_STATE_DIR: testInfo.outputPath('state'),
        BASE_URL: `${server.origin}/administrator/`,
        TIER_KIND: 'shared',
        REG_RUN_ID: runId(),
    });
    store.clear();
    roleCreateStatus = 200;
    server.reset();
    raw = await request.newContext({ baseURL: process.env.BASE_URL, extraHTTPHeaders: { Authorization: 'Bearer UNIT' } });
    api = guardApi(raw);
});
test.afterEach(async () => {
    await api.dispose();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

const wire = () => server.mutations().map((a) => `${a.method} ${a.url.split('?')[0]}`.replace(/[0-9a-f-]{36}/, '<uuid>'));
const byRow = (row: string): RunObject => RUN_OBJECTS.find((o) => o.row === row)!;

test('the run objects and their order: authority, RA profile, ACME profile, role, token chain', () => {
    expect(RUN_OBJECTS.map((o) => o.row)).toEqual(['authority', 'raProfile', 'acmeProfile', 'role', 'tokenChain']);
    expect(RUN_OBJECTS.flatMap((o) => o.stateKeys)).toEqual(['authority', 'raProfile', 'acmeProfile', 'role', 'token', 'tokenProfile', 'key']);
    expect(new Set(RUN_OBJECTS.map((o) => o.row)).size, 'the rows are unique (they are the test rows)').toBe(RUN_OBJECTS.length);
});

test('a tier without a CA, an MS ADCS authority or a cryptography connector gets a named reason for each, and no object is created for them', async () => {
    const reasons = new Map<string, string | undefined>();
    for (const object of RUN_OBJECTS) reasons.set(object.row, await prepareRunObject(object, api, SPEC));
    expect(reasons.get('authority')).toMatch(/no connected authority on the MS-ADCS-NG-Connector connector/);
    expect(reasons.get('raProfile')).toMatch(/^deploy gate: no healthy CA with an enabled RA profile to copy/);
    expect(reasons.get('tokenChain')).toMatch(/no connected software cryptography connector of interface v2/);
    expect(reasons.get('acmeProfile'), 'the ACME profile needs no CA').toBeUndefined();
    expect(reasons.get('role'), 'the role needs no CA').toBeUndefined();
    // Only the two objects the tier can offer were created, through the guard, enabled where the helper enables.
    expect(wire()).toEqual(['POST /api/v1/acmeProfiles', 'PATCH /api/v1/acmeProfiles/<uuid>/enable', 'POST /api/v1/roles']);
    expect(readLedger().map((l) => [l.type, l.event, l.spec])).toEqual([['acmeProfiles', 'created', SPEC], ['roles', 'created', SPEC]]);
    const state = readRunState();
    expect(Object.keys(state).filter((k) => k !== 'runId' && k !== 'tier').sort(), 'only what was made reaches the run state').toEqual(['acmeProfile', 'role']);
    expect(state.acmeProfile?.identifier).toBe(`${runId()}.example.test`);
    expect(state.role?.name).toBe(`${runId()}-role`);
    expect(state.raProfile, 'no RA profile without a CA').toBeUndefined();
    expect(state.authority).toBeUndefined();
});

test('a second pass (a reused run id) makes nothing again: the run state answers', async () => {
    for (const object of RUN_OBJECTS) await prepareRunObject(object, api, SPEC);
    server.reset();
    const again = new Map<string, string | undefined>();
    for (const object of RUN_OBJECTS) again.set(object.row, await prepareRunObject(object, api, SPEC));
    expect(wire(), 'no mutation on the second pass').toEqual([]);
    expect(again.get('acmeProfile')).toBeUndefined();
    expect(again.get('role')).toBeUndefined();
    expect(readLedger().filter((l) => l.event === 'created')).toHaveLength(2);
});

test('an unexpected error is a named skip with the start of the error, never a throw; nothing is recorded for the failed create', async () => {
    roleCreateStatus = 500;
    const reason = await prepareRunObject(byRow('role'), api, SPEC);
    expect(reason).toMatch(/^run setup could not make the run role \(POST \/api\/v1\/roles → 500 .*boom.*\); the specs that need it make it themselves$/);
    expect(readLedger()).toEqual([]);
    expect(readRunState().role).toBeUndefined();
    // The message is cut: a long body does not fill a report.
    const long = { ...byRow('role'), async make(): Promise<string | undefined> { throw new Error('x'.repeat(5000)); } };
    expect((await prepareRunObject(long, api, SPEC))!.length).toBeLessThan(400);
    // And an object that is simply ready answers undefined.
    expect(await prepareRunObject({ ...byRow('role'), async make() { return undefined; } }, api, SPEC)).toBeUndefined();
});

test('the authority row asks for the MS ADCS blocker only when the run has no authority and no local issue-only parent', async () => {
    server.reset();
    await prepareRunObject(byRow('authority'), api, SPEC);
    expect(server.arrived.map((a) => a.url.split('?')[0]), 'reads only').toEqual(expect.arrayContaining(['/api/v1/authorities']));
    expect(wire()).toEqual([]);
});

test('an object that does not answer in time is a named skip at the deadline, never a failure or a hang', async () => {
    let finish: (() => void) | undefined;
    const slow: RunObject = { ...byRow('role'), async make() { await new Promise<void>((resolve) => { finish = resolve; }); return undefined; } };
    const started = Date.now();
    const reason = await prepareRunObject(slow, api, SPEC, 80, 50);
    expect(Date.now() - started, 'returned at the deadline, not when the object finished').toBeLessThan(2_000);
    expect(reason).toMatch(/^run setup gave up on the run role after 80 ms \(a connector or the platform did not answer\); the specs that need it make it themselves$/);
    finish?.();
    // A late error of the abandoned attempt is dropped (no unhandled rejection), and a late success changes nothing.
    const lateError: RunObject = { ...byRow('role'), async make(): Promise<string | undefined> { await new Promise((r) => setTimeout(r, 150)); throw new Error('late'); } };
    expect(await prepareRunObject(lateError, api, SPEC, 30, 50)).toMatch(/gave up/);
    await new Promise((r) => setTimeout(r, 250));
    // An object that finishes inside the deadline keeps its own answer, and a synchronous throw is a named skip too.
    expect(await prepareRunObject({ ...byRow('role'), async make() { return 'deploy gate: x'; } }, api, SPEC, 1_000)).toBe('deploy gate: x');
    expect(await prepareRunObject({ ...byRow('role'), make: () => { throw new Error('sync'); } }, api, SPEC, 1_000)).toMatch(/could not make the run role \(sync\)/);
});

test('a late success inside the grace still writes its ledger line; the answer and the run state stay as they were', async () => {
    const state = JSON.stringify(readRunState());
    const late: RunObject = {
        ...byRow('role'),
        async make() {
            await new Promise((r) => setTimeout(r, 80));
            recordCreated('roles', { uuid: U(9001), name: `${runId()}-late` }, { spec: SPEC, note: 'late create' });
            return undefined;
        },
    };
    const reason = await prepareRunObject(late, api, SPEC, 20, 1_000);
    expect(reason).toMatch(/^run setup gave up on the run role after 20 ms /);
    expect(readLedger().map((l) => [l.type, l.event]), 'the late create was recorded before the call returned').toEqual([['roles', 'created']]);
    expect(JSON.stringify(readRunState()), 'the run state is unchanged').toBe(state);
    await new Promise((r) => setTimeout(r, 100));
    expect(await prepareRunObject({ ...byRow('role'), async make() { return 'deploy gate: x'; } }, api, SPEC, 1_000, 0), 'the reason of the next object is its own').toBe('deploy gate: x');
});

test('after the grace nothing more is awaited: a slower create is left behind and the call returns', async () => {
    let finished = false;
    const slow: RunObject = { ...byRow('role'), async make() { await new Promise((r) => setTimeout(r, 600)); finished = true; return undefined; } };
    const started = Date.now();
    const reason = await prepareRunObject(slow, api, SPEC, 20, 60);
    expect(reason).toMatch(/gave up/);
    expect(finished, 'the attempt was not waited for').toBe(false);
    expect(Date.now() - started).toBeLessThan(400);
    await new Promise((r) => setTimeout(r, 700));
});

test('the default deadline and grace fit the limit of the setup test with margin', () => {
    const setup = readFileSync(join(__dirname, '../api/run-objects.setup.ts'), 'utf8');
    expect(setup, 'the setup rows take their limit from the same constant').toContain('test.setTimeout(RUN_SETUP_TEST_TIMEOUT_MS)');
    const projects = readFileSync(join(__dirname, '../../utils/regression/regressionProjects.ts'), 'utf8');
    const projectLimit = Number(/name: 'run-setup'[^}]*timeout: ([\d_]+)/.exec(projects)?.[1].replace(/_/g, ''));
    expect(projectLimit, 'the run-setup project has its own limit').toBeGreaterThan(0);
    expect(RUN_SETUP_TEST_TIMEOUT_MS).toBeLessThanOrEqual(projectLimit);
    expect(RUN_OBJECT_DEADLINE_MS + RUN_OBJECT_GRACE_MS).toBeLessThanOrEqual(RUN_SETUP_TEST_TIMEOUT_MS * 0.8);
});
