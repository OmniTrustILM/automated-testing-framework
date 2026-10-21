/**
 * The run-end teardown with fake handlers and no environment: the delete order and its reference graph, refusal of
 * anything the guard does not accept (another tier included), cascade reporting, the ledger re-read between steps, a
 * fresh context per object, kept objects, the run-id checks, the dry run on every path, the cleanup report text, and a
 * missing before snapshot on a shared tier.
 */
import { randomUUID } from 'node:crypto';
import { APIRequestContext, request, test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { CleanupFailure, readCleanupFailures, formatCleanupReport } from '../../utils/cleanupLedger';
import { DryRunRefusal } from '../../utils/regression/run/flags';
import { LedgerLine } from '../../utils/regression/ledger/ledger';
import { localProofFile } from '../../utils/regression/tier/localProof';
import runTeardown, {
    defaultPrepSteps, DELETE_ORDER, isDeletedBefore, executeTeardown, formatPlan, HANDLER_MODULES, handlerOf, isKeptStrict, loadHandlers, planTeardown, PlanItem,
    TeardownPrepStep, readKeptReport, reauthenticating, recordWorkaround, REFERENCED_BY, removeOwnObject, formatRunSummary, deleteStepOf, TeardownHandler, writeKeptReport,
    resetHandlerModulesForTests, FINAL_PASS_NOTE, isRetryableFailure, wrapHandlerWithGuard,
} from '../../utils/regression/teardown/runTeardown';
import { ID_NAMED, LIVE_READS } from '../../utils/regression/ledger/ownership';
import { loopbackServer } from './helpers/loopbackServer';

// Each test loads the handler modules afresh (a test may register a module of its own).
test.afterEach(() => resetHandlerModulesForTests());

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
    expect(readCleanupFailures()[0].name, 'a refused object is reported without its name').toBeUndefined();
    expect(formatPlan(plan)).not.toContain('Administrator');
    expect(formatPlan(plan)).toContain('(name withheld)');
});

test('a line recorded on another tier, or without a tier identity, is refused when the tier is known', () => {
    const here = line('roles', { tier: 'aaaaaaaaaaaa' });
    const there = line('roles', { tier: 'bbbbbbbbbbbb' });
    const legacy = line('roles');
    const plan = planTeardown([here, there, legacy], RUN, recorder().handler, { tier: 'aaaaaaaaaaaa' });
    expect(plan.find((p) => p.uuid === here.uuid)?.refused).toBeUndefined();
    expect(plan.find((p) => p.uuid === there.uuid)?.refused).toMatch(/another tier/);
    expect(plan.find((p) => p.uuid === legacy.uuid)?.refused).toMatch(/no tier identity/);
});

