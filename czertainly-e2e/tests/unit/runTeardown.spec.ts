/**
 * Unit tests for the run-end teardown (decision D1, reviews M2 / M3 / m5 / R4 / R9 / R10 / R13 / R15 / R17 / R20 / R27)
 * with fake handlers and no environment: the delete order, refusal of anything the guard does not accept (including a
 * line of another tier), "no handler" only for types that have ledger lines, cascade reporting with blockedBy, the
 * ledger re-read between steps, a fresh context per object, kept objects as warnings, the adhoc / API_RUN_ID refusal,
 * the dry run at every entry, and a missing before snapshot on a shared tier. Fix pass 3: known bugs worked around
 * (core#2511) are collected into the kept report; the run's local-backend proof is removed at the end of every path.
 */
import { APIRequestContext, request, test, expect } from '@playwright/test';
import * as fs from 'fs';
import { readCleanupFailures } from '../../utils/cleanupLedger';
import { DryRunRefusal } from '../../utils/regression/flags';
import { LedgerLine } from '../../utils/regression/regressionRun';
import { localProofFile } from '../../utils/regression/tier';
import runTeardown, {
    defaultPreSteps, DELETE_ORDER, deletedBefore, executeTeardown, formatPlan, HANDLER_MODULES, handlerFor, isKeptStrict, loadModuleHandlers, planTeardown, PlanItem,
    PreStep, readKeptReport, reauthenticating, recordKnownBug, REFERENCED_BY, removeOwnObject, runSummary, stepOf, TeardownHandler, writeKeptReport,
} from '../../utils/regression/runTeardown';
import { ID_NAMED, LIVE_READS } from '../../utils/regression/ownObjects';
import { loopbackServer } from './helpers/loopbackServer';

const RUN = 'qa-reg-20261013-120000-ab12';

let seq = 0;
const line = (type: string, over: Partial<LedgerLine> = {}): LedgerLine => {
    seq++;
    return { at: `2026-10-13T12:00:${String(seq).padStart(2, '0')}.000Z`, runId: RUN, type, name: `${RUN}-${type}-${seq}`, uuid: `${type}-${seq}`, spec: 'T', event: 'created', ...over };
};

const ENV_KEYS = ['CLEANUP_LEDGER_FILE', 'REG_STATE_DIR', 'REG_RUN_ID', 'API_RUN_ID', 'API_TEARDOWN_DRY_RUN', 'API_DELETE_OWN', 'TIER_KIND', 'BASE_URL', 'REG_TIER_ID', 'AUTH_MODE', 'REG_KEPT_STRICT'];
let saved: Record<string, string | undefined> = {};
test.beforeEach(({}, testInfo) => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.CLEANUP_LEDGER_FILE = testInfo.outputPath('cleanup.jsonl');
    process.env.REG_STATE_DIR = testInfo.outputPath('state');
    process.env.TIER_KIND = 'shared'; // frozen by the configs at load
});
test.afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

/** Handlers that record the order of removals; `fail` maps a uuid to the error its removal throws. */
function recorder(fail: Record<string, Error> = {}): { handler: (type: string) => TeardownHandler | undefined; removed: string[] } {
    const removed: string[] = [];
    const known = new Set(['certificates', 'keys', 'discoveries', 'acmeProfiles', 'raProfiles', 'authorities', 'credentials', 'users', 'roles', 'groups']);
    const handler = (type: string): TeardownHandler | undefined =>
        known.has(type)
            ? { action: `remove ${type}`, remove: async (_ctx, l) => { if (fail[l.uuid]) throw fail[l.uuid]; removed.push(l.uuid); } }
            : undefined;
    return { handler, removed };
}

const fakeApi = { dispose: async () => undefined } as unknown as APIRequestContext;
/** Defaults of every executeTeardown call here: no tier check (no BASE_URL in unit tests), no retry delay. */
const quick = { tier: null, retryDelayMs: 1 } as const;

test('the plan follows the delete order and leaves other runs and deleted objects out', () => {
    const lines = [
        line('credentials'), line('authorities'), line('raProfiles'), line('acmeProfiles'), line('certificates'), line('roles'), line('users'),
        line('groups', { runId: 'qa-reg-20261013-120000-zz99', name: 'qa-reg-20261013-120000-zz99-g' }),
    ];
    const gone = line('certificates');
    lines.push(gone, { ...gone, event: 'deleted', at: '2026-10-13T12:59:00.000Z' });
    const plan = planTeardown(lines, RUN, recorder().handler);
    expect(plan.map((p) => p.type)).toEqual(['certificates', 'acmeProfiles', 'raProfiles', 'authorities', 'credentials', 'users', 'roles']);
    expect(plan.every((p) => !p.refused)).toBe(true);
});

