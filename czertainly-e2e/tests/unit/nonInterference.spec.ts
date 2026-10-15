/**
 * Unit tests for API-GEN-33's comparison (compareSnapshots on hand-made snapshots) and for the snapshot reader against
 * a fake API: the newest sample and the oldest window of a newest-first collection, the recheck of a stored object
 * that left them, net accounting with its tolerance (R11), required resources (R9), transient discovery statuses (R12),
 * messages without foreign names (R20), the tier identity (R15) and the purge of old snapshot files.
 */
import { APIRequestContext, test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    canonicalJson, compareSnapshots, isRunNamed, keyMarkOfDetail, keyMarkOfRows, netTolerance, NEWEST_SAMPLE, OLDEST_WINDOW, purgeOldSnapshots, RESOURCES, SNAPSHOT_GAPS,
    snapshotTier, straddlingKeys, TierSnapshot, unreadableRequired,
} from '../../utils/regression/nonInterference';
import { LedgerLine } from '../../utils/regression/regressionRun';

const RUN = 'qa-reg-20261013-120000-ab12';
const T0 = '2026-10-13T12:00:00.000Z';

function snap(resources: TierSnapshot['resources'], extra: Partial<TierSnapshot> = {}): TierSnapshot {
    return { takenAt: T0, runId: RUN, resources, platformEvents: '{}', systemJobs: '[]', ...extra };
}

const before = (): TierSnapshot =>
    snap({
        raProfiles: { total: 3, foreign: { r1: { name: 'Prod RA', marker: 'enabled=true' }, r2: { name: 'Lab RA', marker: 'enabled=false' } } },
        roles: { total: 2, foreign: { o1: { name: 'Administrator' } } },
        keys: { total: 10, foreign: { k1: { name: 'old key', marker: 'active/true,active/true' } }, window: 200 },
    });

const ledgerLine = (over: Partial<LedgerLine>): LedgerLine => ({
    at: '2026-10-13T12:01:00.000Z', runId: RUN, type: 'raProfiles', name: `${RUN}-ra`, uuid: 'own-1', spec: 'T', event: 'created', ...over,
});

test('an untouched tier has no violations', () => {
    expect(compareSnapshots(before(), before(), { tolerance: 0 })).toEqual({ violations: [], notes: [] });
});

test('a pre-existing object that vanished or changed its marker is a violation, named by type and uuid only', () => {
    const after = before();
    delete after.resources.raProfiles.foreign.r2;
    after.resources.raProfiles.total = 2;
    after.resources.raProfiles.foreign.r1.marker = 'enabled=false';
    const { violations } = compareSnapshots(before(), after, { tolerance: 0 });
    expect(violations).toContain('raProfiles: pre-existing r2 is gone');
    expect(violations).toContain('raProfiles: pre-existing r1 changed enabled=true -> enabled=false');
    expect(violations).toContain('raProfiles: total 3 -> 2 (-1), the ledger explains +0');
    expect(violations.join('\n'), 'R20: no foreign names in a violation').not.toMatch(/Lab RA|Prod RA/);
});

test('net accounting: the total changes exactly by own creates minus own deletes since the snapshot', () => {
    const after = before();
    after.resources.raProfiles.total = 4;
    const ledger = [ledgerLine({})];
    expect(compareSnapshots(before(), after, { ledger, tolerance: 0 }).violations).toEqual([]);
    after.resources.raProfiles.total = 5;
    expect(compareSnapshots(before(), after, { ledger, tolerance: 0 }).violations).toEqual(['raProfiles: total 3 -> 5 (+2), the ledger explains +1']);
    after.resources.raProfiles.total = 3;
    expect(compareSnapshots(before(), after, { ledger, tolerance: 0 }).violations, 'one own create but no growth: something else vanished')
        .toEqual(['raProfiles: total 3 -> 3 (+0), the ledger explains +1']);
    const oldLine = [ledgerLine({ at: '2026-10-13T11:00:00.000Z' })];
    after.resources.raProfiles.total = 4;
    expect(compareSnapshots(before(), after, { ledger: oldLine, tolerance: 0 }).violations, 'a line from before the snapshot explains nothing').toHaveLength(1);
    expect(compareSnapshots(before(), after, { ledger: [ledgerLine({ runId: 'qa-reg-other' })], tolerance: 0 }).violations, 'another run explains nothing').toHaveLength(1);
});

