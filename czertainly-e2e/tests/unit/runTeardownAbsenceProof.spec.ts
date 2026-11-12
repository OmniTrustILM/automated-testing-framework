/**
 * The absence proof after a delete, on the wire: a 404 proves absence; a 5xx proves it only for roles and users
 * (core#2511) and only when their full list is a readable, uncapped list of rows that does not name the object.
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import { absenceOf, assertOwnLive, fullListOf, OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { handlerOf } from '../../utils/regression/teardown/runTeardown';
import { loopbackServer, LoopbackServer } from './helpers/loopbackServer';

const UU = '00000000-0000-4000-8000-000000000003';
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ uuid: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `role ${i}` }));

/** What the fake core answers: the detail status, and the list (status + body, or a dropped connection). */
let detailStatus = 500;
let list: { status: number; body?: unknown } | 'drop' = { status: 200, body: rows(3) };
let core: LoopbackServer;
let api: APIRequestContext;

test.beforeAll(async () => {
    core = await loopbackServer((a) => {
        if (/^\/api\/v1\/(roles|users|groups)\/[^/]+$/.test(a.url)) return { status: detailStatus, body: { name: 'x' } };
        if (list === 'drop') return { status: 502, body: { error: 'bad gateway' } };
        return { status: list.status, body: list.body };
    });
    api = await request.newContext({ baseURL: core.origin });
});

test.afterAll(async () => {
    await api.dispose();
    await core.close();
});

test('the absence table, judged on what the fake core answered', async () => {
    const cases: Array<{ name: string; type: string | undefined; detail: number; list: typeof list; absent: boolean; detailMatch?: RegExp }> = [
        { name: 'roles 500 + list of 999 without the uuid', type: 'roles', detail: 500, list: { status: 200, body: rows(999) }, absent: true },
        { name: 'roles 500 + list at the 1000-row cap', type: 'roles', detail: 500, list: { status: 200, body: rows(1000) }, absent: false, detailMatch: /may be truncated/ },
        { name: 'roles 500 + EMPTY list', type: 'roles', detail: 500, list: { status: 200, body: [] }, absent: false, detailMatch: /empty list/ },
        { name: 'roles 500 + rows without a uuid', type: 'roles', detail: 500, list: { status: 200, body: [{ id: 'a' }, { id: 'b' }] }, absent: false, detailMatch: /without a string uuid/ },
        { name: 'roles 500 + one row with a numeric uuid', type: 'roles', detail: 500, list: { status: 200, body: [...rows(2), { uuid: 7 }] }, absent: false, detailMatch: /without a string uuid/ },
        { name: 'roles 500 + the list names it (upper case)', type: 'roles', detail: 500, list: { status: 200, body: [...rows(2), { uuid: UU.toUpperCase() }] }, absent: false, detailMatch: /still lists it/ },
        { name: 'roles 500 + a paged object instead of a list', type: 'roles', detail: 500, list: { status: 200, body: { data: [] } }, absent: false, detailMatch: /did not answer a list/ },
        { name: 'roles 500 + list 500', type: 'roles', detail: 500, list: { status: 500, body: {} }, absent: false, detailMatch: /answered 500/ },
        { name: 'roles 503 + list without the uuid', type: 'roles', detail: 503, list: { status: 200, body: rows(3) }, absent: true },
        { name: 'roles 502 + list 502 (gateway)', type: 'roles', detail: 502, list: 'drop', absent: false },
        { name: 'roles 200: still there', type: 'roles', detail: 200, list: { status: 200, body: rows(3) }, absent: false, detailMatch: /still finds it/ },
        { name: 'roles 401', type: 'roles', detail: 401, list: { status: 200, body: rows(3) }, absent: false },
        { name: 'roles 404', type: 'roles', detail: 404, list: { status: 200, body: rows(3) }, absent: true },
        { name: 'groups 500: no full list', type: 'groups', detail: 500, list: { status: 200, body: rows(3) }, absent: false, detailMatch: /never proof of absence/ },
        { name: 'type undefined 500', type: undefined, detail: 500, list: { status: 200, body: rows(3) }, absent: false },
        { name: 'users 500 + list without the uuid', type: 'users', detail: 500, list: { status: 200, body: rows(3) }, absent: true },
        { name: "'constructor' 500 (not a type)", type: 'constructor', detail: 500, list: { status: 200, body: rows(3) }, absent: false },
        { name: "'toString' 500 (not a type)", type: 'toString', detail: 500, list: { status: 200, body: rows(3) }, absent: false },
        { name: "'__proto__' 500 (not a type)", type: '__proto__', detail: 500, list: { status: 200, body: rows(3) }, absent: false },
    ];
    const wrong: string[] = [];
    for (const c of cases) {
        detailStatus = c.detail;
        list = c.list;
        core.reset();
        const detailUrl = `/api/v1/${c.type === 'users' ? 'users' : c.type === 'groups' ? 'groups' : 'roles'}/${UU}`;
        const r = await absenceOf(api, c.type, UU, detailUrl);
        if (r.absent !== c.absent) wrong.push(`${c.name}: absent=${r.absent} (${r.detail})`);
        if (c.detailMatch && !c.detailMatch.test(r.detail)) wrong.push(`${c.name}: detail "${r.detail}"`);
        if (r.absent && c.detail !== 404 && r.knownBug?.bug !== 'core#2511') wrong.push(`${c.name}: absent through the list without the known-bug note`);
        // What reached the wire: the detail read, plus the list read only for a 5xx of roles / users.
        const reads = core.arrived.map((a) => `${a.method} ${a.url}`);
        const listRead = c.detail >= 500 && (c.type === 'roles' || c.type === 'users');
        const expected = [`GET ${detailUrl}`, ...(listRead ? [`GET /api/v1/${c.type}`] : [])];
        if (JSON.stringify(reads) !== JSON.stringify(expected)) wrong.push(`${c.name}: wire ${JSON.stringify(reads)}, expected ${JSON.stringify(expected)}`);
    }
    expect(wrong).toEqual([]);
});

// prototype keys are never a type: fullListOf, LIVE_READS and the teardown handler registry use own properties
test('prototype keys are never a type: full lists, live reads and handlers use own properties', async () => {
    expect([fullListOf('roles')?.listUrl, fullListOf('constructor'), fullListOf('__proto__'), fullListOf('toString'), fullListOf(undefined)])
        .toEqual(['/api/v1/roles', undefined, undefined, undefined, undefined]);
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        const lines = [{ at: 'a', runId: 'qa-reg-20261013-120000-ab12', type, name: 'qa-reg-20261013-120000-ab12-x', uuid: UU, spec: 'T', event: 'created' as const }];
        await expect(assertOwnLive(api, type, { uuid: UU }, 'test', { lines, runId: 'qa-reg-20261013-120000-ab12', tier: null }), type)
            .rejects.toThrow(OwnObjectViolation);
        expect(handlerOf(type), type).toBeUndefined();
    }
});