test('a line the guard does not accept is refused and never removed', async () => {
    const foreign = line('roles', { name: 'Administrator' });
    const mine = line('roles');
    const lines = [foreign, mine];
    const { handler, removed } = recorder();
    const plan = planTeardown(lines, RUN, handler);
    expect(plan.find((p) => p.uuid === foreign.uuid)?.refused).toMatch(/does not start with/);

    const deleted: PlanItem[] = [];
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => lines, handler, onDeleted: (p) => deleted.push(p) });
    expect(removed).toEqual([mine.uuid]);
    expect(deleted.map((d) => d.uuid)).toEqual([mine.uuid]);
    expect(result.failed.map((f) => f.uuid)).toEqual([foreign.uuid]);
    expect(readCleanupFailures()).toEqual([expect.objectContaining({ resource: 'roles', uuid: foreign.uuid, message: expect.stringMatching(/^refused: name does not start with/) })]);
    expect(readCleanupFailures()[0].name, 'R20: a refused object is reported without its name').toBeUndefined();
    expect(formatPlan(plan)).not.toContain('Administrator');
    expect(formatPlan(plan)).toContain('(name withheld)');
});

test('a line recorded on another tier, or without a tier identity, is refused when the tier is known (R15)', () => {
    const here = line('roles', { tier: 'aaaaaaaaaaaa' });
    const there = line('roles', { tier: 'bbbbbbbbbbbb' });
    const legacy = line('roles');
    const plan = planTeardown([here, there, legacy], RUN, recorder().handler, { tier: 'aaaaaaaaaaaa' });
    expect(plan.find((p) => p.uuid === here.uuid)?.refused).toBeUndefined();
    expect(plan.find((p) => p.uuid === there.uuid)?.refused).toMatch(/another tier/);
    expect(plan.find((p) => p.uuid === legacy.uuid)?.refused).toMatch(/no tier identity/);
});

test('every object gets a fresh authenticated context (R10), disposed after its step', async () => {
    const lines = [line('roles'), line('roles'), line('groups')];
    let created = 0;
    let disposed = 0;
    const newApi = async () => {
        created++;
        return { dispose: async () => void disposed++ } as unknown as APIRequestContext;
    };
    await executeTeardown({ ...quick, runId: RUN, newApi, readLines: () => lines, handler: recorder().handler, onDeleted: () => undefined });
    expect(created).toBe(3);
    expect(disposed).toBe(3);
});

test('the post-delete context authenticates again once on a 401 and retries (R10)', async () => {
    const answers = [401, 200];
    let logins = 0;
    const newApi = async () => {
        logins++;
        return { get: async () => ({ status: () => answers.shift() ?? 200 }) } as unknown as APIRequestContext;
    };
    const api = await reauthenticating(newApi);
    expect((await api.get('/api/v1/roles')).status()).toBe(200);
    expect(logins).toBe(2);
});

test('"no handler (type X)" is reported only for types that have ledger lines', async () => {
    // Guard-integration pass: never a real area module name here (lifecycle / workflowUtils arrive with their areas).
    expect(loadModuleHandlers('a-module-that-never-exists'), 'a module that does not exist').toBeUndefined();
    expect(handlerFor('roles')?.action, 'B0 types resolve to teardownHandlers').toMatch(/DELETE \/api\/v1\/roles/);
    expect(handlerFor('unregisteredType'), 'a type without a registry entry has no handler').toBeUndefined();

    const lines = [line('unregisteredType')];
    expect(planTeardown(lines, RUN)[0].action).toBe('no handler (type unregisteredType)');
    await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => lines });
    expect(readCleanupFailures()).toEqual([expect.objectContaining({ resource: 'unregisteredType', message: 'no handler (type unregisteredType)' })]);

    fs.rmSync(process.env.CLEANUP_LEDGER_FILE!, { force: true });
    await executeTeardown({ ...quick, runId: RUN, newApi: async () => { throw new Error('no request expected'); }, readLines: () => [] });
    expect(readCleanupFailures(), 'no lines, no report').toEqual([]);
});

