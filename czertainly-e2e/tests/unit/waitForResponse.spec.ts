/** waitForResponse — unit tests: a response wait that fails before it is awaited reaches the caller, never as an unhandled rejection. */
import type { Page, Response } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { actAndWaitForApi, watchApiCall } from '../../pages/ui/waitForResponse';
import { partialOf } from './helpers/guardRig';

const CALL = { method: 'POST', path: '/api/v1/users' };
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitFailingAfter = (ms: number): Page => partialOf<Page>({
    waitForResponse: () => new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('response wait timed out')), ms)),
});

async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const spy = (reason: unknown): void => { seen.push(reason); };
    process.on('unhandledRejection', spy);
    try {
        await run();
        await pause(20);
    } finally {
        process.off('unhandledRejection', spy);
    }
    return seen;
}

test('actAndWaitForApi: a wait that fails while the action runs reaches the caller; an action that throws keeps its own error', async () => {
    const seen = await unhandledDuring(async () => {
        await expect(actAndWaitForApi(waitFailingAfter(5), CALL, () => pause(40))).rejects.toThrow('response wait timed out');
        await expect(actAndWaitForApi(waitFailingAfter(5), CALL, async () => { await pause(40); throw new Error('click failed'); })).rejects.toThrow('click failed');
    });
    expect(seen, 'no unhandled rejection').toEqual([]);
});

test('watchApiCall: a wait not awaited yet fails without an unhandled rejection, and awaiting it later still throws', async () => {
    let wait: Promise<Response> | undefined;
    const seen = await unhandledDuring(async () => {
        wait = watchApiCall(waitFailingAfter(5), CALL);
        await pause(30);
    });
    expect(seen, 'no unhandled rejection').toEqual([]);
    await expect(wait).rejects.toThrow('response wait timed out');
});