test('net accounting catches a foreign delete hidden behind an own create + delete (the old one-sided bounds did not)', () => {
    const after = before();
    // The run created one RA profile and deleted it again, and one foreign RA profile vanished: 3 -> 2.
    after.resources.raProfiles.total = 2;
    after.resources.raProfiles.foreign = { r1: { name: 'Prod RA', marker: 'enabled=true' }, r2: { name: 'Lab RA', marker: 'enabled=false' } };
    const ledger = [ledgerLine({ uuid: 'own-ra' }), ledgerLine({ uuid: 'own-ra', event: 'deleted', at: '2026-10-13T12:30:00.000Z' })];
    expect(compareSnapshots(before(), after, { ledger, tolerance: 0 }).violations).toEqual(['raProfiles: total 3 -> 2 (-1), the ledger explains +0']);
});

test('the stated tolerance absorbs that much unexplained change, and is noted', () => {
    const after = before();
    after.resources.roles.total = 3;
    expect(compareSnapshots(before(), after, { tolerance: 0 }).violations).toHaveLength(1);
    const r = compareSnapshots(before(), after, { tolerance: 1 });
    expect(r.violations).toEqual([]);
    expect(r.notes).toContain('net accounting tolerance: ±1 per resource (REG_NET_TOLERANCE)');
    expect(netTolerance({})).toBe(0);
    expect(netTolerance({ REG_NET_TOLERANCE: '2' })).toBe(2);
    expect(() => netTolerance({ REG_NET_TOLERANCE: 'some' })).toThrow(/non-negative integer/);
});

test('keys: an own key brings one or two items, an own certificate up to one certKey_ item', () => {
    const after = before();
    const ledger = [ledgerLine({ type: 'certificates', uuid: 'c1' }), ledgerLine({ type: 'keys', uuid: 'k-own' })];
    for (const total of [11, 12, 13]) {
        after.resources.keys.total = total;
        expect(compareSnapshots(before(), after, { ledger, tolerance: 0 }).violations, `${total}`).toEqual([]);
    }
    after.resources.keys.total = 14;
    expect(compareSnapshots(before(), after, { ledger, tolerance: 0 }).violations).toEqual(['keys: total 10 -> 14 (+4), the ledger explains 1..+3']);
    after.resources.keys.total = 10;
    expect(compareSnapshots(before(), after, { ledger, tolerance: 0 }).violations, 'an own key brings at least one item').toHaveLength(1);
});

test('after the run-end deletes, own deletions explain a lower total', () => {
    const after = before();
    after.resources.roles.total = 1;
    expect(compareSnapshots(before(), after, { tolerance: 0 }).violations).toEqual(['roles: total 2 -> 1 (-1), the ledger explains +0']);
    expect(compareSnapshots(before(), after, { ownDeleted: [{ type: 'roles', uuid: 'own-r' }], tolerance: 0 }).violations).toEqual([]);
});

test('a missing object that the ledger owns and deleted is a note, not a violation', () => {
    const b = before();
    b.resources.roles.foreign['own-x'] = { name: 'unprefixed but own' };
    const after = before();
    after.resources.roles.total = 1;
    const ledger = [ledgerLine({ type: 'roles', uuid: 'own-x', at: '2026-10-13T11:00:00.000Z' }), ledgerLine({ type: 'roles', uuid: 'own-x', event: 'deleted' })];
    const r = compareSnapshots(b, after, { ledger, tolerance: 0 });
    expect(r.violations).toEqual([]);
    expect(r.notes[0]).toBe('roles: own-x is a ledger object of this run, deleted by it');
});

test('platform event associations and system jobs must be identical', () => {
    const after = before();
    after.platformEvents = canonicalJson({ certificate_status_changed: ['t1'] });
    after.systemJobs = canonicalJson([{ uuid: 'j1', enabled: false }]);
    expect(compareSnapshots(before(), after, { tolerance: 0 }).violations).toEqual(['platform event associations changed', 'system jobs changed (uuid, name, type, cron, enabled, one-time)']);
});

test('unreadable before: a required resource is a violation (R9), an optional one a note; unreadable after: violation', () => {
    const b = before();
    b.resources.roles = { total: -1, foreign: {}, error: 'GET /api/v1/roles answered 403' };
    b.resources.triggers = { total: -1, foreign: {}, error: 'GET /api/v1/workflows/triggers answered 403' };
    const r = compareSnapshots(b, before(), { tolerance: 0 });
    expect(r.violations).toEqual(['roles: required resource unreadable before the run, the proof is incomplete (GET /api/v1/roles answered 403)']);
    expect(r.notes).toEqual(['triggers: not compared (before snapshot unreadable: GET /api/v1/workflows/triggers answered 403)']);
    expect(unreadableRequired(b)).toEqual(expect.arrayContaining(['roles', 'certificates']));
    const after = before();
    after.resources.roles = { total: -1, foreign: {}, error: 'answered 500' };
    expect(compareSnapshots(before(), after, { tolerance: 0 }).violations).toEqual(['roles: readable before the run, unreadable after (answered 500)']);
});