test('failures are recorded with the object that blocks them', async () => {
    const cert = line('certificates');
    const ra = line('raProfiles');
    const fail = {
        [cert.uuid]: Object.assign(new Error('revoke refused: 503 - connector unavailable'), { blockedBy: 'authority a-1' }),
        [ra.uuid]: new Error(`Failed to delete RA Profile ${ra.uuid}: 422 - ["Dependent certificates: 1"]`),
    };
    const { handler } = recorder(fail);
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [cert, ra], handler, onDeleted: () => undefined });
    expect(result.failed.map((f) => f.uuid)).toEqual([cert.uuid, ra.uuid]);
    const failures = readCleanupFailures();
    expect(failures[0]).toMatchObject({ resource: 'certificates', uuid: cert.uuid, status: 503, blockedBy: 'authority a-1' });
    expect(failures[1]).toMatchObject({ resource: 'raProfiles', uuid: ra.uuid, status: 422, blockedBy: `certificates ${cert.uuid}` });
});

test('the ledger is re-read before each step: a derived line added by a discovery is deleted in the certificate step', async () => {
    const lines: LedgerLine[] = [line('discoveries')];
    const removed: string[] = [];
    const handler = (type: string): TeardownHandler | undefined => ({
        action: type,
        remove: async (_ctx, l) => {
            removed.push(l.uuid);
            if (type === 'discoveries') lines.push(line('certificates', { name: 'onboarded', derived: true, createdAfter: lines[0].at, parents: { discovery: l.uuid } }));
        },
    });
    const deleted: string[] = [];
    await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [...lines], handler, onDeleted: (p) => deleted.push(p.type) });
    expect(deleted).toEqual(['discoveries', 'certificates']);
});

test('a handler that answers "kept" leaves no deleted line and no failure, but a warning (R17)', async () => {
    const key = line('keys', { name: 'certKey_x', derived: true, createdAfter: '2026-10-13T12:00:00.000Z' });
    const handler = (): TeardownHandler => ({ action: 'k', remove: async () => 'kept' });
    const deleted: string[] = [];
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [key], handler, onDeleted: (p) => deleted.push(p.uuid) });
    expect(result.kept.map((k) => k.uuid)).toEqual([key.uuid]);
    expect(result.warnings).toEqual([expect.stringMatching(new RegExp(`^kept keys ${key.uuid}`))]);
    expect(deleted).toEqual([]);
    expect(readCleanupFailures()).toEqual([]);
});

test('the teardown refuses both adhoc run ids and an API_RUN_ID that differs (R13)', async () => {
    process.env.REG_RUN_ID = 'qa-reg-adhoc';
    await expect(runTeardown()).rejects.toThrow(/adhoc default .* refusing to delete anything/);
    process.env.REG_RUN_ID = RUN;
    process.env.API_RUN_ID = 'qa-api-adhoc';
    await expect(runTeardown()).rejects.toThrow(/refusing to delete anything/);
    process.env.API_RUN_ID = 'qa-reg-20261013-120000-zz99';
    await expect(runTeardown()).rejects.toThrow(/API_RUN_ID differs/);
});

test('the teardown re-runs the tier assertion: an unfrozen TIER_KIND is refused (R3)', async () => {
    process.env.REG_RUN_ID = RUN;
    delete process.env.TIER_KIND;
    await expect(runTeardown()).rejects.toThrow(/TIER_KIND is not frozen/);
});

test('the dry run prints the plan, never authenticates and sends no request (R27)', async ({}, testInfo) => {
    process.env.REG_RUN_ID = RUN;
    process.env.API_TEARDOWN_DRY_RUN = 'true'; // any truthy spelling (R4)
    process.env.BASE_URL = 'http://127.0.0.1:9'; // a closed loopback port: any request would fail loudly
    fs.mkdirSync(testInfo.outputPath('state'), { recursive: true });
    fs.writeFileSync(testInfo.outputPath('state', 'created-objects.jsonl'), [line('roles'), line('roles', { name: 'Administrator' })].map((l) => JSON.stringify(l)).join('\n'));
    let authenticated = 0;
    const authenticate = async (): Promise<never> => {
        authenticated++;
        throw new Error('the dry run must not authenticate');
    };
    await expect(runTeardown(undefined, { authenticate })).resolves.toBeUndefined();
    expect(authenticated).toBe(0);
    expect(readCleanupFailures()).toEqual([]);
});

