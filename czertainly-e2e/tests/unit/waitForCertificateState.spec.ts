/**
 * Unit tests for the fail-fast waits (waitForCertificateState, waitForDiscoveryCompletion) against a fake
 * APIRequestContext: a terminal bad state, a 404 after the read-after-write grace (Q8: an early one is polled again)
 * and the third 5xx in a row end the wait at once with the state, the
 * latest history and the elapsed time; two 5xx are tolerated; a 5xx is never retried into a pass; 408 / 425 / 429 are
 * transient like a 5xx and count in the same streak (review R21), any other 4xx ends the wait.
 */
import { APIRequestContext, test, expect } from '@playwright/test';
import { waitForCertificateState } from '../../utils/certificateUtils';
import { waitForDiscoveryCompletion } from '../../utils/discoveryUtils';

type Answer = { status: number; body?: unknown };

/** A fake request context: GET answers come from `script` in order (the last one repeats); history has one entry. */
function fakeApi(script: Answer[]): { api: APIRequestContext; calls: string[] } {
    const calls: string[] = [];
    let i = 0;
    const respond = (a: Answer) => ({
        status: () => a.status,
        ok: () => a.status >= 200 && a.status < 300,
        json: async () => a.body,
        text: async () => JSON.stringify(a.body ?? ''),
    });
    const api = {
        get: async (url: string) => {
            calls.push(url);
            if (url.endsWith('/history')) return respond({ status: 200, body: [{ created: 't1', event: 'Issue', status: 'FAILED', message: 'CA refused' }] });
            const a = script[Math.min(i, script.length - 1)];
            i++;
            return respond(a);
        },
    } as unknown as APIRequestContext;
    return { api, calls };
}

const fast = { intervals: [1] };
const cert = (state: string): Answer => ({ status: 200, body: { state } });

test('resolves when the expected state is reached', async () => {
    const { api, calls } = fakeApi([cert('requested'), cert('pending_issue'), cert('issued')]);
    await waitForCertificateState(api, 'c-1', 'issued', 5_000, fast);
    expect(calls.filter((c) => !c.endsWith('/history'))).toHaveLength(3);
});

test('fails at once on failed, with the state and the latest history', async () => {
    const { api, calls } = fakeApi([cert('requested'), cert('failed'), cert('issued')]);
    await expect(waitForCertificateState(api, 'c-1', 'issued', 5_000, fast)).rejects.toThrow(/reached "failed" instead of "issued": state "failed" after \d+ s; latest history: t1 Issue FAILED: CA refused/);
    expect(calls.filter((c) => !c.endsWith('/history')), 'no poll after the terminal state').toHaveLength(2);
});

test('rejected is terminal by default, but not when it is the expected state', async () => {
    await expect(waitForCertificateState(fakeApi([cert('rejected')]).api, 'c-1', 'issued', 5_000, fast)).rejects.toThrow(/reached "rejected"/);
    await waitForCertificateState(fakeApi([cert('pending_approval'), cert('rejected')]).api, 'c-1', 'rejected', 5_000, fast);
    await waitForCertificateState(fakeApi([cert('requested'), cert('failed')]).api, 'c-1', 'failed', 5_000, fast);
});

test('tolerates two 5xx in a row', async () => {
    const { api } = fakeApi([{ status: 503 }, { status: 500 }, cert('issued')]);
    await waitForCertificateState(api, 'c-1', 'issued', 5_000, fast);
});

test('fails on the third consecutive 5xx and never retries it into a pass', async () => {
    const { api } = fakeApi([{ status: 503 }, { status: 500 }, { status: 502 }, cert('issued')]);
    await expect(waitForCertificateState(api, 'c-1', 'issued', 5_000, fast)).rejects.toThrow(/3 consecutive 502 answers/);
});

test('a 5xx streak is reset by a good answer', async () => {
    const { api } = fakeApi([{ status: 500 }, { status: 500 }, cert('requested'), { status: 500 }, { status: 500 }, cert('issued')]);
    await waitForCertificateState(api, 'c-1', 'issued', 5_000, fast);
});

