import { defineConfig } from '@playwright/test';
import { devBlockProjects, selectedDevBlock } from './utils/devBlocks/registry';
import { reporters, SINGLE_WORKER } from './utils/regression/configBase';
import { prepareRun } from './utils/regression/run/prepareRun';

// The block first (an unknown or unset DEV_BLOCK stops here, before a test is listed), then the same run preparation as
// the other configs: env file, frozen tier variables, own run id, tier guards, one worker and the run lock.
const block = selectedDevBlock();
prepareRun({ configDir: __dirname });

/**
 * One developers' test block (`@dev-tests`), chosen by DEV_BLOCK=timestamping | key-onboarding: its own run, its own
 * report `test-results/dev-<block>-junit.xml`. Projects (utils/devBlocks/registry.ts): <block>-proof → <block>-setup →
 * <block> → <block>-teardown. No snapshot, no run-setup, no non-interference check and no run-end teardown: the global
 * teardown runs the block's own tear-down once more and removes the run's local proof (utils/devBlocks/globalTeardown.ts).
 * Every test of a block is `@local`: on a shared tier all four projects select nothing, the run exits 0 and still writes
 * its (empty) report. How to run: tests/dev-blocks/README.md.
 */
export default defineConfig({
    testDir: './tests',
    timeout: block.timeouts.spec,
    expect: { timeout: 15_000 },
    ...SINGLE_WORKER,
    reporter: reporters(block.junit),
    outputDir: `test-results/${block.junit}`,
    globalTeardown: require.resolve('./utils/devBlocks/globalTeardown'),
    use: {
        baseURL: process.env.BASE_URL,
        actionTimeout: 15_000,
        ignoreHTTPSErrors: true,
    },
    projects: devBlockProjects(block),
});