test('an unknown dry-run value stops the teardown instead of deleting (R4)', async () => {
    process.env.REG_RUN_ID = RUN;
    process.env.API_TEARDOWN_DRY_RUN = 'please';
    await expect(runTeardown(undefined, { authenticate: async () => { throw new Error('no'); } })).rejects.toThrow(/API_TEARDOWN_DRY_RUN="please" is not a switch/);
});

test('under the dry run every delete path refuses: executeTeardown, removeOwnObject, each handler (R4)', async () => {
    process.env.API_TEARDOWN_DRY_RUN = 'yes';
    const role = line('roles');
    await expect(executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [role] })).rejects.toThrow(DryRunRefusal);
    await expect(removeOwnObject({ api: fakeApi, runId: RUN, ledger: [role] }, role)).rejects.toThrow(DryRunRefusal);
    const h = handlerFor('roles')!;
    const ctx = { api: fakeApi, runId: RUN, ledger: [role], seen: new Set<string>(), tier: null, warn: () => undefined };
    await expect(h.remove(ctx, role)).rejects.toThrow(DryRunRefusal);
});

test('a shared tier without a before snapshot fails the run-end check (R9)', async ({}, testInfo) => {
    process.env.REG_RUN_ID = RUN;
    process.env.BASE_URL = 'http://127.0.0.1:9';
    fs.mkdirSync(testInfo.outputPath('state'), { recursive: true });
    const authenticate = async () => ({ api: fakeApi, dispose: async () => undefined });
    await expect(runTeardown(undefined, { authenticate })).rejects.toThrow(/No before snapshot of this run on a shared tier/);
});

test('BASE_URL unset fails the run: a run without a tier tested nothing (Q11)', async () => {
    process.env.REG_RUN_ID = RUN;
    await expect(runTeardown(undefined, { authenticate: async () => { throw new Error('no request expected'); } })).rejects.toThrow(/BASE_URL is unset/);
    process.env.API_DELETE_OWN = '0';
    await expect(runTeardown()).rejects.toThrow(/BASE_URL is unset/);
});

test('kept objects go to the kept report; REG_KEPT_STRICT=1 fails the run on a non-empty list (Q6)', async ({}, testInfo) => {
    const key = line('keys', { name: 'certKey_x', derived: true, createdAfter: '2026-10-13T12:00:00.000Z' });
    const handler = (): TeardownHandler => ({ action: 'k', remove: async (ctx) => { ctx.warn('kept derived key: made before the run'); return 'kept'; } });
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [key], handler, onDeleted: () => undefined });
    expect(result.keptReasons[key.uuid]).toEqual(['kept derived key: made before the run']);
    const file = writeKeptReport(RUN, result)!;
    expect(file).toBe(testInfo.outputPath('state', `${RUN}.kept.json`));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).kept).toEqual([{ type: 'keys', uuid: key.uuid, reasons: ['kept derived key: made before the run'] }]);
    expect(writeKeptReport(RUN, { kept: [], keptReasons: {} }), 'nothing kept: no report, the stale one removed').toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
    process.env.REG_KEPT_STRICT = 'maybe';
    expect(() => isKeptStrict()).toThrow(/REG_KEPT_STRICT="maybe" is not a switch/);
    process.env.REG_KEPT_STRICT = '1';
    expect(isKeptStrict()).toBe(true);
});

test('API_DELETE_OWN=0 keeps the objects and still reports what specs failed to clean', async () => {
    process.env.REG_RUN_ID = RUN;
    process.env.BASE_URL = 'http://127.0.0.1:9';
    process.env.API_DELETE_OWN = '0';
    await expect(runTeardown()).resolves.toBeUndefined();
    fs.appendFileSync(process.env.CLEANUP_LEDGER_FILE!, `${JSON.stringify({ resource: 'k8s:Issuer', name: 'x', message: 'afterAll failed' })}\n`);
    await expect(runTeardown()).rejects.toThrow(/Cleanup did not complete/);
});

