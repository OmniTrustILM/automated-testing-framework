/**
 * discoveryUtils — the fail-fast wait of a discovery (waitForDiscoveryCompletion) against a fake request context:
 * completed / completed passes, failed ends the wait at once, a 404 or a third 5xx in a row ends it, and stop /
 * cancel can be chosen as the expected terminal state. No network.
 */
import { test, expect } from '@playwright/test';
import { waitForDiscoveryCompletion } from '../../utils/discoveryUtils';
import { Answer, fakeRequestContext as fakeApi } from './helpers/fakeRequestContext';

const fast = { intervals: [1] };
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
