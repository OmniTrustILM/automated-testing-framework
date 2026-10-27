/**
 * The shared block tear-down (utils/devBlocks/blockTeardown.ts): the `after` step that removes what a block made
 * outside the platform runs only when every ledger object of the block is gone — after a clean delete, or when nothing
 * is left — and never after a failed delete, under the dry run or with API_DELETE_OWN off. The selection by prefix keeps
 * two blocks apart.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { LedgerLine } from '../../utils/regression/ledger/ledger';
import type { TeardownHandler } from '../../utils/regression/teardown/runTeardown';
import { blockLines, teardownBlock, type DevBlock } from '../../utils/devBlocks/blockTeardown';

const RUN = 'qa-reg-20261023-120000-ab12';

let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const line = (o: Partial<LedgerLine>): LedgerLine => ({
    at: '2026-10-23T12:00:00.000Z', runId: RUN, type: 'tokens', name: `${RUN}-token`, uuid: uuid(), spec: 'key-onboarding/setup', event: 'created', ...o,
});
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ REG_RUN_ID: RUN, TIER_KIND: 'shared', ...extra });

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

const authenticate = async () => ({ api: { dispose: async () => undefined } as unknown as APIRequestContext, dispose: async () => undefined });
const stub = (failing = new Set<string>()) => (type: string): TeardownHandler => ({
    action: `remove ${type}`,
    remove: async (_ctx, l) => {
        if (failing.has(l.uuid)) throw new Error(`core refused the ${type}`);
    },
});
const block = (calls: string[]): DevBlock => ({
    prefix: 'key-onboarding/',
    teardownSpec: 'key-onboarding/teardown',
    after: async (_env, runId) => {
        calls.push(runId);
        return 'removed 3 token objects';
    },
});

test('blockLines keeps two blocks apart by their prefix', () => {
    const ko = line({});
    const ts = line({ type: 'tspProfiles', name: `${RUN}-tsp`, spec: 'timestamping/setup' });
    expect(blockLines([ko, ts], RUN, 'key-onboarding/')).toEqual([ko]);
    expect(blockLines([ko, ts], RUN, 'timestamping/')).toEqual([ts]);
});

test('after a clean delete the after step runs once, with this run id, and its report is returned', async () => {
    const calls: string[] = [];
    const outcome = await teardownBlock(block(calls), { env: env(), readLines: () => [line({})], authenticate, handler: stub(), retryDelayMs: 1 });
    expect(calls).toEqual([RUN]);
    expect(outcome).toMatchObject({ status: 'done', deleted: 1, after: 'removed 3 token objects' });
});

test('with no ledger object of the block left the after step still runs (planted objects without platform objects)', async () => {
    const calls: string[] = [];
    const outcome = await teardownBlock(block(calls), { env: env(), readLines: () => [], authenticate, handler: stub(), retryDelayMs: 1 });
    expect(calls).toEqual([RUN]);
    expect(outcome).toEqual({ status: 'done', deleted: 0, kept: 0, after: 'removed 3 token objects' });
});

test('a failed delete stops before the after step: the platform must never keep a key whose token objects were removed', async () => {
    const calls: string[] = [];
    const key = line({ type: 'keys', name: `${RUN}-ko-rsa` });
    const run = teardownBlock(block(calls), { env: env(), readLines: () => [key], authenticate, handler: stub(new Set([key.uuid])), retryDelayMs: 1 });
    await expect(run).rejects.toThrow(new RegExp(`could not delete 1 object\\(s\\).*outside the platform stays until then.*keys ${key.uuid}`));
    expect(calls).toEqual([]);
});

test('a kept object (a derived key that holds a token pair) stops the after step: nothing outside the platform is removed under it', async () => {
    const calls: string[] = [];
    const derivedKey = line({ type: 'keys', name: 'certKey_x', derived: true, createdAfter: '2026-10-23T11:59:00.000Z', parents: { certificate: uuid() } });
    const own = line({ type: 'certificates', name: `${RUN}-ko-certified` });
    const keepDerived = (type: string): TeardownHandler => ({
        action: `remove ${type}`,
        remove: async (_ctx, l) => (l.uuid === derivedKey.uuid ? 'kept' : undefined),
    });
    const lines = [own, { ...derivedKey, parents: { certificate: own.uuid } }];
    const outcome = await teardownBlock(block(calls), { env: env(), readLines: () => lines, authenticate, handler: keepDerived, retryDelayMs: 1 });
    expect(calls, 'the after step did not run').toEqual([]);
    expect(outcome).toMatchObject({ status: 'done', kept: 1, after: expect.stringMatching(/^skipped: 1 object\(s\) kept \(keys /) });
});

test('the dry run and API_DELETE_OWN off skip the after step too', async () => {
    const calls: string[] = [];
    const switches: Array<Record<string, string>> = [{ API_TEARDOWN_DRY_RUN: '1' }, { API_DELETE_OWN: 'off' }];
    for (const extra of switches) {
        const outcome = await teardownBlock(block(calls), { env: env(extra), readLines: () => [], authenticate, handler: stub(), retryDelayMs: 1 });
        expect(outcome.status).toBe('skipped');
    }
    expect(calls).toEqual([]);
});