test('snapshots of different tiers are never compared as equal (R15)', () => {
    expect(compareSnapshots(before(), { ...before(), tier: 'bbbbbbbbbbbb' }, { tolerance: 0 }).violations).toEqual([]);
    expect(compareSnapshots({ ...before(), tier: 'aaaaaaaaaaaa' }, { ...before(), tier: 'bbbbbbbbbbbb' }, { tolerance: 0 }).violations)
        .toEqual(['the snapshots were taken on different tiers (tier identity differs)']);
});

test('the snapshot covers the R11 resource types, and names its gaps', () => {
    const types = RESOURCES.map((r) => r.type);
    for (const t of ['credentials', 'connectors', 'customAttributes', 'rules', 'conditions', 'actions', 'executions', 'triggers',
        'notificationProfiles', 'notificationInstances', 'entities', 'locations', 'secrets', 'vaultProfiles', 'vaultInstances']) {
        expect(types, t).toContain(t);
    }
    expect(Object.keys(SNAPSHOT_GAPS)).toEqual(expect.arrayContaining(['acmeAccounts', 'approvals', 'savedViews', 'oidEntries']));
});

test('transient discovery statuses are not compared (R12), terminal ones are', () => {
    const disc = RESOURCES.find((r) => r.type === 'discoveries')!;
    expect(disc.marker!({ status: 'inProgress' })).toBeUndefined();
    expect(disc.marker!({ status: 'processing' })).toBeUndefined();
    expect(disc.marker!({ status: 'completed' })).toBe('completed');
    const b = snap({ discoveries: { total: 1, foreign: { d1: { name: 'nightly', marker: undefined } } } });
    const a = snap({ discoveries: { total: 1, foreign: { d1: { name: 'nightly', marker: 'completed' } } } });
    expect(compareSnapshots(b, a, { tolerance: 0 }).violations, 'inProgress before, completed after: not ours').toEqual([]);
});

test('snapshot files older than 14 days are purged, newer ones and other files stay', ({}, testInfo) => {
    const dir = testInfo.outputPath('state');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.parse('2026-10-13T12:00:00Z');
    const write = (name: string, ageDays: number) => {
        const f = path.join(dir, name);
        fs.writeFileSync(f, '{}');
        const t = new Date(now - ageDays * 86_400_000);
        fs.utimesSync(f, t, t);
    };
    write('qa-reg-20260901-000000-aaaa.snapshot-before.json', 20);
    write('qa-reg-20261010-000000-bbbb.snapshot-before.json', 3);
    write('created-objects.jsonl', 30);
    expect(purgeOldSnapshots(dir, now)).toEqual(['qa-reg-20260901-000000-aaaa.snapshot-before.json']);
    expect(fs.readdirSync(dir).sort()).toEqual(['created-objects.jsonl', 'qa-reg-20261010-000000-bbbb.snapshot-before.json']);
});

test('canonical JSON ignores key order and the order of string lists', () => {
    expect(canonicalJson({ b: ['y', 'x'], a: 1 })).toBe(canonicalJson({ a: 1, b: ['x', 'y'] }));
    expect(canonicalJson([{ a: 1 }, { a: 2 }])).not.toBe(canonicalJson([{ a: 2 }, { a: 1 }]));
});

/** Fake API: certificate search answers pages of a newest-first list; detail GETs answer from `details`. */
function fakeApi(certs: Array<{ uuid: string; commonName: string; state: string }>, details: Record<string, number>): { api: APIRequestContext; requests: string[] } {
    const requests: string[] = [];
    const reply = (status: number, body: unknown) => ({ status: () => status, text: async () => JSON.stringify(body) });
    const api = {
        fetch: async (url: string, opts: { method: string; data?: { itemsPerPage: number; pageNumber: number } }) => {
            requests.push(`${opts.method} ${url}${opts.data ? ` p${opts.data.pageNumber}x${opts.data.itemsPerPage}` : ''}`);
            if (opts.method === 'POST' && url === '/api/v1/certificates') {
                const { itemsPerPage: size, pageNumber: n } = opts.data!;
                return reply(200, { certificates: certs.slice((n - 1) * size, n * size), totalItems: certs.length });
            }
            const m = /^\/api\/v1\/certificates\/(.+)$/.exec(url);
            if (m) return reply(details[m[1]] ?? 404, { uuid: m[1], state: 'issued' });
            return reply(404, {});
        },
    } as unknown as APIRequestContext;
    return { api, requests };
}

