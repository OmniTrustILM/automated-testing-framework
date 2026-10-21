/**
 * Unit tests for the own-object guard and the run id it depends on.
 *
 * Ownership needs the ledger "created" line of THIS run and no later "deleted" line; the run prefix is a second check
 * on top and never enough alone. `assertOwnLive` adds the live object (a fake API here): its live name must carry the
 * run prefix too. Derived objects carry no prefix and are owned through createdAfter. The run id has seconds and a
 * random suffix, so two runs started in the same minute never share a prefix; a hand-set id is validated and locked.
 */
import { APIRequestContext, test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { parseFlag } from '../../utils/regression/run/flags';
import {
    absenceOf, assertOwn, assertOwnLive, cachedLedger, carriesRunPrefix, derivedDeletable, fullListRow, ID_NAMED, isOwnObject, WorkaroundNote, LiveObjectMissing, mayDeleteOwn, OwnObjectViolation, checkOwnership,
    resetLedgerCacheForTests, restrictedUsername,
} from '../../utils/regression/ledger/ownership';
import { createdAfterMarker, LedgerLine, parseLedger, serverDate } from '../../utils/regression/ledger/ledger';
import {
    acquireRunLock, DEFAULT_RUN_ID, API_DEFAULT_RUN_ID, setRunEnvDefaults, hasRunFamilyPrefix, isDefaultRunId, newRunId, releaseRunLock, RUN_ID_FORMAT, runLockFile, assertValidRunId,
} from '../../utils/regression/run/runId';

// Each test starts with no cached ledger (a rewrite within one mtime tick would otherwise be missed).
test.afterEach(() => resetLedgerCacheForTests());

const RUN = 'qa-reg-20261013-120000-ab12';
const OTHER = 'qa-reg-20261013-120000-zz99';

const line = (over: Partial<LedgerLine>): LedgerLine => ({
    at: '2026-10-13T12:00:01.000Z', runId: RUN, type: 'roles', name: `${RUN}-role`, uuid: 'u-1', spec: 'T', event: 'created', ...over,
});

test('own: a created line of this run and the run prefix', () => {
    const lines = [line({})];
    expect(isOwnObject({ uuid: 'u-1', name: `${RUN}-role` }, { lines, runId: RUN })).toBe(true);
    expect(isOwnObject({ uuid: 'u-1' }, { lines, runId: RUN }), 'the name comes from the ledger line when not given').toBe(true);
});

test('foreign: no ledger line, even with this run\'s prefix', () => {
    const o = checkOwnership({ uuid: 'u-2', name: `${RUN}-looks-like-mine` }, { lines: [line({})], runId: RUN });
    expect(o.own).toBe(false);
    expect(o.reason).toMatch(/no ledger "created" line/);
});

test('another run\'s line does not make an object own, even in the same minute', () => {
    const lines = [line({ runId: OTHER, name: `${OTHER}-role` })];
    expect(isOwnObject({ uuid: 'u-1', name: `${OTHER}-role` }, { lines, runId: RUN })).toBe(false);
});

test('the prefix is checked on top of the ledger line', () => {
    const lines = [line({ name: 'hand-made-role' })];
    const o = checkOwnership({ uuid: 'u-1' }, { lines, runId: RUN });
    expect(o.own).toBe(false);
    expect(o.reason).toMatch(/does not start with/);
    // Only the ledger's own name decides; a name the caller passes in can neither rescue nor sink a line.
    expect(isOwnObject({ uuid: 'u-1', name: `${RUN}-forged` }, { lines: [line({ name: 'hand-made-role' })], runId: RUN }), 'a prefixed ref name cannot rescue an unprefixed ledger line').toBe(false);
    expect(isOwnObject({ uuid: 'u-1', name: 'renamed' }, { lines: [line({})], runId: RUN }), 'the ledger name decides, the live check covers renames').toBe(true);
    expect(isOwnObject({ uuid: 'u-1' }, { lines: [line({ name: `${RUN}.example.test` })], runId: RUN }), 'a DNS name of the run').toBe(true);
    expect(isOwnObject({ uuid: 'u-1' }, { lines: [line({ name: `${RUN}x-role` })], runId: RUN }), 'the run id must end at a separator').toBe(false);
});

test('a later deleted line ends ownership', () => {
    const lines = [line({}), line({ event: 'deleted', at: '2026-10-13T12:05:00.000Z' })];
    const o = checkOwnership({ uuid: 'u-1' }, { lines, runId: RUN });
    expect(o.own).toBe(false);
    expect(o.reason).toMatch(/deleted already/);
});

test('derived objects are owned through createdAfter and deleted only when created after it', () => {
    const derived = line({ type: 'keys', name: 'certKey_x', uuid: 'k-1', derived: true, createdAfter: '2026-10-13T12:00:00.000Z' });
    expect(isOwnObject({ uuid: 'k-1' }, { lines: [derived], runId: RUN }), 'no prefix needed for a derived object').toBe(true);
    expect(isOwnObject({ uuid: 'k-1' }, { lines: [{ ...derived, createdAfter: undefined }], runId: RUN }), 'createdAfter is required').toBe(false);
    expect(derivedDeletable(derived, '2026-10-13T12:00:00.000Z')).toBe(true);
    expect(derivedDeletable(derived, '2026-10-13T12:30:00.000Z')).toBe(true);
    expect(derivedDeletable(derived, '2026-10-13T11:59:59.000Z'), 'made before the run: not ours').toBe(false);
    expect(derivedDeletable(derived, undefined), 'no creation time: cannot prove it').toBe(false);
    expect(derivedDeletable(line({}), undefined), 'a non-derived line needs no creation time').toBe(true);
});

test('assertOwn names the helper and the object, and returns the created line', () => {
    expect(assertOwn({ uuid: 'u-1' }, 'enableOwnRaProfile', { lines: [line({})], runId: RUN }).uuid).toBe('u-1');
    let error: unknown;
    try {
        assertOwn({ uuid: 'u-9', name: 'Administrator' }, 'activateAcmeOnOwnRaProfile', { lines: [line({})], runId: RUN });
    } catch (e) {
        error = e;
    }
    expect(error).toBeInstanceOf(OwnObjectViolation);
    expect(String(error)).toMatch(/activateAcmeOnOwnRaProfile: refusing to touch object u-9: no ledger "created" line/);
    expect(String(error), 'the name of a refused object is never in the message').not.toContain('Administrator');
});

test('mayDeleteOwn: on by default, parsed as a switch; an unknown value throws', () => {
    expect(mayDeleteOwn({})).toBe(true);
    for (const v of ['1', 'true', 'YES', ' on ']) expect(mayDeleteOwn({ API_DELETE_OWN: v }), v).toBe(true);
    for (const v of ['0', 'false', 'no', 'Off', '']) expect(mayDeleteOwn({ API_DELETE_OWN: v }), v).toBe(false);
    expect(() => mayDeleteOwn({ API_DELETE_OWN: 'maybe' })).toThrow(/API_DELETE_OWN="maybe" is not a switch/);
    expect(() => parseFlag('2', 'X', false)).toThrow(/X="2"/);
    expect(parseFlag(undefined, 'X', true)).toBe(true);
});

test('the tier identity of the line is checked when one is given', () => {
    const lines = [line({ tier: 'aaaaaaaaaaaa' })];
    expect(isOwnObject({ uuid: 'u-1' }, { lines, runId: RUN, tier: 'aaaaaaaaaaaa' })).toBe(true);
    expect(checkOwnership({ uuid: 'u-1' }, { lines, runId: RUN, tier: 'bbbbbbbbbbbb' }).reason).toMatch(/another tier/);
    expect(checkOwnership({ uuid: 'u-1' }, { lines: [line({})], runId: RUN, tier: 'aaaaaaaaaaaa' }).reason).toMatch(/no tier identity/);
});

/** A fake request context answering detail GETs from `objects` (uuid → body; missing → 404). */
function liveApi(objects: Record<string, Record<string, unknown>>): { api: APIRequestContext; gets: string[] } {
    const gets: string[] = [];
    const api = {
        get: async (url: string) => {
            gets.push(url);
            const uuid = url.split('/').pop()!;
            const body = objects[uuid];
            return { status: () => (body ? 200 : 404), ok: () => !!body, json: async () => body, text: async () => JSON.stringify(body ?? {}) };
        },
    } as unknown as APIRequestContext;
    return { api, gets };
}

test('assertOwnLive: ledger first, then the live name must carry the run prefix', async () => {
    const lines = [line({ type: 'raProfiles', uuid: 'ra-1', name: `${RUN}-ra` })];
    const opts = { lines, runId: RUN, tier: null };
    const ok = liveApi({ 'ra-1': { uuid: 'ra-1', name: `${RUN}-ra` } });
    const live = await assertOwnLive(ok.api, 'raProfiles', { uuid: 'ra-1' }, 'enableOwnRaProfile', opts);
    expect(live.body?.name).toBe(`${RUN}-ra`);
    expect(ok.gets).toEqual(['/api/v1/raProfiles/ra-1']);

    // The ledger points at a uuid whose live object is someone else's (renamed, copy-paste, reused id): refused.
    const renamed = liveApi({ 'ra-1': { uuid: 'ra-1', name: 'Production RA' } });
    const e = await assertOwnLive(renamed.api, 'raProfiles', { uuid: 'ra-1' }, 'enableOwnRaProfile', opts).catch((x) => x);
    expect(e).toBeInstanceOf(OwnObjectViolation);
    expect(String(e)).toMatch(/raProfiles ra-1: its live name does not start with/);
    expect(String(e)).not.toContain('Production RA');

    // No ledger line: refused before any request.
    const none = liveApi({ 'ra-9': { name: `${RUN}-ra` } });
    await expect(assertOwnLive(none.api, 'raProfiles', { uuid: 'ra-9' }, 'x', opts)).rejects.toThrow(OwnObjectViolation);
    expect(none.gets).toEqual([]);

    // Gone: LiveObjectMissing (route or object missing), not a silent pass.
    await expect(assertOwnLive(liveApi({}).api, 'raProfiles', { uuid: 'ra-1' }, 'x', opts)).rejects.toThrow(LiveObjectMissing);

    // A wrong type for the line is refused.
    await expect(assertOwnLive(ok.api, 'roles', { uuid: 'ra-1' }, 'x', opts)).rejects.toThrow(/ledger records it as raProfiles/);
});

// assertOwnLive: users are checked by username, certificates by commonName; derived and id-named lines by the ledger
test('assertOwnLive checks users by username and certificates by commonName; derived lines by ledger', async () => {
    const lines = [
        line({ type: 'users', uuid: 'us-1', name: `${RUN}-user` }),
        line({ type: 'certificates', uuid: 'c-1', name: `${RUN}.example.test` }),
        line({ type: 'certificates', uuid: 'c-2', name: 'onboarded', derived: true, createdAfter: '2026-10-13T12:00:00.000Z' }),
        line({ type: 'acmeAccounts', uuid: 'acc-1', name: `${RUN}-acme-account-abc` }),
    ];
    const opts = { lines, runId: RUN, tier: null };
    const { api, gets } = liveApi({ 'us-1': { username: `${RUN}-user` }, 'c-1': { commonName: `${RUN}.example.test` }, 'c-2': { commonName: 'www.example.org' } });
    await assertOwnLive(api, 'users', { uuid: 'us-1' }, 'x', opts);
    await assertOwnLive(api, 'certificates', { uuid: 'c-1' }, 'x', opts);
    await assertOwnLive(api, 'certificates', { uuid: 'c-2' }, 'x', opts); // derived: no prefix needed, still read
    const acc = await assertOwnLive(api, 'acmeAccounts', { uuid: 'acc-1' }, 'x', opts); // id-named: ledger only
    expect(acc.body).toBeUndefined();
    expect(gets).toEqual(['/api/v1/users/us-1', '/api/v1/certificates/c-1', '/api/v1/certificates/c-2']);
});

/** A fake API answering per path: status and body (paths not listed answer 404). Records every GET. */
function pathApi(routes: Record<string, { status: number; body?: unknown }>): { api: APIRequestContext; gets: string[] } {
    const gets: string[] = [];
    const api = {
        get: async (url: string) => {
            gets.push(url);
            const r = routes[url] ?? { status: 404 };
            return { status: () => r.status, ok: () => r.status >= 200 && r.status < 300, json: async () => r.body, text: async () => JSON.stringify(r.body ?? {}) };
        },
    } as unknown as APIRequestContext;
    return { api, gets };
}

// assertOwnLive with the known core defect where a role or user detail answers 5xx: it is decided by the full list only; other
// types stay strict
test('assertOwnLive: a 5xx role or user detail is decided by the full list only; other types stay strict', async () => {
    const lines = [line({ type: 'roles', uuid: 'r-1', name: `${RUN}-role` }), line({ type: 'groups', uuid: 'g-1', name: `${RUN}-group` })];
    const notes: WorkaroundNote[] = [];
    const opts = { lines, runId: RUN, tier: null, onKnownBug: (n: WorkaroundNote) => void notes.push(n) };
    // Listed with the run prefix: the list row is the live object.
    const listed = pathApi({ '/api/v1/roles/r-1': { status: 500 }, '/api/v1/roles': { status: 200, body: [{ uuid: 'r-1', name: `${RUN}-role` }] } });
    const live = await assertOwnLive(listed.api, 'roles', { uuid: 'r-1' }, 'x', opts);
    expect([live.via, live.body?.name]).toEqual(['list', `${RUN}-role`]);
    expect(listed.gets).toEqual(['/api/v1/roles/r-1', '/api/v1/roles']);
    // Listed under a foreign name: refused like a renamed detail.
    const renamed = pathApi({ '/api/v1/roles/r-1': { status: 500 }, '/api/v1/roles': { status: 200, body: [{ uuid: 'r-1', name: 'Administrators' }] } });
    await expect(assertOwnLive(renamed.api, 'roles', { uuid: 'r-1' }, 'x', opts)).rejects.toThrow(OwnObjectViolation);
    // Not listed: missing (core#2511 for a deleted role), never a silent pass.
    const gone = pathApi({ '/api/v1/roles/r-1': { status: 500 }, '/api/v1/roles': { status: 200, body: [{ uuid: 'r-2', name: 'x' }] } });
    await expect(assertOwnLive(gone.api, 'roles', { uuid: 'r-1' }, 'x', opts)).rejects.toThrow(/answered 500 \(known bug core#2511\) and \/api\/v1\/roles does not list it/);
    expect(notes.map((n) => n.bug)).toEqual(['core#2511', 'core#2511', 'core#2511']);
    // The list unreadable: the error propagates (nothing proven).
    const down = pathApi({ '/api/v1/roles/r-1': { status: 500 }, '/api/v1/roles': { status: 502 } });
    await expect(assertOwnLive(down.api, 'roles', { uuid: 'r-1' }, 'x', opts)).rejects.toThrow(/answered 502/);
    // Another type: a 5xx is an error, no list is read.
    const group = pathApi({ '/api/v1/groups/g-1': { status: 500 } });
    await expect(assertOwnLive(group.api, 'groups', { uuid: 'g-1' }, 'x', opts)).rejects.toThrow(/GET groups g-1 answered 500/);
    expect(group.gets).toEqual(['/api/v1/groups/g-1']);
});

// absenceOf: 404 proves absence; a 5xx only through the full list of roles / users; fullListRow refuses a capped list
test('absenceOf: 404 proves absence; a 5xx only via the full role or user list; a capped list refused', async () => {
    const detail = '/api/v1/roles/r-1';
    expect((await absenceOf(pathApi({}).api, 'roles', 'r-1', detail)).absent).toBe(true);
    const gone = await absenceOf(pathApi({ [detail]: { status: 500 }, '/api/v1/roles': { status: 200, body: [{ uuid: 'r-2' }] } }).api, 'roles', 'r-1', detail);
    expect([gone.absent, gone.knownBug?.bug]).toEqual([true, 'core#2511']);
    // An empty list, or rows without a string uuid, prove nothing.
    const empty = await absenceOf(pathApi({ [detail]: { status: 500 }, '/api/v1/roles': { status: 200, body: [] } }).api, 'roles', 'r-1', detail);
    expect([empty.absent, empty.detail]).toEqual([false, 'GET answered 500; roles r-1: /api/v1/roles answered an empty list; it proves nothing']);
    const still = await absenceOf(pathApi({ [detail]: { status: 500 }, '/api/v1/roles': { status: 200, body: [{ uuid: 'R-1' }] } }).api, 'roles', 'r-1', detail);
    expect([still.absent, still.detail]).toEqual([false, 'GET answered 500 and /api/v1/roles still lists it']);
    const other = await absenceOf(pathApi({ '/api/v1/groups/g-1': { status: 503 } }).api, 'groups', 'g-1', '/api/v1/groups/g-1');
    expect([other.absent, other.detail]).toEqual([false, 'GET answered 503 (a 5xx is never proof of absence)']);
    const present = await absenceOf(pathApi({ [detail]: { status: 200, body: {} } }).api, 'roles', 'r-1', detail);
    expect([present.absent, present.detail]).toEqual([false, 'GET still finds it (status 200)']);
    const capped = pathApi({ '/api/v1/users': { status: 200, body: Array.from({ length: 1000 }, (_, i) => ({ uuid: `u-${i}` })) } });
    await expect(fullListRow(capped.api, 'users', 'x')).rejects.toThrow(/1000 rows .*may be truncated/);
    await expect(fullListRow(capped.api, 'groups', 'x')).rejects.toThrow(/no authoritative full list/);
});

test('createdAfter comes from the server clock minus the margin and the request time', () => {
    const date = serverDate({ date: 'Tue, 13 Oct 2026 12:00:10 GMT' });
    expect(date?.toISOString()).toBe('2026-10-13T12:00:10.000Z');
    expect(serverDate({})).toBeUndefined();
    expect(createdAfterMarker(date!)).toBe('2026-10-13T12:00:08.000Z');
    expect(createdAfterMarker('2026-10-13T12:00:10.000Z', 3_000)).toBe('2026-10-13T12:00:05.000Z');
    expect(() => createdAfterMarker('not a date')).toThrow(/not a timestamp/);
});

test('the ledger cache re-reads after an append', async ({}, testInfo) => {
    const file = testInfo.outputPath('created-objects.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Lines read from a file must carry a canonical uuid (parseLedger skips any other shape).
    const U1 = '00000000-0000-4000-8000-0000000000c1';
    const U2 = '00000000-0000-4000-8000-0000000000c2';
    fs.writeFileSync(file, `${JSON.stringify(line({ uuid: U1 }))}\n`);
    expect(cachedLedger(file)).toHaveLength(1);
    fs.appendFileSync(file, `${JSON.stringify(line({ uuid: U2, name: `${RUN}-b` }))}\n`);
    expect(cachedLedger(file)).toHaveLength(2);
    expect(isOwnObject({ uuid: U2 }, { file, runId: RUN })).toBe(true);
});

test('legacy ledger lines (no event, `run` instead of `runId`) still count as created', () => {
    const U1 = '00000000-0000-4000-8000-0000000000c1';
    const U2 = '00000000-0000-4000-8000-0000000000c2';
    const text = [
        JSON.stringify({ at: 'a', runId: RUN, type: 'roles', name: `${RUN}-r`, uuid: U1, spec: 'REG-CFG-07' }),
        JSON.stringify({ at: 'b', run: RUN, type: 'groups', name: `${RUN}-g`, uuid: U2, spec: 'API-X', note: '' }),
        'not json',
        '',
    ].join('\n');
    const lines = parseLedger(text);
    expect(lines.map((l) => [l.uuid, l.runId, l.event])).toEqual([[U1, RUN, 'created'], [U2, RUN, 'created']]);
});

test('run id: seconds plus four random base36 characters', () => {
    const id = newRunId(new Date('2026-10-13T09:08:07.654Z'), () => 35);
    expect(id).toBe('qa-reg-20261013-090807-zzzz');
    expect(id).toMatch(RUN_ID_FORMAT);
    const ids = new Set(Array.from({ length: 50 }, () => newRunId(new Date('2026-10-13T09:08:07Z'))));
    expect(ids.size, 'same second, different suffixes').toBeGreaterThan(45);
});

test('setRunEnvDefaults sets the run defaults once and keeps what is already set', () => {
    const env: NodeJS.ProcessEnv = { REG_STATE_DIR: '/tmp/state' };
    const id = setRunEnvDefaults(env);
    expect(id).toMatch(RUN_ID_FORMAT);
    expect(env).toMatchObject({ REG_RUN_ID: id, API_RUN_ID: id, API_DELETE_OWN: '1', CLEANUP_LEDGER_FILE: path.join('/tmp/state', `${id}.cleanup.jsonl`) });
    expect(setRunEnvDefaults(env), 'a second load (a worker) keeps the id').toBe(id);
    const kept: NodeJS.ProcessEnv = { REG_RUN_ID: 'qa-reg-20261008-dev', REG_RUN_ID_REUSE: '1', API_DELETE_OWN: '1' };
    setRunEnvDefaults(kept);
    expect(kept).toMatchObject({ REG_RUN_ID: 'qa-reg-20261008-dev', API_DELETE_OWN: '1' });
});

test('a hand-set run id is validated, keeps its objects by default, and forces API_RUN_ID', () => {
    expect(() => setRunEnvDefaults({ REG_RUN_ID: 'qa-reg-20261008-dev' }), 'old shape without REG_RUN_ID_REUSE').toThrow(/REG_RUN_ID_REUSE=1/);
    expect(() => setRunEnvDefaults({ REG_RUN_ID: 'Prod-Run', REG_RUN_ID_REUSE: '1' }), 'not the family even with reuse').toThrow(/qa-reg-\[a-z0-9-\]\+/);
    expect(() => assertValidRunId(DEFAULT_RUN_ID)).toThrow(/adhoc default/);
    expect(() => assertValidRunId(API_DEFAULT_RUN_ID)).toThrow(/adhoc default/);
    const handSet: NodeJS.ProcessEnv = { REG_RUN_ID: RUN, API_RUN_ID: 'qa-api-something-else' };
    setRunEnvDefaults(handSet);
    expect(handSet.API_DELETE_OWN, 'a hand-set id does not default to deleting').toBe('0');
    expect(handSet.API_RUN_ID, 'API_RUN_ID is forced to REG_RUN_ID').toBe(RUN);
    expect(() => setRunEnvDefaults({ API_DELETE_OWN: 'perhaps' })).toThrow(/API_DELETE_OWN="perhaps"/);
});

test('the run lock refuses a second live run with the same id and takes over a stale lock', ({}, testInfo) => {
    const env: NodeJS.ProcessEnv = { REG_STATE_DIR: testInfo.outputPath('state') };
    const alive = new Set([111, 222]);
    const isAlive = (pid: number) => alive.has(pid);
    acquireRunLock(RUN, env, 111, isAlive);
    expect(fs.readFileSync(runLockFile(RUN, env), 'utf8').trim()).toBe('111');
    expect(() => acquireRunLock(RUN, env, 111, isAlive), 're-entrant for the same runner').not.toThrow();
    expect(() => acquireRunLock(RUN, env, 222, isAlive)).toThrow(/already in use by a live process \(pid 111/);
    alive.delete(111);
    acquireRunLock(RUN, env, 222, isAlive);
    expect(fs.readFileSync(runLockFile(RUN, env), 'utf8').trim(), 'the stale lock was taken over').toBe('222');
    releaseRunLock(RUN, env, 111);
    expect(fs.existsSync(runLockFile(RUN, env)), 'only the holder releases').toBe(true);
    releaseRunLock(RUN, env, 222);
    expect(fs.existsSync(runLockFile(RUN, env))).toBe(false);
});

test('both adhoc ids are recognised, and the prefix family covers both suites', () => {
    expect(isDefaultRunId(DEFAULT_RUN_ID)).toBe(true);
    expect(isDefaultRunId(API_DEFAULT_RUN_ID)).toBe(true);
    expect(isDefaultRunId(RUN)).toBe(false);
    expect(hasRunFamilyPrefix('qa-reg-20261013-x')).toBe(true);
    expect(hasRunFamilyPrefix('qa-api-20261013-x')).toBe(true);
    expect(hasRunFamilyPrefix('Administrator')).toBe(false);
    expect(hasRunFamilyPrefix(undefined)).toBe(false);
});

test('id-named types rest on the ledger; a type that is neither read live nor id-named is refused', async () => {
    const api = { get: async () => { throw new Error('no read expected'); } } as unknown as APIRequestContext;
    for (const type of ['acmeAccounts', 'approvals', 'eventAssociations', 'savedViews', 'oidEntries', 'scheduledJobs', 'k8s:Certificate']) {
        expect(ID_NAMED.has(type) || type.startsWith('k8s:'), type).toBe(true);
        const lines = [line({ type, name: `${RUN}-${type}` })];
        await expect(assertOwnLive(api, type, { uuid: 'u-1' }, 'test', { lines, runId: RUN, tier: null }), type).resolves.toEqual({ line: lines[0] });
    }
    const typo = [line({ type: 'raProfile', name: `${RUN}-ra` })];
    await expect(assertOwnLive(api, 'raProfile', { uuid: 'u-1' }, 'test', { lines: typo, runId: RUN, tier: null })).rejects.toThrow(/unknown ledger type "raProfile"/);
});

// ------------------------------------------------------------------ the dedicated identity's ILM user

// a users line named REG_RESTRICTED_USERNAME is own with a created line of this run; never by name alone, for another type, or
// without the variable
test('a users line named REG_RESTRICTED_USERNAME is own with a created line, never by name alone', () => {
    const env = { REG_RESTRICTED_USERNAME: ' QA-DED-User ' };
    const ded = line({ type: 'users', uuid: 'u-ded', name: 'qa-ded-user' });
    expect(restrictedUsername(env)).toBe('qa-ded-user');
    expect(restrictedUsername({})).toBeUndefined();
    expect(restrictedUsername({ REG_RESTRICTED_USERNAME: '  ' })).toBeUndefined();
    expect(isOwnObject({ uuid: 'u-ded' }, { lines: [ded], runId: RUN, env })).toBe(true);
    expect(checkOwnership({ uuid: 'u-ded' }, { lines: [ded], runId: RUN, env }).reason).toBe('created by this run');
    // u2: the env unset or empty → the prefix rule, named in the reason.
    for (const e of [{}, { REG_RESTRICTED_USERNAME: '' }]) {
        const o = checkOwnership({ uuid: 'u-ded' }, { lines: [ded], runId: RUN, env: e });
        expect(o.own).toBe(false);
        expect(o.reason).toMatch(/does not start with .*REG_RESTRICTED_USERNAME for a users line/);
    }
    // u3: the same name on a roles / groups line is not own.
    for (const type of ['roles', 'groups', 'certificates']) {
        expect(isOwnObject({ uuid: 'x' }, { lines: [line({ type, uuid: 'x', name: 'qa-ded-user' })], runId: RUN, env }), type).toBe(false);
    }
    // u4: no created line of THIS run (name alone, another run, another tier), or a later deleted line.
    expect(isOwnObject({ uuid: 'u-other', name: 'qa-ded-user' }, { lines: [ded], runId: RUN, env })).toBe(false);
    expect(isOwnObject({ uuid: 'u-ded' }, { lines: [{ ...ded, runId: OTHER }], runId: RUN, env })).toBe(false);
    expect(isOwnObject({ uuid: 'u-ded' }, { lines: [{ ...ded, tier: 'bbbb' }], runId: RUN, tier: 'aaaa', env })).toBe(false);
    expect(isOwnObject({ uuid: 'u-ded' }, { lines: [ded, { ...ded, event: 'deleted', at: '2026-10-13T12:05:00.000Z' }], runId: RUN, env })).toBe(false);
    expect(isOwnObject({ uuid: 'u-ded' }, { lines: [{ ...ded, derived: true, createdAfter: undefined }], runId: RUN, env }), 'a derived line without createdAfter').toBe(false);
    // carriesRunPrefix itself: the type gates the second form; the process env is the default seam.
    expect(carriesRunPrefix('qa-ded-user', RUN, 'users', env)).toBe(true);
    expect(carriesRunPrefix('qa-ded-user', RUN, 'roles', env)).toBe(false);
    expect(carriesRunPrefix('qa-ded-user', RUN, undefined, env)).toBe(false);
    expect(carriesRunPrefix('qa-ded-user', RUN, 'users', {})).toBe(false);
    expect(carriesRunPrefix(`${RUN}-user`, RUN, 'users', {})).toBe(true);
    const saved = process.env.REG_RESTRICTED_USERNAME;
    process.env.REG_RESTRICTED_USERNAME = 'qa-ded-user';
    try {
        expect(carriesRunPrefix('QA-DED-USER', RUN, 'users')).toBe(true);
        expect(isOwnObject({ uuid: 'u-ded' }, { lines: [ded], runId: RUN })).toBe(true);
    } finally {
        if (saved === undefined) delete process.env.REG_RESTRICTED_USERNAME;
        else process.env.REG_RESTRICTED_USERNAME = saved;
    }
});

// the live username must equal the configured name (any case); a differing live name, or a roles line of that name, is refused
test('the live username must equal the configured name in any case; a differing name is refused', async () => {
    const env = { REG_RESTRICTED_USERNAME: 'qa-ded-user' };
    const ded = line({ type: 'users', uuid: 'u-ded', name: 'qa-ded-user' });
    const opts = { lines: [ded], runId: RUN, tier: null, env };
    const ok = liveApi({ 'u-ded': { uuid: 'u-ded', username: 'QA-DED-USER' } });
    expect((await assertOwnLive(ok.api, 'users', { uuid: 'u-ded' }, 'x', opts)).body?.username).toBe('QA-DED-USER');
    const other = liveApi({ 'u-ded': { uuid: 'u-ded', username: 'alice' } });
    const e = await assertOwnLive(other.api, 'users', { uuid: 'u-ded' }, 'x', opts).catch((x) => x);
    expect(e).toBeInstanceOf(OwnObjectViolation);
    expect(String(e)).toMatch(/its live name does not start with .*or REG_RESTRICTED_USERNAME/);
    expect(String(e)).not.toContain('alice');
    await expect(assertOwnLive(ok.api, 'users', { uuid: 'u-ded' }, 'x', { ...opts, env: {} })).rejects.toThrow(OwnObjectViolation);
    const role = line({ type: 'roles', uuid: 'r-ded', name: 'qa-ded-user' });
    await expect(assertOwnLive(liveApi({ 'r-ded': { name: 'qa-ded-user' } }).api, 'roles', { uuid: 'r-ded' }, 'x', { ...opts, lines: [role] })).rejects.toThrow(OwnObjectViolation);
});
