/**
 * ownCrud.deleteOwn on the wire: a real Playwright APIRequestContext through the guard to a loopback fake core. An own
 * live object is deleted and recorded; a refused delete is returned (status and body) and recorded nothing; a foreign
 * object or a raw context is refused before anything is sent.
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import { guardApi } from '../../utils/regression/guard/createGuard';
import { GuardedApi } from '../../utils/regression/guard/types';
import { deleteOwn, OWN_DELETE_PATHS } from '../../utils/regression/ownCrud';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { OwnRef, readLedger, recordCreated } from '../../utils/regression/ledger/ledger';
import { runName, runId } from '../../utils/regression/ledger/runState';
import { loopbackServer, LoopbackServer } from './helpers/loopbackServer';

const SPEC = 'ownCrud.spec';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let server: LoopbackServer;
let raw: APIRequestContext;
let api: GuardedApi;
/** path → live object; a DELETE answers `deleteStatus` and removes the object on a 2xx. */
let store: Map<string, Record<string, unknown>>;
let deleteStatus = 204;

const ENV_KEYS = ['REG_STATE_DIR', 'BASE_URL', 'TIER_KIND', 'REG_RUN_ID'];
let saved: Record<string, string | undefined> = {};

test.beforeAll(async () => {
    server = await loopbackServer((a) => {
        const path = a.url.split('?')[0];
        if (a.method === 'GET') return store.has(path) ? { status: 200, body: store.get(path) } : { status: 404, body: { message: 'not found' } };
        if (a.method === 'DELETE') {
            if (deleteStatus < 300) store.delete(path);
            return deleteStatus === 204 ? { status: 204 } : { status: deleteStatus, body: ['Object is still used by a rule'] };
        }
        return { status: 404 };
    });
});
test.afterAll(async () => {
    await server.close();
});
test.beforeEach(async ({}, testInfo) => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.REG_STATE_DIR = testInfo.outputPath('state');
    process.env.BASE_URL = `${server.origin}/administrator/`;
    process.env.TIER_KIND = 'shared';
    process.env.REG_RUN_ID = runId();
    store = new Map();
    deleteStatus = 204;
    server.reset();
    raw = await request.newContext({ baseURL: process.env.BASE_URL, extraHTTPHeaders: { Authorization: 'Bearer SECRET-TOKEN' } });
    api = guardApi(raw);
});
test.afterEach(async () => {
    await api.dispose();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

function ownCondition(n: number): OwnRef {
    const ref = recordCreated('conditions', { uuid: U(n), name: runName(`cond-${n}`) }, SPEC);
    store.set(`${OWN_DELETE_PATHS.conditions}/${ref.uuid}`, { uuid: ref.uuid, name: ref.name });
    return ref;
}
const wire = () => server.mutations().map((a) => `${a.method} ${a.url}`);
const deletedLines = () => readLedger().filter((l) => l.event === 'deleted').map((l) => `${l.type} ${l.uuid}`);

test('an own live object: DELETE through the guard, the answer handed back, then the deleted ledger line', async () => {
    const ref = ownCondition(1);
    const out = await deleteOwn(api, 'conditions', ref, SPEC);
    expect(out).toEqual({ status: 204, body: undefined, text: '' });
    expect(wire()).toEqual([`DELETE /api/v1/workflows/conditions/${ref.uuid}`]);
    expect(deletedLines()).toEqual([`conditions ${ref.uuid}`]);
});

test('a refused delete is a result: status and parsed body returned, nothing recorded', async () => {
    const ref = ownCondition(2);
    deleteStatus = 422;
    const out = await deleteOwn(api, 'conditions', ref, SPEC);
    expect(out.status).toBe(422);
    expect(out.body).toEqual(['Object is still used by a rule']);
    expect(deletedLines()).toEqual([]);
});

test('a foreign object and a raw context are refused before anything is sent', async () => {
    const foreign: OwnRef = { uuid: U(9), name: 'not-this-run', kind: 'own' };
    store.set(`${OWN_DELETE_PATHS.conditions}/${foreign.uuid}`, { uuid: foreign.uuid, name: 'not-this-run' });
    await expect(deleteOwn(api, 'conditions', foreign, SPEC)).rejects.toBeInstanceOf(OwnObjectViolation);
    const ref = ownCondition(3);
    await expect(deleteOwn(raw as unknown as GuardedApi, 'conditions', ref, SPEC)).rejects.toThrow(/deleteOwn conditions/);
    expect(wire()).toEqual([]);
    expect(deletedLines()).toEqual([]);
});