test('large collections store the newest 100 (head) and the oldest 200 (tail) of a newest-first list, without run-prefixed names', async () => {
    const certs = Array.from({ length: 350 }, (_, i) => ({ uuid: `c${349 - i}`, commonName: i % 50 === 0 ? `qa-reg-x-${i}` : `cn-${349 - i}`, state: 'issued' }));
    const { api, requests } = fakeApi(certs, {});
    const s = await snapshotTier(api, { only: ['certificates'], runId: RUN, env: {} });
    const r = s.resources.certificates;
    expect(r.total).toBe(350);
    expect(requests).toEqual(['POST /api/v1/certificates p1x1', 'POST /api/v1/certificates p1x100', 'POST /api/v1/certificates p2x100', 'POST /api/v1/certificates p3x100', 'POST /api/v1/certificates p4x100']);
    // positions 0..99 (minus 2 prefixed: i = 0, 50) + 150..349 (minus 4 prefixed: i = 150, 200, 250, 300)
    expect(Object.keys(r.foreign)).toHaveLength(98 + 196);
    expect(r.foreign.c0).toEqual({ name: 'cn-0', marker: 'issued' });
    expect(r.foreign.c348, 'position 1, in the newest sample').toEqual({ name: 'cn-348', marker: 'issued' });
    expect(r.foreign.c198, 'position 151, inside the oldest window').toEqual({ name: 'cn-198', marker: 'issued' });
    expect(r.foreign.c199, 'position 150 carries a run prefix').toBeUndefined();
    expect(r.foreign.c200, 'position 149: between the sample and the window').toBeUndefined();
    expect(r.foreign.c249, 'position 100: just after the sample').toBeUndefined();
});

test('the after snapshot re-reads a stored object that left the window; a 404 leaves it missing', async () => {
    const certs = [{ uuid: 'new', commonName: 'cn-new', state: 'issued' }];
    const recheck = snap({ certificates: { total: 2, foreign: { moved: { name: 'cn-moved', marker: 'issued' }, deleted: { name: 'cn-deleted', marker: 'issued' } }, window: 200 } });
    const { api } = fakeApi(certs, { moved: 200 });
    const after = await snapshotTier(api, { only: ['certificates'], recheck, runId: RUN, env: {} });
    expect(Object.keys(after.resources.certificates.foreign).sort()).toEqual(['moved', 'new']);
    const { violations } = compareSnapshots(recheck, after, { tolerance: 0 });
    expect(violations).toContain('certificates: pre-existing deleted is gone');
});

test('a renamed or re-described pre-existing object is a violation, without the names (Q10)', () => {
    const b = snap({
        roles: { total: 2, foreign: { o1: { name: 'Administrator', description: 'all rights' }, o2: { name: 'Auditor' } } },
        groups: { total: 1, foreign: { g1: { name: 'Prod' } } },
    });
    const a = snap({
        roles: { total: 2, foreign: { o1: { name: 'Administrator', description: 'changed' }, o2: { name: 'Auditor-renamed' } } },
        groups: { total: 1, foreign: { g1: { name: 'Prod' } } },
    });
    const { violations } = compareSnapshots(b, a, { tolerance: 0 });
    expect(violations).toEqual(['roles: pre-existing o1 changed its description (text withheld)', 'roles: pre-existing o2 was renamed (name withheld)']);
    expect(violations.join('\n'), 'R20: neither the old nor the new name is echoed').not.toMatch(/Auditor|all rights|changed$/);
    // A description that one side does not carry is not compared (older snapshots, list DTOs without one).
    const noDescription = snap({ roles: { total: 2, foreign: { o1: { name: 'Administrator' }, o2: { name: 'Auditor' } } }, groups: b.resources.groups });
    expect(compareSnapshots(b, noDescription, { tolerance: 0 }).violations).toEqual([]);
});