test('known bugs worked around during the deletes (core#2511) are collected and listed in the kept report (fix pass 3)', async ({}, testInfo) => {
    const role = line('roles');
    const handler = (): TeardownHandler => ({
        action: 'r',
        remove: async (ctx, l) => ctx.knownBug?.({ bug: 'core#2511', type: 'roles', uuid: l.uuid, note: 'detail answered 500 after the delete; absence confirmed through /api/v1/roles' }),
    });
    const deleted: string[] = [];
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [role], handler, onDeleted: (p) => void deleted.push(p.uuid) });
    expect(deleted, 'still a confirmed delete').toEqual([role.uuid]);
    expect(result.knownBugs).toEqual([expect.objectContaining({ bug: 'core#2511', uuid: role.uuid })]);
    const file = writeKeptReport(RUN, result)!;
    expect(file).toBe(testInfo.outputPath('state', `${RUN}.kept.json`));
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect([report.kept, report.knownBugs.map((k: { bug: string }) => k.bug)]).toEqual([[], ['core#2511']]);
});

test('the run-end teardown removes the run\'s local-backend proof on every path (fix pass 3)', async ({}, testInfo) => {
    process.env.REG_RUN_ID = RUN;
    fs.mkdirSync(testInfo.outputPath('state'), { recursive: true });
    const proof = localProofFile();
    fs.writeFileSync(proof, '{}');
    await expect(runTeardown(undefined, { authenticate: async () => { throw new Error('no request expected'); } })).rejects.toThrow(/BASE_URL is unset/);
    expect(fs.existsSync(proof), 'removed although the teardown failed').toBe(false);
    fs.writeFileSync(proof, '{}');
    process.env.BASE_URL = 'http://127.0.0.1:9';
    process.env.API_TEARDOWN_DRY_RUN = '1';
    await expect(runTeardown(undefined, { authenticate: async () => { throw new Error('no request expected'); } })).resolves.toBeUndefined();
    expect(fs.existsSync(proof), 'removed after the dry run').toBe(false);
});

test('known bugs of the setup and of the teardown reach the run summary through <run id>.kept.json (fix pass 4, wire)', async ({}, testInfo) => {
    process.env.REG_RUN_ID = RUN;
    const role = line('roles', { uuid: '00000000-0000-4000-8000-0000000000a1' });
    const detail = `/api/v1/roles/${role.uuid}`;
    let deleted = false;
    // A loopback core with core#2511: the own role reads before the delete; after it the detail answers 500 and the
    // full list (pre-existing rows only) no longer names it.
    const core = await loopbackServer((a) => {
        if (a.method === 'DELETE' && a.url === detail) {
            deleted = true;
            return { status: 204 };
        }
        if (a.method === 'GET' && a.url === detail) return deleted ? { status: 500, body: { message: 'Internal Server Error' } } : { status: 200, body: { uuid: role.uuid, name: role.name } };
        if (a.method === 'GET' && a.url === '/api/v1/roles') return { status: 200, body: [{ uuid: '00000000-0000-4000-8000-0000000000b2', name: 'Administrators' }] };
        return { status: 404, body: {} };
    });
    const raw = await request.newContext({ baseURL: core.origin });
    try {
        expect(runSummary(RUN, undefined)).toMatch(/known product bugs worked around: none/);
        // The setup's path (API-GEN-33[guard]): removeOwnObject with the default known-bug sink records it for the run.
        await removeOwnObject({ api: raw, runId: RUN, ledger: [role] }, role, 'API-GEN-33');
        expect(core.arrived.map((a) => `${a.method} ${a.url}`)).toEqual([`GET ${detail}`, `DELETE ${detail}`, `GET ${detail}`, 'GET /api/v1/roles']);
        expect(readKeptReport(RUN)?.knownBugs).toEqual([expect.objectContaining({ bug: 'core#2511', type: 'roles', uuid: role.uuid })]);
        // The teardown writes its own report later: the setup's note is kept, duplicates are not repeated.
        const teardownNote = { bug: 'core#2511', type: 'users', uuid: 'u-9', note: 'detail answered 500 after the delete; absence confirmed through /api/v1/users' };
        writeKeptReport(RUN, { kept: [], keptReasons: {}, knownBugs: [teardownNote] });
        recordKnownBug(teardownNote, RUN);
        expect(readKeptReport(RUN)?.knownBugs.map((k) => `${k.type} ${k.uuid}`)).toEqual([`roles ${role.uuid}`, 'users u-9']);
        const summary = runSummary(RUN, { deleted: 1, kept: 0, failed: 0 });
        expect(summary).toMatch(new RegExp(`run summary ${RUN}: deleted 1, kept 0, failed 0`));
        expect(summary).toMatch(/known product bugs worked around \(2, .*kept\.json\):/);
        expect(summary).toContain(`core#2511: roles ${role.uuid}`);
        expect(summary).toContain('core#2511: users u-9');
        // Another run's report is never read.
        expect(readKeptReport('qa-reg-20261013-120000-zz99')).toBeUndefined();
        expect(testInfo.outputPath('state', `${RUN}.kept.json`)).toBe(writeKeptReport(RUN, { kept: [], keptReasons: {} }));
    } finally {
        await raw.dispose();
        await core.close();
    }
});