test('every object gets a fresh authenticated context, disposed after its step', async () => {
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

test('the post-delete context authenticates again once on a 401 and retries', async () => {
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

test('every HANDLER_MODULES module that exists resolves every type it registers (37 types in the full tree)', () => {
    const dir = path.join(__dirname, '../../utils/regression');
    const present = Object.entries(HANDLER_MODULES).filter(([, module]) => fs.existsSync(path.join(dir, `${module}.ts`)));
    expect(present.length, 'every registered module file is in this tree').toBe(Object.keys(HANDLER_MODULES).length);
    expect(present.length, 'registered ledger types').toBe(37);
    for (const [type, module] of present) {
        expect(loadHandlers(module)?.[type], `${module} exports the ${type} handler`).toBeDefined();
        expect(handlerOf(type), `handlerOf(${type})`).toBeDefined();
    }
});

test('an absent handler module means "no handler"; a module that fails to load throws', async ({}, testInfo) => {
    const dir = path.join(__dirname, '../../utils/regression');
    const out = testInfo.outputPath('handlers');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'brokenDependency.js'), "require('./no-such-dependency');\nexports.teardownHandlers = {};\n");
    fs.writeFileSync(path.join(out, 'throwsOnLoad.js'), "throw new Error('module body failed');\n");
    const rel = (name: string): string => path.relative(dir, path.join(out, name));
    expect(handlerOf('stackedType', { stackedType: rel('absentArea') }), 'absent module file').toBeUndefined();
    expect(() => handlerOf('stackedType', { stackedType: rel('brokenDependency') }), 'a missing dependency is not an absent module').toThrow(/no-such-dependency/);
    expect(() => handlerOf('stackedType', { stackedType: rel('throwsOnLoad') })).toThrow(/module body failed/);
});

test('"no handler (type X)" is reported only for types that have ledger lines', async () => {
    // Never a real area module name here (lifecycle / workflowUtils arrive with their areas).
    expect(loadHandlers('a-module-that-never-exists'), 'a module that does not exist').toBeUndefined();
    expect(handlerOf('roles')?.action, 'the core types resolve to teardownHandlers').toMatch(/DELETE \/api\/v1\/roles/);
    expect(handlerOf('unregisteredType'), 'a type without a registry entry has no handler').toBeUndefined();

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
    // both are retried once in the final pass (still failing): one record each, the blocker kept
    const failures = readCleanupFailures();
    expect(failures).toHaveLength(2);
    expect(failures.find((f) => f.uuid === cert.uuid)).toMatchObject({ resource: 'certificates', uuid: cert.uuid, status: 503, blockedBy: 'authority a-1' });
    expect(failures.find((f) => f.uuid === ra.uuid)).toMatchObject({ resource: 'raProfiles', uuid: ra.uuid, status: 422, blockedBy: `certificates ${cert.uuid}` });
});

// the ledger is re-read before each step: a derived line added by a discovery is deleted in the certificate step
test('the ledger is re-read before each step: a derived line from a discovery is deleted', async () => {
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

test('a handler that answers "kept" leaves no deleted line and no failure, but a warning', async () => {
    const key = line('keys', { name: 'certKey_x', derived: true, createdAfter: '2026-10-13T12:00:00.000Z' });
    const handler = (): TeardownHandler => ({ action: 'k', remove: async () => 'kept' });
    const deleted: string[] = [];
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [key], handler, onDeleted: (p) => deleted.push(p.uuid) });
    expect(result.kept.map((k) => k.uuid)).toEqual([key.uuid]);
    expect(result.warnings).toEqual([expect.stringMatching(new RegExp(`^kept keys ${key.uuid}`))]);
    expect(deleted).toEqual([]);
    expect(readCleanupFailures()).toEqual([]);
});

test('the teardown refuses both adhoc run ids and an API_RUN_ID that differs', async () => {
    process.env.REG_RUN_ID = 'qa-reg-adhoc';
    await expect(runTeardown()).rejects.toThrow(/adhoc default .* refusing to delete anything/);
    process.env.REG_RUN_ID = RUN;
    process.env.API_RUN_ID = 'qa-api-adhoc';
    await expect(runTeardown()).rejects.toThrow(/refusing to delete anything/);
    process.env.API_RUN_ID = 'qa-reg-20261013-120000-zz99';
    await expect(runTeardown()).rejects.toThrow(/API_RUN_ID differs/);
});

test('the teardown re-runs the tier assertion: an unfrozen TIER_KIND is refused', async () => {
    process.env.REG_RUN_ID = RUN;
    delete process.env.TIER_KIND;
    await expect(runTeardown()).rejects.toThrow(/TIER_KIND is not frozen/);
});

test('the dry run prints the plan, never authenticates and sends no request', async ({}, testInfo) => {
    process.env.REG_RUN_ID = RUN;
    process.env.API_TEARDOWN_DRY_RUN = 'true'; // any truthy spelling
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

test('an unknown dry-run value stops the teardown instead of deleting', async () => {
    process.env.REG_RUN_ID = RUN;
    process.env.API_TEARDOWN_DRY_RUN = 'please';
    await expect(runTeardown(undefined, { authenticate: async () => { throw new Error('no'); } })).rejects.toThrow(/API_TEARDOWN_DRY_RUN="please" is not a switch/);
});

test('under the dry run every delete path refuses: executeTeardown, removeOwnObject, each handler', async () => {
    process.env.API_TEARDOWN_DRY_RUN = 'yes';
    const role = line('roles');
    await expect(executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [role] })).rejects.toThrow(DryRunRefusal);
    await expect(removeOwnObject({ api: fakeApi, runId: RUN, ledger: [role] }, role)).rejects.toThrow(DryRunRefusal);
    const h = handlerOf('roles')!;
    const ctx = { api: fakeApi, runId: RUN, ledger: [role], seen: new Set<string>(), tier: null, warn: () => undefined };
    await expect(h.remove(ctx, role)).rejects.toThrow(DryRunRefusal);
});

test('a shared tier without a before snapshot fails the run-end check', async ({}, testInfo) => {
    process.env.REG_RUN_ID = RUN;
    process.env.BASE_URL = 'http://127.0.0.1:9';
    fs.mkdirSync(testInfo.outputPath('state'), { recursive: true });
    const authenticate = async () => ({ api: fakeApi, dispose: async () => undefined });
    await expect(runTeardown(undefined, { authenticate })).rejects.toThrow(/No before snapshot of this run on a shared tier/);
});

test('BASE_URL unset fails the run: a run without a tier tested nothing', async () => {
    process.env.REG_RUN_ID = RUN;
    await expect(runTeardown(undefined, { authenticate: async () => { throw new Error('no request expected'); } })).rejects.toThrow(/BASE_URL is unset/);
    process.env.API_DELETE_OWN = '0';
    await expect(runTeardown()).rejects.toThrow(/BASE_URL is unset/);
});

test('kept objects go to the kept report; REG_KEPT_STRICT=1 fails the run on a non-empty list', async ({}, testInfo) => {
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

// known bugs worked around during the deletes (the role / user detail-500 case) are collected and listed in the kept report
test('known bugs worked around during the deletes are collected and listed in the kept report', async ({}, testInfo) => {
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

test('the run-end teardown removes the run\'s local-backend proof on every path', async ({}, testInfo) => {
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

test('known bugs of the setup and of the teardown reach the run summary through <run id>.kept.json (wire)', async ({}, testInfo) => {
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
        expect(formatRunSummary(RUN, undefined)).toMatch(/known product bugs worked around: none/);
        // The setup's path (API-GEN-33[guard]): removeOwnObject with the default known-bug sink records it for the run.
        await removeOwnObject({ api: raw, runId: RUN, ledger: [role] }, role, 'API-GEN-33');
        expect(core.arrived.map((a) => `${a.method} ${a.url}`)).toEqual([`GET ${detail}`, `DELETE ${detail}`, `GET ${detail}`, 'GET /api/v1/roles']);
        expect(readKeptReport(RUN)?.knownBugs).toEqual([expect.objectContaining({ bug: 'core#2511', type: 'roles', uuid: role.uuid })]);
        // The teardown writes its own report later: the setup's note is kept, duplicates are not repeated.
        const teardownNote = { bug: 'core#2511', type: 'users', uuid: 'u-9', note: 'detail answered 500 after the delete; absence confirmed through /api/v1/users' };
        writeKeptReport(RUN, { kept: [], keptReasons: {}, knownBugs: [teardownNote] });
        recordWorkaround(teardownNote, RUN);
        expect(readKeptReport(RUN)?.knownBugs.map((k) => `${k.type} ${k.uuid}`)).toEqual([`roles ${role.uuid}`, 'users u-9']);
        const summary = formatRunSummary(RUN, { deleted: 1, kept: 0, failed: 0 });
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

// ------------------------------------------------------------------ delete order, pre-step hooks, kept approvals

// DELETE_ORDER pins the workflow step as triggers → rules → conditions → actions → executions, then notification profiles →
// instances
test('DELETE_ORDER pins the workflow step order from triggers to executions, then notification profiles', () => {
    const workflow = DELETE_ORDER.find((s) => s.types.includes('triggers'))!;
    expect(workflow.types).toEqual(['triggers', 'rules', 'conditions', 'actions', 'executions']);
    expect(workflow.label).toBe('triggers → rules → conditions → actions → executions');
    const notification = DELETE_ORDER.find((s) => s.types.includes('notificationProfiles'))!;
    expect(notification.types).toEqual(['notificationProfiles', 'notificationInstances']);
    expect(notification.step).toBeGreaterThan(workflow.step);
    // Mutant: executions before actions, or the notification step before the workflow step, breaks the rows below too.
    expect(isDeletedBefore('actions', 'executions')).toBe(true);
    expect(isDeletedBefore('executions', 'actions')).toBe(false);
    expect(isDeletedBefore('executions', 'notificationProfiles')).toBe(true);
    expect(isDeletedBefore('notificationProfiles', 'notificationInstances')).toBe(true);
    // Platform order: certificates → keys → key items → … → token profiles → tokens.
    expect([deleteStepOf('certificates'), deleteStepOf('keys'), deleteStepOf('keyItems'), deleteStepOf('tokenProfiles'), deleteStepOf('tokens')]).toEqual([4, 5, 6, 11, 11]);
    expect(isDeletedBefore('tokenProfiles', 'tokens')).toBe(true);
});

// the reference graph core enforces (REFERENCED_BY, each pair with its core citation) is satisfied by DELETE_ORDER
test('the reference graph core enforces (REFERENCED_BY, each pair cited) is satisfied by DELETE_ORDER', () => {
    expect(REFERENCED_BY.length).toBeGreaterThanOrEqual(12);
    const wrong = REFERENCED_BY.filter((p) => !isDeletedBefore(p.b, p.a)).map((p) => `${p.b} must be deleted before ${p.a} (${p.core})`);
    expect(wrong).toEqual([]);
    for (const p of REFERENCED_BY) expect(p.core, `${p.a} ← ${p.b} cites core or the handler order`).toMatch(/\.java:\d+|handler order/);
    // Every pair names types the table knows.
    const known = new Set(DELETE_ORDER.flatMap((s) => s.types));
    for (const p of REFERENCED_BY) expect(known.has(p.a) && known.has(p.b), `${p.a} / ${p.b} are in DELETE_ORDER`).toBe(true);
});

// every type with a handler module is in exactly one DELETE_ORDER step; every live-read / id-named ledger type has a step
test('every type with a handler module is in exactly one DELETE_ORDER step; read types have one', () => {
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

// a full trigger / rule / condition / action / execution / notification profile / instance chain against a core that refuses
// out-of-order deletes: all deleted, 0 kept, 0 failed
test('a full workflow chain against a core refusing out-of-order deletes: all deleted, 0 kept, 0 failed', async () => {
    const lines = ['notificationInstances', 'notificationProfiles', 'executions', 'actions', 'conditions', 'rules', 'triggers', 'eventAssociations'].map((t) => line(t));
    const { handler, deleted } = chainCore();
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => lines, handler, onDeleted: () => undefined, preSteps: [] });
    expect(result.failed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(deleted).toEqual(['eventAssociations', 'triggers', 'rules', 'conditions', 'actions', 'executions', 'notificationProfiles', 'notificationInstances']);
    expect(readCleanupFailures()).toEqual([]);
});

// pre-step hooks: a pre-step runs once before its step with a fresh context, only when `when` says so; its failure is a cleanup
// failure and the step still runs
test('pre-step hooks run once before their step with a fresh context; a failure is a cleanup failure', async () => {
    const lines = [line('certificates'), line('roles')];
    const order: string[] = [];
    const handler = (type: string): TeardownHandler | undefined => ({ action: type, remove: async () => void order.push(type) });
    let contexts = 0;
    const newApi = async () => {
        contexts++;
        return fakeApi;
    };
    const hooks: TeardownPrepStep[] = [
        { before: deleteStepOf('certificates'), name: 'ungate', when: (l) => l.some((x) => x.type === 'certificates'), run: async () => void order.push('hook:ungate') },
        { before: deleteStepOf('certificates'), name: 'skipped', when: () => false, run: async () => void order.push('hook:skipped') },
        { before: deleteStepOf('roles'), name: 'boom', when: () => true, run: async () => { throw new Error('refused by core'); } },
    ];
    const result = await executeTeardown({ ...quick, runId: RUN, newApi, readLines: () => lines, handler, onDeleted: () => undefined, preSteps: hooks });
    expect(order).toEqual(['hook:ungate', 'certificates', 'roles']);
    expect(contexts, 'one context per hook that ran, one per object').toBe(4);
    expect(result.failed).toEqual([]);
    expect(result.warnings).toEqual([expect.stringMatching(/pre-step "boom" failed: refused by core/)]);
    expect(readCleanupFailures()).toEqual([expect.objectContaining({ resource: 'pre-step:boom', message: expect.stringMatching(/refused by core/) })]);
    // The default hook: the approval ungate before the certificate step, applicable only with own approval profiles AND RA profiles.
    const [ungate] = defaultPrepSteps();
    expect(ungate.before).toBe(deleteStepOf('certificates'));
    expect(ungate.when([line('approvalProfiles'), line('raProfiles')], RUN)).toBe(true);
    expect(ungate.when([line('approvalProfiles')], RUN)).toBe(false);
    expect(ungate.when([line('raProfiles')], RUN)).toBe(false);
    // Without applicable hooks no context is opened for them (the existing fresh-context rows count contexts per object only).
    contexts = 0;
    await executeTeardown({ ...quick, runId: RUN, newApi, readLines: () => [line('roles')], handler, onDeleted: () => undefined });
    expect(contexts).toBe(1);
});

// approvals / approval profiles the platform retains may be answered `kept` — a warning and a kept-report line, never a
// failure; REG_KEPT_STRICT=1 turns it red
test('approvals the platform retains may be answered kept, as a warning; REG_KEPT_STRICT=1 turns it red', async ({}, testInfo) => {
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

// importing runTeardown loads no env file: utils/env.ts (which loads the dotenv file when imported) is required only when the
// teardown authenticates
test('importing runTeardown loads no env file; utils/env.ts is required only when authenticating', ({}, testInfo) => {
    const utilsRoot = path.resolve(__dirname, '../../utils') + path.sep;
    const ours = (k: string) => k.startsWith(utilsRoot);
    const saved = Object.entries(require.cache).filter(([k]) => ours(k));
    const marker = `QA_UNIT_ENV_MARKER_${process.pid}`;
    const envFile = testInfo.outputPath('marker.env');
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, `${marker}=read\n`);
    const before = process.env.REG_ENV_FILE;
    for (const [k] of saved) delete require.cache[k];
    try {
        process.env.REG_ENV_FILE = envFile;
        require('../../utils/regression/teardown/runTeardown');
        expect(Object.keys(require.cache), 'utils/env.ts is not loaded by the import').not.toContain(require.resolve('../../utils/env'));
        expect(process.env[marker], 'the env file was not read').toBeUndefined();
    } finally {
        if (before === undefined) delete process.env.REG_ENV_FILE;
        else process.env.REG_ENV_FILE = before;
        delete process.env[marker];
        for (const k of Object.keys(require.cache)) if (ours(k)) delete require.cache[k];
        for (const [k, v] of saved) require.cache[k] = v;
    }
    // The source keeps the require inside authenticatedApi (no top-level import of the env module).
    const src = fs.readFileSync(path.resolve(__dirname, '../../utils/regression/teardown/runTeardown.ts'), 'utf8');
    expect(src).not.toMatch(/^import [^;]*from '\.\.\/env';/m);
});

// ------------------------------------------------------------------ the cleanup report and the run summary keep the full error text; the compliance-profile delete order

const PROFILE = 'bbbbbbbb-0000-4000-8000-000000000001';

const WRAPPER = randomUUID();

// failures keep the full error text: the cleanup report prints the message under the object line, the run summary lists every
// failed removal with its text
test('failures keep the full error text in the cleanup report and the run summary', () => {
    const report = formatCleanupReport([{ resource: 'complianceProfiles', uuid: PROFILE, name: 'own', message: 'Error: Failed to delete compliance profile: 422 - Object is associated with other items' }]);
    expect(report).toContain('no status');
    expect(report).toContain('Object is associated with other items');
    const summary = formatRunSummary('qa-reg-20261015-150211-162d', { deleted: 1, kept: 0, failed: 1 }, { REG_STATE_DIR: '/nonexistent' } as NodeJS.ProcessEnv,
        [{ resource: 'complianceProfiles', uuid: PROFILE, message: 'boom  with\nnewlines' }, { resource: 'keys', uuid: WRAPPER }]);
    expect(summary).toContain(`failed complianceProfiles ${PROFILE}: boom with newlines`);
    expect(summary).toContain(`failed keys ${WRAPPER}: (no error text)`);
});

// dangling association: DELETE_ORDER deletes compliance profiles BEFORE RA profiles (a deleted RA profile leaves a dangling
// association, a suspected core defect); the pair is in REFERENCED_BY; approval profiles stay valid
test('dangling association: compliance profiles are deleted before RA profiles (REFERENCED_BY pair)', () => {
    expect(isDeletedBefore('complianceProfiles', 'raProfiles')).toBe(true);
    expect(isDeletedBefore('raProfiles', 'complianceProfiles')).toBe(false);
    expect(REFERENCED_BY.some((r) => r.a === 'raProfiles' && r.b === 'complianceProfiles' && /suspected defect/.test(r.core))).toBe(true);
    const step = DELETE_ORDER.find((x) => x.types.includes('complianceProfiles'))!;
    expect(step.types.indexOf('complianceProfiles')).toBeLessThan(step.types.indexOf('raProfiles'));
    // The other edges around it hold: certificates → RA profiles, RA profiles → authorities, approval profiles stay after their RA profiles (ungated by the pre-step).
    expect(isDeletedBefore('certificates', 'raProfiles')).toBe(true);
    expect(isDeletedBefore('raProfiles', 'authorities')).toBe(true);
    expect(isDeletedBefore('approvals', 'approvalProfiles')).toBe(true);
});

// ------------------------------------------------------------------ the final retry pass

/** A certificate that core refuses (500) while an own SCEP profile still references it (live: API-PROT-35, step 4 before step 7). */
function referencedCertificate(): { cert: LedgerLine; scep: LedgerLine; handler: (type: string) => TeardownHandler | undefined; calls: string[]; state: { scepGone: boolean } } {
    const cert = line('certificates');
    const scep = line('acmeProfiles'); // a step-7 type of the recorder set
    const state = { scepGone: false };
    const calls: string[] = [];
    const handler = (type: string): TeardownHandler | undefined => ({
        action: type,
        remove: async (_ctx, l) => {
            calls.push(`${l.type}:${l.uuid}`);
            if (l.uuid === scep.uuid) state.scepGone = true;
            if (l.uuid === cert.uuid && !state.scepGone) throw new Error(`Failed to delete certificate ${cert.uuid}: 500 - still referenced`);
        },
    });
    return { cert, scep, handler, calls, state };
}

test('final pass: a certificate that fails in step 4 and is free once the step-7 profile is gone is deleted then; the run is green', async () => {
    const { cert, scep, handler, calls } = referencedCertificate();
    const deleted: Array<[string, string | undefined]> = [];
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [cert, scep], handler, onDeleted: (p, note) => void deleted.push([p.uuid, note]), preSteps: [] });
    expect(calls).toEqual([`certificates:${cert.uuid}`, `certificates:${cert.uuid}`, `acmeProfiles:${scep.uuid}`, `certificates:${cert.uuid}`]);
    expect(deleted).toEqual([[scep.uuid, undefined], [cert.uuid, FINAL_PASS_NOTE]]);
    expect(result.failed).toEqual([]);
    expect(result.finalPass).toEqual({ retried: 1, deleted: 1 });
    expect(readCleanupFailures(), 'the run is green: no failure left').toEqual([]);
});

test('final pass: an object that still fails is reported once as failed, with both attempts; oldest failure first', async () => {
    const a = line('certificates');
    const b = line('raProfiles');
    const order: string[] = [];
    const handler = (type: string): TeardownHandler => ({ action: type, remove: async (_c, l) => { order.push(l.uuid); throw new Error(`Failed to delete ${l.uuid}: 503 - attempt ${order.filter((u) => u === l.uuid).length}`); } });
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [a, b], handler, onDeleted: () => undefined, preSteps: [] });
    expect(order, 'two first attempts each (attemptCleanup), then the pass oldest failure first').toEqual([a.uuid, a.uuid, b.uuid, b.uuid, a.uuid, b.uuid]);
    expect(result.failed.map((f) => f.uuid)).toEqual([a.uuid, b.uuid]);
    expect(result.finalPass).toEqual({ retried: 2, deleted: 0 });
    const failures = readCleanupFailures();
    expect(failures.filter((f) => f.uuid === a.uuid), 'one record per object').toHaveLength(1);
    expect(failures.find((f) => f.uuid === a.uuid)).toMatchObject({ resource: 'certificates', status: 503, message: expect.stringMatching(/^first attempt: .*attempt 2 \| final pass: .*attempt 3$/) });
    expect(formatRunSummary(RUN, { deleted: 0, kept: 0, failed: result.failed.length }, process.env, failures)).toContain('final pass: ');
});

test('final pass: kept objects, refused lines, types without a handler and "route or object missing" never enter it', async () => {
    const kept = line('keys', { name: 'certKey_x', derived: true, createdAfter: '2026-10-13T12:00:00.000Z' });
    const missing = line('certificates');
    const foreign = line('roles', { name: 'Administrator' });
    const unhandled = line('notARealType');
    const calls: string[] = [];
    const handler = (type: string): TeardownHandler | undefined => type === 'notARealType' ? undefined : ({
        action: type,
        remove: async (_c, l) => {
            calls.push(l.uuid);
            if (l.uuid === kept.uuid) return 'kept';
            throw new Error(`certificates ${l.uuid}: route or object missing (GET answered 404)`);
        },
    });
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [kept, missing, foreign, unhandled], handler, onDeleted: () => undefined, preSteps: [] });
    expect(calls, 'no third attempt for the missing object, none for the others').toEqual([missing.uuid, missing.uuid, kept.uuid]);
    expect(result.finalPass).toEqual({ retried: 0, deleted: 0 });
    expect(result.kept.map((k) => k.uuid)).toEqual([kept.uuid]);
    expect(result.failed.map((f) => f.uuid).sort()).toEqual([missing.uuid, foreign.uuid, unhandled.uuid].sort());
    expect(isRetryableFailure('x: route or object missing (y)')).toBe(false);
    expect(isRetryableFailure('Failed to delete: 500 - boom')).toBe(true);
});

test('final pass: a renamed (foreign) object is still refused by the guard; the inner handler is not called again', async () => {
    const cert = line('certificates');
    const scep = line('acmeProfiles');
    const live = { name: cert.name };
    const inner: string[] = [];
    const guarded = wrapHandlerWithGuard('certificates', { action: 'c', remove: async () => { inner.push('call'); throw new Error('Failed to delete: 500 - referenced'); } });
    const handler = (type: string): TeardownHandler => type === 'certificates' ? guarded : ({ action: type, remove: async () => { live.name = 'renamed-by-someone'; } });
    const api = {
        get: async () => ({ status: () => 200, ok: () => true, json: async () => ({ uuid: cert.uuid, commonName: live.name }) }),
        dispose: async () => undefined,
    } as unknown as APIRequestContext;
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => api, readLines: () => [cert, scep], handler, onDeleted: () => undefined, preSteps: [] });
    expect(inner, 'two first attempts reached the handler; the pass stopped at the live-name guard').toEqual(['call', 'call']);
    expect(result.failed.map((f) => f.uuid)).toEqual([cert.uuid]);
    expect(result.finalPass).toEqual({ retried: 1, deleted: 0 });
    expect(readCleanupFailures().find((f) => f.uuid === cert.uuid)?.message).toMatch(/final pass: .*live name does not start with/);
});

test('final pass: under the dry run (switched on during the teardown) it sends nothing and the failure stays', async () => {
    const { cert, scep, calls, state } = referencedCertificate();
    let contexts = 0;
    const handler = (type: string): TeardownHandler => ({
        action: type,
        remove: async (_c, l) => {
            calls.push(`${l.type}:${l.uuid}`);
            if (l.uuid === scep.uuid) {
                state.scepGone = true;
                process.env.API_TEARDOWN_DRY_RUN = 'yes';
            }
            if (l.uuid === cert.uuid && !state.scepGone) throw new Error('Failed to delete certificate: 500 - still referenced');
        },
    });
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => { contexts += 1; return fakeApi; }, readLines: () => [cert, scep], handler, onDeleted: () => undefined, preSteps: [] });
    expect(contexts, 'one context per object of the steps, none for the pass').toBe(2);
    expect(calls.filter((c) => c.startsWith('certificates')), 'no pass attempt').toHaveLength(2);
    expect(result.finalPass).toEqual({ retried: 0, deleted: 0 });
    expect(result.failed.map((f) => f.uuid)).toEqual([cert.uuid]);
    expect(result.warnings).toContainEqual(expect.stringMatching(/final pass skipped under the dry run/));
});

test('final pass: a cascade clears when the root cause (the oldest failure) is retried first', async () => {
    const cert = line('certificates');
    const scep = line('acmeProfiles');
    const ra = line('raProfiles');
    const gone = new Set<string>();
    const handler = (type: string): TeardownHandler => ({
        action: type,
        remove: async (_c, l) => {
            if (l.uuid === cert.uuid && !gone.has(scep.uuid)) throw new Error('Failed to delete certificate: 500 - still referenced');
            if (l.uuid === ra.uuid && !gone.has(cert.uuid)) throw new Error(`Failed to delete RA Profile: 422 - ["Dependent certificates: 1"]`);
            gone.add(l.uuid);
        },
    });
    const deleted: string[] = [];
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [cert, scep, ra], handler, onDeleted: (p) => void deleted.push(p.uuid), preSteps: [] });
    expect(deleted).toEqual([scep.uuid, cert.uuid, ra.uuid]);
    expect(result.failed).toEqual([]);
    expect(result.finalPass).toEqual({ retried: 2, deleted: 2 });
    expect(readCleanupFailures()).toEqual([]);
});

