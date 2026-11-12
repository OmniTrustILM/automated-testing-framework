/**
 * The fail-fast certificate wait (waitForCertificateState) against a fake request context: a bad terminal state, a 404
 * after the read-after-write grace and a third 5xx in a row end the wait at once with the state and history; two 5xx
 * and 408 / 425 / 429 are tolerated in one streak, and a 5xx is never retried into a pass.
 */
import { test, expect } from '@playwright/test';
import { waitForCertificateState } from '../../utils/certificateUtils';
import { waitForDiscoveryCompletion } from '../../utils/discoveryUtils';
import { Answer, fakeRequestContext as fakeApi } from './helpers/fakeRequestContext';

const fast = { intervals: [1] };
const cert = (state: string): Answer => ({ status: 200, body: { state } });
// Two rows also check that the discovery wait shares the transient and read-after-write rules.
const disc = (status: string, connectorStatus: string): Answer => ({ status: 200, body: { status, connectorStatus } });

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

test('408, 425 and 429 are transient: tolerated twice in a streak with 5xx, the third ends the wait', async () => {
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

test('an early 404 is read-after-write lag: polled again within the grace, a pass when the object appears', async () => {
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
