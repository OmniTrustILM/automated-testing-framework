import { defineConfig } from '@playwright/test';
import { devBlockProjects, selectedDevBlock } from './utils/devBlocks/registry';
import { reporters, SINGLE_WORKER } from './utils/regression/configBase';
import { prepareRun } from './utils/regression/run/prepareRun';
import { ensureRunSecret } from './utils/timestamping/secrets';

// Select the block first (an unknown or unset DEV_BLOCK stops here), then the same run preparation as the other configs.
const block = selectedDevBlock();
prepareRun({ configDir: __dirname });
// A fresh secret per run, in the process environment only (utils/timestamping/secrets.ts). The config is loaded again in every worker: make
// it once, never replace it.
ensureRunSecret();

/**
 * One developers' test block (`@dev-tests`), chosen by DEV_BLOCK=timestamping | key-onboarding, with its own report
 * `test-results/dev-<block>-junit.xml`. No snapshot or non-interference check; the global teardown runs the block's own
 * tear-down once more. On a shared tier the `@local` rows select nothing. See tests/dev-blocks/README.md.
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
