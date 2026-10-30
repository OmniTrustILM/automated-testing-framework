import { defineConfig } from '@playwright/test';
import { devBlockProjects, selectedDevBlock } from './utils/devBlocks/registry';
import { reporters, SINGLE_WORKER } from './utils/regression/configBase';
import { prepareRun } from './utils/regression/run/prepareRun';
import { ensureRunSecret } from './utils/timestamping/secrets';

// The block first (an unknown or unset DEV_BLOCK stops here, before a test is listed), then the same run preparation as
// the other configs: env file, frozen tier variables, own run id, tier guards, one worker and the run lock.
const block = selectedDevBlock();
prepareRun({ configDir: __dirname });
// A fresh secret per run, in the process environment only: the timestamping block derives its Basic-credential passwords from it instead of writing
// them to the summary file (utils/timestamping/secrets.ts). Playwright loads this config AGAIN in every worker process: the secret is made once,
// in the runner process (a worker, a retried worker and the global teardown inherit its environment and find it set), never replaced.
ensureRunSecret();

/**
 * One developers' test block (`@dev-tests`), chosen by DEV_BLOCK=timestamping | key-onboarding: its own run, its own
 * report `test-results/dev-<block>-junit.xml`. Projects (utils/devBlocks/registry.ts): <block>-proof → <block>-setup →
 * <block> → <block>-teardown. No snapshot, no run-setup, no non-interference check and no run-end teardown: the global
 * teardown runs the block's own tear-down once more and removes the run's local proof (utils/devBlocks/globalTeardown.ts).
 * `key-onboarding`: every test is `@local`, so on a shared tier all four projects select nothing, the run exits 0 and still writes
 * its (empty) report. `timestamping`: only its docker-bound rows are `@local`; the others run on a shared tier when the tier has the
 * components (`@needs:timestamping`). How to run: tests/dev-blocks/README.md.
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
