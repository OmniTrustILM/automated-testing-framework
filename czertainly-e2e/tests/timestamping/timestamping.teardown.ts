/**
 * timestamping.teardown — the tear-down project of the timestamping block (the `teardown` of `timestamping-setup`).
 *
 * WHAT: one test that deletes every object the block's setup and specs recorded in this run (utils/timestamping/
 * blockTeardown.ts), in the run-end teardown's delete order and through its own-object guard.
 * WHY: one tear-up fills the environment for the block, one tear-down empties it again right after the block; the
 * run-end teardown is the safety net for anything left.
 * HOW: Playwright runs a teardown project after its setup project and every project depending on it, failed or not.
 * Red when an object could not be deleted (named by type and uuid); the run-end teardown then retries it.
 */
import { test as teardown } from '../../fixtures/testFixtures';
import { describeLocalOnly } from '../../utils/regression/tier/localProof';
import { devTests } from '../../utils/timestamping/tags';
import { teardownBlock } from '../../utils/timestamping/blockTeardown';

// The second guard next to `@local` (as in every spec of the block): off a proven local stack the block's objects are
// left to the run-end teardown, the documented safety net.
describeLocalOnly(teardown);

teardown('the block deletes everything its setup and specs created', devTests(), async ({}, testInfo) => {
    const outcome = await teardownBlock();
    testInfo.annotations.push({
        type: 'teardown',
        description: outcome.status === 'done' ? `deleted ${outcome.deleted}, kept ${outcome.kept}` : `skipped: ${outcome.reason}`,
    });
});