test('the recheck by detail reads the live name, so a rename outside the windows is seen too (Q10)', async () => {
    const recheck = snap({ certificates: { total: 1, foreign: { moved: { name: 'cn-moved', marker: 'issued' } }, window: 200 } });
    const reply = (status: number, body: unknown) => ({ status: () => status, text: async () => JSON.stringify(body) });
    const api = {
        fetch: async (url: string, opts: { method: string }) =>
            opts.method === 'POST' ? reply(200, { certificates: [], totalItems: 1 }) : reply(200, { uuid: 'moved', commonName: 'cn-renamed', state: 'issued' }),
    } as unknown as APIRequestContext;
    const after = await snapshotTier(api, { only: ['certificates'], recheck, runId: RUN, env: {} });
    expect(after.resources.certificates.foreign.moved.name).toBe('cn-renamed');
    const { violations } = compareSnapshots(recheck, { ...after, platformEvents: '{}', systemJobs: '[]' }, { tolerance: 0 });
    expect(violations).toEqual(['certificates: pre-existing moved was renamed (name withheld)']);
});

// ------------------------------------------------------------------ keys (incident fix, B1 live run 1): wrapper identity, straddle recheck

/** A key pair: two search rows (item names, states) of one wrapper, newest-first; its detail names the WRAPPER. */
interface FakeKey {
    uuid: string;
    wrapper: string;
    items: Array<{ name: string; state: string; enabled: boolean }>;
}
const pair = (n: number, over: Partial<FakeKey> = {}): FakeKey => ({
    uuid: `k${n}`, wrapper: `token key ${n}`, items: [{ name: `pub-${n}`, state: 'active', enabled: true }, { name: `priv-${n}`, state: 'active', enabled: true }], ...over,
});

/** Fake key API: one row per item of a newest-first list of keys; `GET /v1/keys/{uuid}` answers the wrapper detail. */
function fakeKeyApi(keys: FakeKey[], cfg: { detail404?: string[] } = {}): { api: APIRequestContext; requests: string[] } {
    const requests: string[] = [];
    const rows = keys.flatMap((k) => k.items.map((it, i) => ({ uuid: `${k.uuid}-i${i}`, keyWrapperUuid: k.uuid, name: it.name, state: it.state, enabled: it.enabled })));
    const reply = (status: number, body: unknown) => ({ status: () => status, text: async () => JSON.stringify(body) });
    const api = {
        fetch: async (url: string, opts: { method: string; data?: { itemsPerPage: number; pageNumber: number } }) => {
            requests.push(`${opts.method} ${url}`);
            if (opts.method === 'POST' && url === '/api/v1/keys') {
                const { itemsPerPage: size, pageNumber: n } = opts.data!;
                return reply(200, { cryptographicKeys: rows.slice((n - 1) * size, n * size), totalItems: rows.length });
            }
            const m = /^\/api\/v1\/keys\/(.+)$/.exec(url);
            const k = m && !cfg.detail404?.includes(m[1]) && keys.find((x) => x.uuid === m[1]);
            if (m) return k ? reply(200, { uuid: k.uuid, name: k.wrapper, items: k.items.map((it, i) => ({ uuid: `${k.uuid}-i${i}`, ...it })) }) : reply(404, {});
            return reply(404, {});
        },
    } as unknown as APIRequestContext;
    return { api, requests };
}

/** `count` key pairs (2 rows each) with one extra single-item key first, so the newest-100 cut falls INSIDE pair `cutPair`. */
function keysWithCutInside(count: number): { keys: FakeKey[]; cutPair: FakeKey } {
    const single: FakeKey = { uuid: 'k-single', wrapper: 'secret 0', items: [{ name: 'sec-0', state: 'active', enabled: true }] };
    const keys = [single, ...Array.from({ length: count }, (_, i) => pair(i + 1))];
    // rows: single at 0, pair i at 2i-1 / 2i → row 99 and 100 belong to pair 50.
    return { keys, cutPair: keys[50] };
}

test('keys: rows and detail give the same mark (item names + item states); the detail adds the wrapper name', () => {
    const k = pair(7);
    const rows = k.items.map((it, i) => ({ uuid: `${k.uuid}-i${i}`, keyWrapperUuid: k.uuid, ...it }));
    const fromRows = keyMarkOfRows(rows);
    const fromDetail = keyMarkOfDetail({ uuid: k.uuid, name: k.wrapper, items: rows });
    expect(fromRows).toEqual({ name: 'priv-7,pub-7', marker: 'active/true,active/true' });
    expect(fromDetail).toEqual({ ...fromRows, wrapper: 'token key 7' });
    expect(compareSnapshots(snap({ keys: { total: 2, foreign: { k7: fromRows } } }), snap({ keys: { total: 2, foreign: { k7: fromDetail } } }), { tolerance: 0 }).violations).toEqual([]);
});

