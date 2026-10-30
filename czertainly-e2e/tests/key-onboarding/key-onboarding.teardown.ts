/**
 * key-onboarding.teardown — the teardown project of the key onboarding block (the `teardown` of `key-onboarding-setup`).
 *
 * One test deletes every platform object the block's setup and specs recorded in this run, then the key pairs this run
 * planted on the token (utils/keyOnboarding/blockTeardown.ts). Playwright runs it after the block, failed or not.
 *
 * Red when an object could not be deleted (named by type and uuid). The run-end teardown is the safety net for the
 * platform objects left.
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
