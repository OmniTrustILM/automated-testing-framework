/**
 * The timestamping block's tear-down (utils/timestamping/blockTeardown.ts): it selects exactly the block's ledger lines
 * of this run (spec `timestamping/…`, plus every later line about the same uuids), and it follows the run-end
 * teardown's switches — nothing to delete means no login, the dry run and API_DELETE_OWN=off delete nothing.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { readLedger, type LedgerLine } from '../../utils/regression/ledger/ledger';
import type { TeardownHandler } from '../../utils/regression/teardown/runTeardown';
import { BLOCK_SPEC_PREFIX, blockLines, teardownBlock, TEARDOWN_LEDGER_SPEC } from '../../utils/timestamping/blockTeardown';

const RUN = 'qa-reg-20261022-120000-ab12';
const OTHER_RUN = 'qa-reg-20261021-090000-cd34';

let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const line = (o: Partial<LedgerLine>): LedgerLine => ({
    at: '2026-10-22T12:00:00.000Z', runId: RUN, type: 'tspProfiles', name: `${RUN}-tsp`, uuid: uuid(), spec: 'timestamping/setup', event: 'created', ...o,
});

test('blockLines: the block\'s created lines of this run and every later line about the same objects, nothing else', () => {
    const setup = line({});
    const spec = line({ type: 'users', name: `${RUN}-unprivileged`, spec: 'timestamping/40-tsp-errors' });
    const deletedBySpec = line({ uuid: spec.uuid, event: 'deleted', spec: 'timestamping/40-tsp-errors' });
    const deletedByRunEnd = line({ uuid: setup.uuid, event: 'deleted', spec: 'runTeardown' });
    const regressionRow = line({ type: 'raProfiles', spec: 'REG-CFG-03' });
    const lookalike = line({ type: 'raProfiles', spec: '40-tsp-errors' });
    const otherRun = line({ runId: OTHER_RUN, name: `${OTHER_RUN}-tsp` });
    const all = [setup, spec, regressionRow, deletedBySpec, lookalike, otherRun, deletedByRunEnd];
    expect(blockLines(all, RUN)).toEqual([setup, spec, deletedBySpec, deletedByRunEnd]);
    expect(blockLines(all, OTHER_RUN)).toEqual([otherRun]);
    expect(BLOCK_SPEC_PREFIX).toBe('timestamping/');
    expect(TEARDOWN_LEDGER_SPEC.startsWith(BLOCK_SPEC_PREFIX)).toBe(true);
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ REG_RUN_ID: RUN, TIER_KIND: 'shared', ...extra });
const neverAuthenticate = async (): Promise<never> => {
    throw new Error('must not authenticate');
};

test('nothing of the block in the ledger: done, nothing deleted, no login', async () => {
    const outcome = await teardownBlock({ env: env(), readLines: () => [line({ spec: 'REG-CFG-03' })], authenticate: neverAuthenticate });
    expect(outcome).toEqual({ status: 'done', deleted: 0, kept: 0 });
});

test('a block whose objects are all deleted already: done, nothing to delete, no login', async () => {
    const created = line({});
    const deleted = line({ uuid: created.uuid, event: 'deleted', spec: TEARDOWN_LEDGER_SPEC });
    const outcome = await teardownBlock({ env: env(), readLines: () => [created, deleted], authenticate: neverAuthenticate });
    expect(outcome).toEqual({ status: 'done', deleted: 0, kept: 0 });
});

test('API_TEARDOWN_DRY_RUN on: the plan is reported, nothing is deleted, no login', async () => {
    const outcome = await teardownBlock({ env: env({ API_TEARDOWN_DRY_RUN: '1' }), readLines: () => [line({})], authenticate: neverAuthenticate });
    expect(outcome).toEqual({ status: 'skipped', reason: 'API_TEARDOWN_DRY_RUN is on' });
});

test('API_DELETE_OWN off: the objects are kept for the run-end teardown to list, no login', async () => {
    const outcome = await teardownBlock({ env: env({ API_DELETE_OWN: 'off' }), readLines: () => [line({})], authenticate: neverAuthenticate });
    expect(outcome).toEqual({ status: 'skipped', reason: 'API_DELETE_OWN is off' });
});

test('blockLines: a derived object of a block object (the certKey_ key of a block certificate) belongs to the block', () => {
    const certificate = line({ type: 'certificates', name: `${RUN}-tsa-rsa-nq` });
    const derivedKey = line({ type: 'keys', name: `certKey_${RUN}-tsa-rsa-nq`, spec: 'runTeardown', derived: true, parents: { certificate: certificate.uuid } });
    const foreignDerived = line({ type: 'keys', name: 'certKey_other', spec: 'runTeardown', derived: true, parents: { certificate: uuid() } });
    expect(blockLines([certificate, derivedKey, foreignDerived], RUN)).toEqual([certificate, derivedKey]);
});

// ------------------------------------------------------------------ the delete path, through the run-end engine

const ENV_KEYS = ['REG_STATE_DIR', 'CLEANUP_LEDGER_FILE'];
const saved: Record<string, string | undefined> = {};
test.beforeEach(({}, testInfo) => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.REG_STATE_DIR = testInfo.outputPath('state');
    process.env.CLEANUP_LEDGER_FILE = testInfo.outputPath('state', 'cleanup.jsonl');
});
test.afterEach(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

const fakeAuthenticate = (logins: { count: number }) => async () => {
    logins.count += 1;
    return { api: { dispose: async () => undefined } as unknown as APIRequestContext, dispose: async () => undefined };
};
const stub = (removed: string[], failing = new Set<string>()) => (type: string): TeardownHandler => ({
    action: `remove ${type}`,
    remove: async (_ctx, l) => {
        if (failing.has(l.uuid)) throw new Error(`core refused the ${type}`);
        removed.push(l.uuid);
    },
});

test('the delete path: only the block\'s objects go, in DELETE_ORDER, each with a deleted line of spec timestamping/teardown', async () => {
    const tsp = line({ type: 'tspProfiles' });
    const signing = line({ type: 'signingProfiles', name: `${RUN}-sp` });
    const user = line({ type: 'users', name: `${RUN}-unprivileged`, spec: 'timestamping/40-tsp-errors' });
    const regressionRow = line({ type: 'roles', name: `${RUN}-role`, spec: 'REG-CFG-07' });
    const lines = [user, signing, tsp, regressionRow];
    const removed: string[] = [];
    const logins = { count: 0 };
    const outcome = await teardownBlock({ env: env(), readLines: () => lines, authenticate: fakeAuthenticate(logins), handler: stub(removed), retryDelayMs: 1 });
    expect(outcome.status).toBe('done');
    expect(removed, 'DELETE_ORDER: the TSP profile before the signing profile (step 3), the user later (step 12)').toEqual([tsp.uuid, signing.uuid, user.uuid]);
    expect(removed).not.toContain(regressionRow.uuid);
    const ledger = readLedger();
    expect(ledger.filter((l) => l.event === 'deleted').map((l) => [l.uuid, l.spec])).toEqual([
        [tsp.uuid, TEARDOWN_LEDGER_SPEC], [signing.uuid, TEARDOWN_LEDGER_SPEC], [user.uuid, TEARDOWN_LEDGER_SPEC],
    ]);
    expect(logins.count, 'a fresh login per object (shared tier: no local-backend check)').toBe(3);
});

test('a failed delete makes the teardown red, naming type and uuid only (the run-end teardown retries it)', async () => {
    const tsp = line({ type: 'tspProfiles', name: `${RUN}-secret-name` });
    const removed: string[] = [];
    const run = teardownBlock({ env: env(), readLines: () => [tsp], authenticate: fakeAuthenticate({ count: 0 }), handler: stub(removed, new Set([tsp.uuid])), retryDelayMs: 1 });
    await expect(run).rejects.toThrow(new RegExp(`could not delete 1 object\\(s\\).*tspProfiles ${tsp.uuid}`));
    await expect(run).rejects.not.toThrow(/secret-name/);
    expect(readLedger().filter((l) => l.event === 'deleted')).toEqual([]);
});
