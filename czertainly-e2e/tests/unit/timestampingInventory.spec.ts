/**
 * timestampingInventory — the read-only before / after check of the signing profiles, TSP profiles and time-quality
 * configurations (utils/timestamping/inventory.ts).
 *
 * Checks the same tier twice is `same`; a pre-existing row changed, added or gone is `differs`, naming the resource and the
 * counts, never a name; the run's own rows (a `created` ledger line) are left out; every page is read; a tier without the
 * endpoints (404) is a skipped check, a refused identity still fails; no baseline is a skip; the check only reads.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import * as fs from 'fs';
import { guardApiWithSeams } from '../../utils/regression/guard/createGuard';
import { recordCreated } from '../../utils/regression/ledger/ledger';
import { runId } from '../../utils/regression/ledger/runState';
import { clearBaseline, compareBaseline, digestOf, inventoryFile, readBaseline, takeBaseline } from '../../utils/timestamping/inventory';
import { Admin, SetupError } from '../../utils/timestamping/provision/transport';
import { withProcessEnv } from './helpers/guardRig';

type Row = Record<string, unknown>;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Tier {
    'signing profiles': Row[];
    'TSP profiles': Row[];
    'time-quality configurations': Row[];
    /** `POST /path` → a status instead of the list. */
    status?: Record<string, number>;
    pageSize?: number;
}
const PATHS: Record<string, keyof Omit<Tier, 'status' | 'pageSize'>> = {
    '/v1/signingProfiles/list': 'signing profiles', '/v1/tspProfiles/list': 'TSP profiles', '/v1/timeQualityConfigurations/list': 'time-quality configurations',
};
const fresh = (): Tier => ({
    'signing profiles': [{ uuid: U(1), name: 'production-signing', enabled: true, version: 3 }, { uuid: U(2), name: 'other-signing', enabled: false, version: 1 }],
    'TSP profiles': [{ uuid: U(3), name: 'production-tsa', enabled: true }],
    'time-quality configurations': [{ uuid: U(4), name: 'qualified-time-source', ntpServers: ['ntp.example'] }],
});

let dir = '';
const env = (): NodeJS.ProcessEnv => ({ REG_STATE_DIR: dir, REG_RUN_ID: runId(), BASE_URL: 'https://tier.example/' });

function admin(tier: Tier): { admin: Admin; sent: string[] } {
    const sent: string[] = [];
    const answer = (method: string, url: string, data: unknown) => {
        const p = url.replace(/^\/api/, '');
        sent.push(`${method} ${p}`);
        const forced = tier.status?.[`${method} ${p}`];
        const key = PATHS[p];
        const body = (typeof data === 'string' ? JSON.parse(data) : data) as { itemsPerPage?: number; pageNumber?: number } | undefined;
        const size = tier.pageSize ?? 200;
        const all = key ? (tier[key] as Row[]) : [];
        const page = body?.pageNumber ?? 1;
        const out = forced ? { message: 'x' } : { items: all.slice((page - 1) * size, page * size), totalPages: Math.max(1, Math.ceil(all.length / size)), pageNumber: page };
        const status = forced ?? (key && method === 'POST' ? 200 : 404);
        return { status: () => status, ok: () => status < 300, text: async () => JSON.stringify(out), json: async () => out, headers: () => ({}) };
    };
    const raw = {
        get: async (url: string) => answer('GET', url, undefined), head: async () => answer('HEAD', '/', undefined),
        fetch: async (url: string, o: { method?: string; data?: unknown } = {}) => answer((o.method ?? 'GET').toUpperCase(), url, o.data),
        dispose: async () => undefined, storageState: async () => ({ cookies: [], origins: [] }),
    } as unknown as APIRequestContext;
    return { admin: new Admin(guardApiWithSeams(raw, { env: env(), runId: runId(), tier: null })), sent };
}

test.beforeEach(({}, testInfo) => {
    dir = testInfo.outputPath('state');
    fs.mkdirSync(dir, { recursive: true });
});
const inState = <T>(fn: () => Promise<T>): Promise<T> => withProcessEnv({ REG_STATE_DIR: dir, REG_RUN_ID: runId(), BASE_URL: 'https://tier.example/' }, fn);

