/** wait — unit tests of pollUntil's error budget: a throwing check counts like a failed read. */
import { expect, test } from '@playwright/test';
import { pollUntil } from '../../utils/regression/wait';

const failedCheck = (): boolean => { throw new Error('a firing failed'); };

test('a check that keeps throwing is raised after the error budget, not hidden behind the timeout', async () => {
    let reads = 0;
    await expect(pollUntil(async () => ++reads, failedCheck, { timeoutMs: 5_000, intervalMs: 1 })).rejects.toThrow('a firing failed');
    expect(reads, 'the default budget of 2 raises the third error in a row').toBe(3);
    reads = 0;
    await expect(pollUntil(async () => ++reads, failedCheck, { timeoutMs: 5_000, intervalMs: 1, tolerateErrors: 0 })).rejects.toThrow('a firing failed');
    expect(reads, 'a budget of 0 raises the first error').toBe(1);
});

test('onTimeout return raises the last error when every check threw', async () => {
    await expect(pollUntil(async () => 1, failedCheck, { attempts: 2, intervalMs: 1, tolerateErrors: 5, onTimeout: 'return' })).rejects.toThrow('a firing failed');
});

test('a passing check or read starts the error budget again', async () => {
    const steps = ['throw', 'throw', 'no', 'throw', 'throw', 'yes'];
    let read = 0;
    const value = await pollUntil(async () => read++, (n) => {
        if (steps[n] === 'throw') throw new Error(`step ${n}`);
        return steps[n] === 'yes';
    }, { timeoutMs: 5_000, intervalMs: 1 });
    expect(value).toBe(5);
});