// ------------------------------------------------------------------ guard-integration pass: GD-04 (events G-1 + review), G2 hooks, G3 kept

test('GD-04 u1: DELETE_ORDER pins the workflow step as triggers → rules → conditions → actions → executions, then notification profiles → instances', () => {
    const workflow = DELETE_ORDER.find((s) => s.types.includes('triggers'))!;
    expect(workflow.types).toEqual(['triggers', 'rules', 'conditions', 'actions', 'executions']);
    expect(workflow.label).toBe('triggers → rules → conditions → actions → executions');
    const notification = DELETE_ORDER.find((s) => s.types.includes('notificationProfiles'))!;
    expect(notification.types).toEqual(['notificationProfiles', 'notificationInstances']);
    expect(notification.step).toBeGreaterThan(workflow.step);
    // Mutant: executions before actions, or the notification step before the workflow step, breaks the rows below too.
    expect(deletedBefore('actions', 'executions')).toBe(true);
    expect(deletedBefore('executions', 'actions')).toBe(false);
    expect(deletedBefore('executions', 'notificationProfiles')).toBe(true);
    expect(deletedBefore('notificationProfiles', 'notificationInstances')).toBe(true);
    // Review F5 / platform G-1: certificates → keys → key items → … → token profiles → tokens.
    expect([stepOf('certificates'), stepOf('keys'), stepOf('keyItems'), stepOf('tokenProfiles'), stepOf('tokens')]).toEqual([4, 5, 6, 11, 11]);
    expect(deletedBefore('tokenProfiles', 'tokens')).toBe(true);
});

test('GD-04 u2: the reference graph core enforces (REFERENCED_BY, each pair with its core citation) is satisfied by DELETE_ORDER', () => {
    expect(REFERENCED_BY.length).toBeGreaterThanOrEqual(12);
    const wrong = REFERENCED_BY.filter((p) => !deletedBefore(p.b, p.a)).map((p) => `${p.b} must be deleted before ${p.a} (${p.core})`);
    expect(wrong).toEqual([]);
    for (const p of REFERENCED_BY) expect(p.core, `${p.a} ← ${p.b} cites core or the handler order`).toMatch(/\.java:\d+|handler order/);
    // Every pair names types the table knows.
    const known = new Set(DELETE_ORDER.flatMap((s) => s.types));
    for (const p of REFERENCED_BY) expect(known.has(p.a) && known.has(p.b), `${p.a} / ${p.b} are in DELETE_ORDER`).toBe(true);
});

test('GD-04 u4: every type with a handler module is in exactly one DELETE_ORDER step; every live-read / id-named ledger type has a step', () => {
    const counts = new Map<string, number>();
    for (const s of DELETE_ORDER) for (const t of s.types) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const t of Object.keys(HANDLER_MODULES)) expect(counts.get(t), `${t} appears once`).toBe(1);
    for (const t of [...Object.keys(LIVE_READS), ...ID_NAMED]) expect(counts.get(t), `${t} has a step`).toBe(1);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(DELETE_ORDER.map((s) => s.step)).toEqual(DELETE_ORDER.map((_s, i) => i + 1));
});

/** A fake core that applies core's reference refusals (422 while a dependant exists) to a full workflow / notification chain. */
function chainCore(): { handler: (type: string) => TeardownHandler | undefined; deleted: string[] } {
    const deleted: string[] = [];
    const refs: Record<string, string[]> = {
        executions: ['actions'], actions: ['triggers'], rules: ['triggers'], conditions: ['rules'], triggers: ['eventAssociations'],
        notificationProfiles: ['executions'], notificationInstances: ['notificationProfiles'],
    };
    const alive = new Set(['eventAssociations', 'triggers', 'rules', 'conditions', 'actions', 'executions', 'notificationProfiles', 'notificationInstances']);
    const handler = (type: string): TeardownHandler | undefined => (alive.has(type) || deleted.includes(type) ? {
        action: `delete ${type}`,
        remove: async (_ctx, l) => {
            const blocker = (refs[type] ?? []).find((b) => alive.has(b));
            if (blocker) throw new Error(`422 - ["Cannot delete ${type} ${l.name}. It is associated to following ${blocker}: x"]`);
            alive.delete(type);
            deleted.push(type);
        },
    } : undefined);
    return { handler, deleted };
}

