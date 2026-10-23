/**
 * key-onboarding.teardown — the tear-down project of the key onboarding block (the `teardown` of
 * `key-onboarding-setup`).
 *
 * WHAT: one test that deletes every platform object the block's setup and specs recorded in this run, then the key
 * pairs this run planted on the token (utils/keyOnboarding/blockTeardown.ts).
 * WHY: one tear-up fills the environment for the block, one tear-down empties it again right after the block; the
 * run-end teardown is the safety net for the platform objects left.
 * HOW: Playwright runs a teardown project after its setup project and every project depending on it, failed or not.
 * Red when an object could not be deleted (named by type and uuid); the token objects then stay until a later run's
 * clean-up, and the run-end teardown retries the platform objects.
 */
import { test as teardown } from '../../fixtures/testFixtures';
import { describeLocalOnly } from '../../utils/regression/tier/localProof';
import { devTests } from '../../utils/keyOnboarding/tags';
import { teardownBlock } from '../../utils/keyOnboarding/blockTeardown';

// The second guard next to `@local` (as in every spec of the block): off a proven local stack nothing was planted.
describeLocalOnly(teardown);

teardown('the block deletes everything its setup and specs created, then its key pairs on the token', devTests(), async ({}, testInfo) => {
    const outcome = await teardownBlock();
    testInfo.annotations.push({
        type: 'teardown',
        description: outcome.status === 'done'
            ? `deleted ${outcome.deleted}, kept ${outcome.kept}${outcome.after ? `; ${outcome.after}` : ''}`
            : `skipped: ${outcome.reason}`,
    });
});
