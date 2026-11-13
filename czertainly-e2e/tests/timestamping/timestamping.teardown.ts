/**
 * timestamping.teardown — the teardown project of the timestamping block (the `teardown` of `timestamping-setup`). One
 * test deletes every object the block's setup and specs recorded in this run (utils/timestamping/blockTeardown.ts), in
 * the run-end teardown's delete order and through its own-object guard.
 */
import { test as teardown, expect } from '../../fixtures/testFixtures';
import { getAuthenticatedApiContext } from '../../utils/auth/apiContext';
import { guardApi } from '../../utils/regression/guard/createGuard';
import { devTests } from '../../utils/timestamping/tags';
import { teardownBlock } from '../../utils/timestamping/blockTeardown';
import { compareBaseline, readBaseline } from '../../utils/timestamping/inventory';
import { Admin } from '../../utils/timestamping/provision/transport';

teardown('the block deletes everything its setup and specs created', devTests({ infrastructure: true }), async ({ request, env }, testInfo) => {
    const outcome = await teardownBlock();
    testInfo.annotations.push({
        type: 'teardown',
        description: outcome.status === 'done' ? `deleted ${outcome.deleted}, kept ${outcome.kept}` : `skipped: ${outcome.reason}`,
    });
    if (!readBaseline()) {
        testInfo.annotations.push({ type: 'inventory check', description: 'skipped: no baseline: the setup took none (the tier was unavailable, or the setup did not run)' });
        return;
    }
    const api = guardApi(await getAuthenticatedApiContext(request, env));
    try {
        const check = await compareBaseline(new Admin(api));
        testInfo.annotations.push({ type: 'inventory check', description: check.status === 'differs' ? check.differences.join('; ') : check.status === 'skipped' ? `skipped: ${check.reason}` : 'same' });
        expect(check.status === 'differs' ? check.differences : [],
            'a pre-existing signing profile, TSP profile or time-quality configuration differs from before the block (or another user changed them meanwhile)').toEqual([]);
    } finally {
        await api.dispose();
    }
});
