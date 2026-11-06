/**
 * key-onboarding.teardown — the teardown project of the key onboarding block (the `teardown` of `key-onboarding-setup`).
 * One test deletes every platform object the block's setup and specs recorded in this run, then the key pairs this run
 * planted on the token (utils/keyOnboarding/blockTeardown.ts).
 */
import { test as teardown } from '../../fixtures/testFixtures';
import { describeLocalOnly } from '../../utils/regression/tier/localProof';
import { devTests } from '../../utils/keyOnboarding/tags';
import { teardownBlock } from '../../utils/keyOnboarding/blockTeardown';

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