test('keys: straddlingKeys names the wrappers on the two window cuts, and nothing when the sample meets the window', () => {
    const at = (pos: number, w: string) => ({ row: { keyWrapperUuid: w, uuid: `${w}-x` }, pos });
    const total = 1000;
    const start = total - OLDEST_WINDOW;
    expect([...straddlingKeys([at(0, 'a'), at(NEWEST_SAMPLE - 1, 'b'), at(start, 'c'), at(start + 1, 'd'), at(total - 1, 'e')], total)]).toEqual(['b', 'c']);
    expect([...straddlingKeys([at(NEWEST_SAMPLE - 1, 'b'), at(NEWEST_SAMPLE, 'c')], NEWEST_SAMPLE + OLDEST_WINDOW)], 'contiguous: every row is read').toEqual([]);
    expect([...straddlingKeys([at(NEWEST_SAMPLE - 1, 'b')], 150)], 'small collection').toEqual([]);
});

test('keys: a 2-item key on the newest-100 cut is marked from its detail, in the before and in the after snapshot (both directions) — no violation', async () => {
    const { keys, cutPair } = keysWithCutInside(200);
    const before = await snapshotTier(fakeKeyApi(keys).api, { only: ['keys'], runId: RUN, env: {} });
    expect(before.resources.keys.foreign[cutPair.uuid], 'the straddling key carries both items and the wrapper name').toEqual({ name: 'priv-50,pub-50', marker: 'active/true,active/true', wrapper: 'token key 50' });
    expect(before.resources.keys.foreign.k49, 'a key fully inside the sample is marked from its rows').toEqual({ name: 'priv-49,pub-49', marker: 'active/true,active/true' });

    // Direction 1: a new key appears in front, the cut moves one pair back: pair 50 leaves the sample, pair 49 straddles now.
    const grown = [pair(999), ...keys];
    const { api: afterApi, requests } = fakeKeyApi(grown);
    const after = await snapshotTier(afterApi, { only: ['keys'], recheck: before, runId: RUN, env: {} });
    // Details read, one GET each: the key now on the sample cut (k49), the one on the oldest-window cut (row 203 = k101) and the key that left the sample (k50).
    expect(requests.filter((r) => r.startsWith('GET /api/v1/keys/')).sort()).toEqual(['GET /api/v1/keys/k101', 'GET /api/v1/keys/k49', `GET /api/v1/keys/${cutPair.uuid}`]);
    expect(compareSnapshots(before, { ...after, platformEvents: '{}', systemJobs: '[]' }, { tolerance: 0 }).violations).toEqual(['keys: total 401 -> 403 (+2), the ledger explains +0']);

    // Direction 2: the same from the grown list back to the original (a key in front vanished).
    const before2 = await snapshotTier(fakeKeyApi(grown).api, { only: ['keys'], runId: RUN, env: {} });
    const after2 = await snapshotTier(fakeKeyApi(keys).api, { only: ['keys'], recheck: before2, runId: RUN, env: {} });
    const v2 = compareSnapshots(before2, { ...after2, platformEvents: '{}', systemJobs: '[]' }, { tolerance: 0 }).violations;
    expect(v2.filter((v) => /renamed|changed/.test(v)), 'no false rename / state change').toEqual([]);
    expect(v2).toEqual(['keys: pre-existing k999 is gone', 'keys: total 403 -> 401 (-2), the ledger explains +0']);
});

test('keys: a 2-item key that leaves the newest sample entirely is re-read by its detail and compared by its items — no "renamed" (the live-run-1 false positive)', async () => {
    const keys = [pair(1), pair(2), pair(3)];
    const before = await snapshotTier(fakeKeyApi(keys).api, { only: ['keys'], runId: RUN, env: {} });
    // 60 new pairs in front: pairs 1..3 are beyond row 100 and below the oldest window's start? No: total 126 rows < 300, all read.
    // So push them out for real: 200 pairs in front (total 406 rows, oldest window = rows 206..405, newest = 0..99).
    const after = await snapshotTier(fakeKeyApi([...Array.from({ length: 200 }, (_, i) => pair(100 + i)), ...keys]).api, { only: ['keys'], recheck: before, runId: RUN, env: {} });
    expect(after.resources.keys.foreign.k2, 'inside the oldest window: from rows').toEqual({ name: 'priv-2,pub-2', marker: 'active/true,active/true' });
    const v = compareSnapshots(before, { ...after, platformEvents: '{}', systemJobs: '[]' }, { tolerance: 0 }).violations;
    expect(v.filter((x) => /renamed|changed/.test(x))).toEqual([]);
});