test('408, 425 and 429 are transient: tolerated twice in a streak with 5xx, the third ends the wait (R21)', async () => {
    await waitForCertificateState(fakeApi([{ status: 429 }, { status: 503 }, cert('issued')]).api, 'c-1', 'issued', 5_000, fast);
    await waitForCertificateState(fakeApi([{ status: 408 }, { status: 425 }, cert('issued')]).api, 'c-1', 'issued', 5_000, fast);
    await expect(waitForCertificateState(fakeApi([{ status: 429 }, { status: 500 }, { status: 425 }, cert('issued')]).api, 'c-1', 'issued', 5_000, fast))
        .rejects.toThrow(/3 consecutive 425 answers/);
    await expect(waitForCertificateState(fakeApi([{ status: 403 }, cert('issued')]).api, 'c-1', 'issued', 5_000, fast)).rejects.toThrow(/GET answered 403/);
    await waitForDiscoveryCompletion(fakeApi([{ status: 429 }, disc('completed', 'completed')]).api, 'd-1', 5_000, fast);
    await expect(waitForDiscoveryCompletion(fakeApi([{ status: 429 }]).api, 'd-1', 5_000, fast)).rejects.toThrow(/3 consecutive 429/);
});

test('a 404 after the read-after-write grace ends the wait at once', async () => {
    const { api, calls } = fakeApi([{ status: 404, body: { message: 'Certificate not found' } }, cert('issued')]);
    await expect(waitForCertificateState(api, 'c-1', 'issued', 5_000, { ...fast, notFoundGraceMs: 0 })).rejects.toThrow(/GET answered 404/);
    expect(calls).toHaveLength(1);
});

test('an early 404 is read-after-write lag: polled again within the grace, a pass when the object appears (Q8)', async () => {
    const { api, calls } = fakeApi([{ status: 404 }, { status: 404 }, cert('requested'), cert('issued')]);
    await waitForCertificateState(api, 'c-1', 'issued', 5_000, fast);
    expect(calls.filter((c) => !c.endsWith('/history'))).toHaveLength(4);
    await waitForDiscoveryCompletion(fakeApi([{ status: 404 }, disc('completed', 'completed')]).api, 'd-1', 5_000, fast);
    // 401 / 403 / 400 cannot change by polling: still fail-fast.
    await expect(waitForCertificateState(fakeApi([{ status: 401 }, cert('issued')]).api, 'c-1', 'issued', 5_000, fast)).rejects.toThrow(/GET answered 401/);
    // A 404 that outlasts the grace ends the wait at the first poll after it.
    await expect(waitForCertificateState(fakeApi([{ status: 404 }]).api, 'c-1', 'issued', 5_000, { intervals: [5], notFoundGraceMs: 30 })).rejects.toThrow(/GET answered 404/);
});

test('a timeout names the last state', async () => {
    const { api } = fakeApi([cert('requested')]);
    await expect(waitForCertificateState(api, 'c-1', 'issued', 50, { intervals: [10] })).rejects.toThrow(/did not reach state "issued" within 50ms: state "requested"/);
});

test('the old four-argument call still works', async () => {
    await waitForCertificateState(fakeApi([cert('revoked')]).api, 'c-1', 'revoked', 1_000);
});

const disc = (status: string, connectorStatus: string): Answer => ({ status: 200, body: { status, connectorStatus } });

test('discovery: completes on completed / completed, fails fast on failed', async () => {
    await waitForDiscoveryCompletion(fakeApi([disc('inProgress', 'inProgress'), disc('completed', 'completed')]).api, 'd-1', 5_000, fast);
    await expect(waitForDiscoveryCompletion(fakeApi([disc('inProgress', 'failed')]).api, 'd-1', 5_000, fast)).rejects.toThrow(/reached "failed"/);
});

test('discovery: 404 and three 5xx end the wait; stop and cancel are selectable terminal states', async () => {
    await expect(waitForDiscoveryCompletion(fakeApi([{ status: 404 }]).api, 'd-1', 5_000, { ...fast, notFoundGraceMs: 0 })).rejects.toThrow(/GET answered 404/);
    await expect(waitForDiscoveryCompletion(fakeApi([{ status: 500 }]).api, 'd-1', 5_000, fast)).rejects.toThrow(/3 consecutive 500/);
    await waitForDiscoveryCompletion(fakeApi([disc('inProgress', 'inProgress'), disc('cancelled', 'inProgress')]).api, 'd-1', 5_000, { ...fast, expected: { status: 'cancelled' } });
});