test('final pass: a first-pass guard refusal never enters it', async () => {
    const cert = line('certificates');
    const calls: string[] = [];
    const handler = (): TeardownHandler => ({
        action: 'c',
        remove: async (_c, l) => {
            calls.push(l.uuid);
            throw new Error(`teardown.certificates: refusing to touch certificates ${l.uuid}: its live name does not start with ${RUN}-. Only objects …`);
        },
    });
    const result = await executeTeardown({ ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [cert], handler, onDeleted: () => undefined, preSteps: [] });
    expect(calls, 'the two first attempts only').toEqual([cert.uuid, cert.uuid]);
    expect(result.finalPass).toEqual({ retried: 0, deleted: 0 });
    expect(isRetryableFailure('teardown.roles: refusing to touch roles r-1: not in the ledger')).toBe(false);
    expect(isRetryableFailure('teardown.roles: API_TEARDOWN_DRY_RUN is on, nothing may be deleted or changed by the teardown')).toBe(false);
    expect(isRetryableFailure('revoke refused: 503 - connector unavailable'), 'a platform refusal is retried').toBe(true);
});

test('final pass: the deleted ledger line is written first; when it throws, the failure record and the failed list stay as they were', async () => {
    const { cert, scep, handler } = referencedCertificate();
    const onDeleted = (p: PlanItem, note?: string) => {
        if (note === FINAL_PASS_NOTE) throw new Error('ledger not writable');
    };
    const before: CleanupFailure[] = [];
    const result = await executeTeardown({
        ...quick, runId: RUN, newApi: async () => fakeApi, readLines: () => [cert, scep], preSteps: [], onDeleted,
        handler: (type) => {
            const h = handler(type)!;
            // the record as the first pass left it, read right before the pass attempt
            return { action: h.action, remove: async (c, l) => { if (l.uuid === cert.uuid && before.length === 0 && readCleanupFailures().length) before.push(...readCleanupFailures()); return h.remove(c, l); } };
        },
    });
    expect(before, 'the first pass recorded the failure').toHaveLength(1);
    expect(readCleanupFailures(), 'unchanged').toEqual(before);
    expect(result.failed.map((f) => f.uuid)).toEqual([cert.uuid]);
    expect(result.deleted.map((d) => d.uuid)).toEqual([scep.uuid]);
    expect(result.finalPass).toEqual({ retried: 1, deleted: 0 });
    expect(result.warnings).toContainEqual(expect.stringMatching(/deleted ledger line could not be written .*the failure stays/));
});