test('keys: a real rename of the wrapper, a renamed item or a destroyed item is a violation, by wrapper uuid only', async () => {
    const { keys, cutPair } = keysWithCutInside(200);
    const before = await snapshotTier(fakeKeyApi(keys).api, { only: ['keys'], runId: RUN, env: {} });
    const renamedWrapper = keys.map((k) => (k === cutPair ? { ...k, wrapper: 'token key 50 (renamed)' } : k));
    const a1 = await snapshotTier(fakeKeyApi(renamedWrapper).api, { only: ['keys'], recheck: before, runId: RUN, env: {} });
    expect(compareSnapshots(before, { ...a1, platformEvents: '{}', systemJobs: '[]' }, { tolerance: 0 }).violations).toEqual([`keys: pre-existing ${cutPair.uuid} was renamed (name withheld)`]);
    const renamedItem = keys.map((k) => (k.uuid === 'k10' ? { ...k, items: [{ ...k.items[0], name: 'pub-10-renamed' }, k.items[1]] } : k));
    const a2 = await snapshotTier(fakeKeyApi(renamedItem).api, { only: ['keys'], recheck: before, runId: RUN, env: {} });
    expect(compareSnapshots(before, { ...a2, platformEvents: '{}', systemJobs: '[]' }, { tolerance: 0 }).violations).toEqual(['keys: pre-existing k10 was renamed (name withheld)']);
    const destroyed = keys.map((k) => (k.uuid === 'k10' ? { ...k, items: [k.items[0], { ...k.items[1], state: 'destroyed', enabled: false }] } : k));
    const a3 = await snapshotTier(fakeKeyApi(destroyed).api, { only: ['keys'], recheck: before, runId: RUN, env: {} });
    const v3 = compareSnapshots(before, { ...a3, platformEvents: '{}', systemJobs: '[]' }, { tolerance: 0 }).violations;
    expect(v3).toEqual(['keys: pre-existing k10 changed active/true,active/true -> active/true,destroyed/false']);
    expect(v3.join('\n'), 'R20: no key names').not.toMatch(/token key|pub-|priv-/);
    // The same on the straddling key, whose states come from the detail.
    const destroyedStraddler = keys.map((k) => (k === cutPair ? { ...k, items: [k.items[0], { ...k.items[1], state: 'destroyed', enabled: false }] } : k));
    const a4 = await snapshotTier(fakeKeyApi(destroyedStraddler).api, { only: ['keys'], recheck: before, runId: RUN, env: {} });
    expect(compareSnapshots(before, { ...a4, platformEvents: '{}', systemJobs: '[]' }, { tolerance: 0 }).violations).toEqual([`keys: pre-existing ${cutPair.uuid} changed active/true,active/true -> active/true,destroyed/false`]);
    // A key with a run-prefixed item (any of them) is the run's own: never stored as foreign.
    const own = await snapshotTier(fakeKeyApi([pair(5, { items: [{ name: 'other', state: 'active', enabled: true }, { name: 'qa-reg-x-key', state: 'active', enabled: true }] })]).api, { only: ['keys'], runId: RUN, env: {} });
    expect(own.resources.keys.foreign).toEqual({});
});