test('the same tier before and after is the same; the baseline holds counts and hashes, no name; the check only reads', () => inState(async () => {
    const tier = fresh();
    const a = admin(tier);
    const baseline = await takeBaseline(a.admin, env());
    expect(baseline.status).toBe('taken');
    const text = fs.readFileSync(inventoryFile(env()), 'utf8');
    expect(text).not.toMatch(/production|other-signing|qualified-time-source|ntp\.example/);
    expect(JSON.parse(text).resources['signing profiles']).toMatchObject({ count: 2, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(readBaseline(env())).toEqual(baseline);
    const outcome = await compareBaseline(a.admin, env());
    expect(outcome.status).toBe('same');
    expect(a.sent.every((s) => s.startsWith('POST ') && /\/list$/.test(s)), `only list POSTs: ${a.sent.join(', ')}`).toBe(true);
    expect(a.sent).toHaveLength(6);
}));

test('a pre-existing row changed, added or gone makes the teardown see a difference, naming the resource and the counts, never a name', () => inState(async () => {
    for (const [what, change, resource] of [
        ['a signing profile disabled', (t: Tier) => { (t['signing profiles'][0] as Row).enabled = false; }, 'signing profiles'],
        ['a TSP profile added', (t: Tier) => { t['TSP profiles'].push({ uuid: U(30), name: 'somebody-elses-tsa', enabled: true }); }, 'TSP profiles'],
        ['a configuration deleted', (t: Tier) => { t['time-quality configurations'].length = 0; }, 'time-quality configurations'],
        ['a configuration edited', (t: Tier) => { (t['time-quality configurations'][0] as Row).ntpServers = ['elsewhere.example']; }, 'time-quality configurations'],
    ] as const) {
        const tier = fresh();
        const a = admin(tier);
        await takeBaseline(a.admin, env());
        change(tier);
        const outcome = await compareBaseline(a.admin, env());
        expect(outcome.status, what).toBe('differs');
        const text = JSON.stringify(outcome);
        expect(text, what).toContain(resource);
        expect(text, what).toMatch(/before \d+ rows, [0-9a-f]{12}, after \d+ rows, [0-9a-f]{12}|before \d+ rows, [0-9a-f]{12}, after/);
        expect(text, `${what}: no name`).not.toMatch(/production|somebody|qualified-time|elsewhere/);
    }
}));

test('the run\'s own rows are on neither side: created and deleted rows of this run do not matter; a foreign row with the same shape does', () => inState(async () => {
    const tier = fresh();
    const a = admin(tier);
    await takeBaseline(a.admin, env());
    // The block creates a TSP profile (ledger line) and its teardown deletes it again: in between the list holds it.
    recordCreated('tspProfiles', { uuid: U(40), name: `${runId()}-tsp` }, { spec: 'timestamping/setup' });
    tier['TSP profiles'].push({ uuid: U(40), name: `${runId()}-tsp`, enabled: true });
    expect((await compareBaseline(a.admin, env())).status, 'while it exists').toBe('same');
    tier['TSP profiles'].pop();
    expect((await compareBaseline(a.admin, env())).status, 'after its delete').toBe('same');
    tier['TSP profiles'].push({ uuid: U(41), name: `${runId()}-tsp`, enabled: true });
    expect((await compareBaseline(a.admin, env())).status, 'a run-prefixed row without a ledger line is not the run\'s').toBe('differs');
}));

test('every page is read: a change on a later page is seen', () => inState(async () => {
    const tier = fresh();
    tier.pageSize = 1;
    for (let i = 0; i < 4; i++) tier['signing profiles'].push({ uuid: U(50 + i), name: `s${i}`, enabled: true });
    const a = admin(tier);
    await takeBaseline(a.admin, env());
    expect(a.sent.filter((s) => s === 'POST /v1/signingProfiles/list')).toHaveLength(6);
    (tier['signing profiles'][5] as Row).enabled = false;
    expect((await compareBaseline(a.admin, env())).status).toBe('differs');
}));

test('a tier without the endpoints skips with the reason, never fails; a refused identity still fails; no baseline is a skip', () => inState(async () => {
    const missing = admin({ ...fresh(), status: { 'POST /v1/tspProfiles/list': 404 } });
    const baseline = await takeBaseline(missing.admin, env());
    expect(baseline).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/cannot list the TSP profiles: POST \/v1\/tspProfiles\/list answered HTTP 404/) });
    const outcome = await compareBaseline(admin(fresh()).admin, env());
    expect(outcome).toEqual({ status: 'skipped', reason: expect.stringMatching(/^no baseline: the tier cannot list the TSP profiles/) });
    // The endpoint disappears between the two reads: skipped too.
    const tier = fresh();
    await takeBaseline(admin(tier).admin, env());
    expect(await compareBaseline(admin({ ...tier, status: { 'POST /v1/timeQualityConfigurations/list': 500 } }).admin, env())).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/time-quality configurations/) });
    // A refused identity is the run's failure, not a tier verdict.
    await expect(takeBaseline(admin({ ...fresh(), status: { 'POST /v1/signingProfiles/list': 401 } }).admin, env())).rejects.toThrow(SetupError);
    // No baseline file (the setup ended unavailable), or one of an earlier attempt that a retry cleared.
    clearBaseline(env());
    expect(readBaseline(env())).toBeUndefined();
    expect(await compareBaseline(admin(fresh()).admin, env())).toEqual({ status: 'skipped', reason: expect.stringMatching(/^no baseline: the setup took none/) });
}));

test('digestOf: order and key order do not matter, content does', () => {
    const a = digestOf([{ uuid: U(2), b: 1, a: 2 }, { uuid: U(1), x: [1, { z: 1, y: 2 }] }], new Set());
    const b = digestOf([{ uuid: U(1), x: [1, { y: 2, z: 1 }] }, { a: 2, uuid: U(2), b: 1 }], new Set());
    expect(a).toEqual(b);
    expect(digestOf([{ uuid: U(1), x: [1, { y: 2, z: 2 }] }, { uuid: U(2), b: 1, a: 2 }], new Set()).hash).not.toBe(a.hash);
    expect(digestOf([{ uuid: U(1) }, { uuid: U(2) }], new Set([U(2)])).count).toBe(1);
});