test('GD-04 u3: a full trigger / rule / condition / action / execution / notification profile / instance chain against a core that refuses out-of-order deletes: all deleted, 0 kept, 0 failed', async () => {
    const lines = ['notificationInstances', 'notificationProfiles', 'executions', 'actions', 'conditions', 'rules', 'triggers', 'eventAssociations'].map((t) => line(t));
    const { handler, deleted } = chainCore();
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => lines, handler, onDeleted: () => undefined, preSteps: [] });
    expect(result.failed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(deleted).toEqual(['eventAssociations', 'triggers', 'rules', 'conditions', 'actions', 'executions', 'notificationProfiles', 'notificationInstances']);
    expect(readCleanupFailures()).toEqual([]);
});

test('G2 hooks: a pre-step runs once before its step with a fresh context, only when `when` says so; its failure is a cleanup failure and the step still runs', async () => {
    const lines = [line('certificates'), line('roles')];
    const order: string[] = [];
    const handler = (type: string): TeardownHandler | undefined => ({ action: type, remove: async () => void order.push(type) });
    let contexts = 0;
    const newApi = async () => {
        contexts++;
        return fakeApi;
    };
    const hooks: PreStep[] = [
        { before: stepOf('certificates'), name: 'ungate', when: (l) => l.some((x) => x.type === 'certificates'), run: async () => void order.push('hook:ungate') },
        { before: stepOf('certificates'), name: 'skipped', when: () => false, run: async () => void order.push('hook:skipped') },
        { before: stepOf('roles'), name: 'boom', when: () => true, run: async () => { throw new Error('refused by core'); } },
    ];
    const result = await executeTeardown({ ...quick, runId: RUN, newApi, readLines: () => lines, handler, onDeleted: () => undefined, preSteps: hooks });
    expect(order).toEqual(['hook:ungate', 'certificates', 'roles']);
    expect(contexts, 'one context per hook that ran, one per object').toBe(4);
    expect(result.failed).toEqual([]);
    expect(result.warnings).toEqual([expect.stringMatching(/pre-step "boom" failed: refused by core/)]);
    expect(readCleanupFailures()).toEqual([expect.objectContaining({ resource: 'pre-step:boom', message: expect.stringMatching(/refused by core/) })]);
    // The default hook: the G2 ungate before the certificate step, applicable only with own approval profiles AND RA profiles.
    const [ungate] = defaultPreSteps();
    expect(ungate.before).toBe(stepOf('certificates'));
    expect(ungate.when([line('approvalProfiles'), line('raProfiles')], RUN)).toBe(true);
    expect(ungate.when([line('approvalProfiles')], RUN)).toBe(false);
    expect(ungate.when([line('raProfiles')], RUN)).toBe(false);
    // Without applicable hooks no context is opened for them (the existing R10 rows count contexts per object only).
    contexts = 0;
    await executeTeardown({ ...quick, runId: RUN, newApi, readLines: () => [line('roles')], handler, onDeleted: () => undefined });
    expect(contexts).toBe(1);
});

test('G3: approvals / approval profiles the platform retains may be answered `kept` — a warning and a kept-report line, never a failure; REG_KEPT_STRICT=1 turns it red', async ({}, testInfo) => {
    const ap = line('approvalProfiles');
    const approval = line('approvals');
    const handler = (type: string): TeardownHandler | undefined => ({ action: type, remove: async () => 'kept' as const });
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [ap, approval], handler, onDeleted: () => undefined, preSteps: [] });
    expect(result.kept.map((k) => k.type)).toEqual(['approvals', 'approvalProfiles']);
    expect(result.failed).toEqual([]);
    expect(readCleanupFailures()).toEqual([]);
    const file = writeKeptReport(RUN, result, { REG_STATE_DIR: testInfo.outputPath('state') });
    expect(readKeptReport(RUN, { REG_STATE_DIR: testInfo.outputPath('state') })?.kept.map((k) => k.type)).toEqual(['approvals', 'approvalProfiles']);
    expect(file).toBeDefined();
    expect(isKeptStrict({ REG_KEPT_STRICT: '1' })).toBe(true);
});