test('derived accounting reads the `derived` flag from the created line: a teardown-deleted certKey_ key is a derived delete, not an own one', () => {
    const b = before();
    const after = before();
    // The run uploaded a certificate (+1 cert, +1 certKey_ item), then the teardown deleted both: the `deleted` lines carry no `derived`.
    const ledger = [
        ledgerLine({ type: 'certificates', uuid: 'c1' }),
        ledgerLine({ type: 'keys', uuid: 'k-derived', derived: true }),
        ledgerLine({ type: 'certificates', uuid: 'c1', event: 'deleted', at: '2026-10-13T12:30:00.000Z' }),
        ledgerLine({ type: 'keys', uuid: 'k-derived', event: 'deleted', at: '2026-10-13T12:30:00.000Z' }),
    ];
    b.resources.certificates = { total: 5, foreign: {} };
    after.resources.certificates = { total: 5, foreign: {} };
    expect(compareSnapshots(b, after, { ledger, tolerance: 0 }).violations, 'keys 10 -> 10: one derived item came and went').toEqual([]);
    // Counted as an OWN key delete (two items), a foreign key item that vanished besides would hide in the wider range.
    after.resources.keys.total = 8;
    expect(compareSnapshots(b, after, { ledger, tolerance: 0 }).violations).toEqual(['keys: total 10 -> 8 (-2), the ledger explains -1..+0']);
    after.resources.keys.total = 10;
    // Counted as an own key delete, the expected range would be -2..-1 and 10 -> 10 a violation; the same through ownDeleted.
    const viaTeardown = ledger.slice(0, 3);
    expect(compareSnapshots(b, after, { ledger: viaTeardown, ownDeleted: [{ type: 'keys', uuid: 'k-derived' }], tolerance: 0 }).violations).toEqual([]);
    // Deleting an OWN key (not derived) still explains -1..-2 items.
    const ownKey = [ledgerLine({ type: 'keys', uuid: 'k-own' }), ledgerLine({ type: 'keys', uuid: 'k-own', event: 'deleted', at: '2026-10-13T12:30:00.000Z' })];
    after.resources.keys.total = 12;
    expect(compareSnapshots(b, after, { ledger: ownKey, tolerance: 0 }).violations).toEqual(['keys: total 10 -> 12 (+2), the ledger explains -1..+1']);
});

test('isRunNamed: run-prefixed names and the certKey_ / altCertKey_ keys core derives from run certificates; nothing else (F6)', () => {
    expect(isRunNamed('qa-reg-20261013-120000-ab12-ui.example.test')).toBe(true);
    expect(isRunNamed('certKey_qa-reg-20261013-120000-ab12-ui.example.test')).toBe(true);
    expect(isRunNamed('altCertKey_qa-api-x-cert')).toBe(true);
    expect(isRunNamed('certKey_prod.example.test')).toBe(false);
    expect(isRunNamed('prod certKey_qa-reg-x')).toBe(false);
    expect(isRunNamed('')).toBe(false);
    expect(isRunNamed(undefined)).toBe(false);
});

test('keys: a certKey_<run CN> item makes the key the run\'s own; a straddler whose item OUTSIDE the windows is run-named is own too (F6, F7)', async () => {
    const derived = pair(5, { items: [{ name: 'certKey_qa-reg-x-ui.example.test', state: 'active', enabled: true }] });
    const inWindow = await snapshotTier(fakeKeyApi([derived, pair(6)]).api, { only: ['keys'], runId: RUN, env: {} });
    expect(Object.keys(inWindow.resources.keys.foreign)).toEqual(['k6']);
    // Pair 50's second item (row 100, outside the sample) is run-named: only the detail shows it.
    const { keys, cutPair } = keysWithCutInside(200);
    const ownStraddler = keys.map((k) => (k === cutPair ? { ...k, items: [k.items[0], { ...k.items[1], name: 'qa-reg-x-key' }] } : k));
    const s = await snapshotTier(fakeKeyApi(ownStraddler).api, { only: ['keys'], runId: RUN, env: {} });
    expect(s.resources.keys.foreign[cutPair.uuid], 'own: not stored as foreign').toBeUndefined();
    expect(s.resources.keys.foreign.k49).toBeDefined();
});

test('keys: a straddler whose detail answers 404 is dropped from the snapshot with a note naming it, and the compare carries the note (F5)', async () => {
    const { keys, cutPair } = keysWithCutInside(200);
    const before = await snapshotTier(fakeKeyApi(keys, { detail404: [cutPair.uuid] }).api, { only: ['keys'], runId: RUN, env: {} });
    expect(before.resources.keys.foreign[cutPair.uuid], 'not kept with its partial row mark').toBeUndefined();
    expect(before.resources.keys.notes).toEqual([`keys: ${cutPair.uuid} vanished between the search and its detail read; not compared`]);
    const after = await snapshotTier(fakeKeyApi(keys).api, { only: ['keys'], recheck: before, runId: RUN, env: {} });
    const r = compareSnapshots(before, { ...after, platformEvents: '{}', systemJobs: '[]' }, { tolerance: 0 });
    expect(r.violations).toEqual([]);
    expect(r.notes).toEqual([`before: keys: ${cutPair.uuid} vanished between the search and its detail read; not compared`]);
    expect(r.notes.join(), 'R20: uuid only').not.toMatch(/token key/);
});
