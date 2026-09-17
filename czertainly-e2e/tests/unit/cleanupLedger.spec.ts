/**
 * Unit tests for the cleanup ledger — the mechanism that stops a leaking run from reporting green.
 *
 * These are deliberately environment-free: the ledger is a file and a few pure helpers, and the
 * behaviour worth pinning down is how a failure is classified, whether a retry is given, and
 * whether a cascade is reported as one cause rather than three.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    attemptCleanup,
    clearCleanupFailures,
    formatCleanupReport,
    isDependencyRefusal,
    readCleanupFailures,
    recordCleanupFailure,
    statusOf,
} from '../../utils/cleanupLedger';

const LEDGER = path.resolve(__dirname, '..', '..', '.smoke-cleanup.jsonl');

test.beforeEach(() => clearCleanupFailures());
test.afterEach(() => clearCleanupFailures());

test('a status code is read off the error our API helpers raise', () => {
    expect(statusOf('Failed to delete certificate abc: 500 - {"message":"Internal server error."}')).toBe(500);
    expect(statusOf('Failed to delete authority x: 422 - ["Dependent RA profiles: smoke-raprofile-1"]')).toBe(422);
    expect(statusOf('connection refused'), 'no status in the text').toBeUndefined();
});

test('only a 422 that names dependants counts as a dependency refusal', () => {
    expect(isDependencyRefusal('Failed: 422 - ["Dependent RA profiles: smoke-raprofile-1"]')).toBe(true);
    expect(isDependencyRefusal('Failed: 422 - ["Invalid request"]'), 'a 422 alone is not a cascade').toBe(false);
    expect(isDependencyRefusal('Failed: 500 - Internal server error')).toBe(false);
});

test('failures survive the process boundary as one line each', () => {
    recordCleanupFailure({ resource: 'certificate', uuid: 'c-1', status: 500, message: 'boom' });
    recordCleanupFailure({ resource: 'raProfile', uuid: 'r-1', name: 'smoke-raprofile-1', status: 500, message: 'boom' });

    expect(fs.readFileSync(LEDGER, 'utf-8').trim().split('\n')).toHaveLength(2);
    const failures = readCleanupFailures();
    expect(failures.map((f) => f.resource)).toEqual(['certificate', 'raProfile']);
    expect(failures[1].name).toBe('smoke-raprofile-1');
});

test('a delete that succeeds on the second try is not reported', async () => {
    let calls = 0;
    const ok = await attemptCleanup({ resource: 'certificate', uuid: 'c-2' }, async () => {
        calls++;
        if (calls === 1) throw new Error('Failed to delete certificate c-2: 409 - still processing');
    }, { retryDelayMs: 10 });

    expect(ok, 'the retry won the race').toBe(true);
    expect(calls).toBe(2);
    expect(readCleanupFailures(), 'nothing to report when the object is gone').toHaveLength(0);
});

test('a delete that keeps failing is recorded once, with its status', async () => {
    let calls = 0;
    const ok = await attemptCleanup({ resource: 'certificate', uuid: 'c-3' }, async () => {
        calls++;
        throw new Error('Failed to delete certificate c-3: 500 - {"message":"Internal server error."}');
    }, { retryDelayMs: 10 });

    expect(ok).toBe(false);
    expect(calls, 'one attempt plus one retry').toBe(2);
    const [failure] = readCleanupFailures();
    expect(failure).toMatchObject({ resource: 'certificate', uuid: 'c-3', status: 500 });
    expect(failure.blockedBy, 'nothing upstream failed').toBeUndefined();
});

test('a dependency refusal is attributed to the object that is still there', async () => {
    const ok = await attemptCleanup(
        { resource: 'authority', uuid: 'a-1', name: 'smoke-authority-1' },
        async () => { throw new Error('Failed to delete authority a-1: 422 - ["Dependent RA profiles: smoke-raprofile-1"]'); },
        { blockedBy: 'raProfile r-1', retryDelayMs: 10 },
    );

    expect(ok).toBe(false);
    expect(readCleanupFailures()[0].blockedBy).toBe('raProfile r-1');
});

test('a failure that is not a dependency refusal stays its own cause even downstream', async () => {
    await attemptCleanup(
        { resource: 'authority', uuid: 'a-2' },
        async () => { throw new Error('Failed to delete authority a-2: 500 - Internal server error'); },
        { blockedBy: 'raProfile r-1', retryDelayMs: 10 },
    );

    expect(readCleanupFailures()[0].blockedBy, 'a 500 is not explained by the object above it').toBeUndefined();
});

test('the report separates root causes from what follows them', () => {
    const report = formatCleanupReport([
        { resource: 'raProfile', uuid: 'r-1', name: 'smoke-raprofile-1', status: 500, message: 'boom' },
        { resource: 'authority', uuid: 'a-1', name: 'smoke-authority-1', status: 422, message: 'dependent', blockedBy: 'raProfile r-1' },
    ]);

    expect(report).toContain('2 object(s) could not be removed');
    expect(report).toContain('1 root cause(s)');
    expect(report).toContain('smoke-raprofile-1');
    expect(report).toContain('still referenced by raProfile r-1');
});
