import { defineConfig } from '@playwright/test';
import { reporters, SINGLE_WORKER } from './utils/regression/configBase';
import { regressionProjects } from './utils/regression/regressionProjects';
import { prepareRun } from './utils/regression/run/prepareRun';

// Env file, frozen tier variables, one run id for both suites, the cleanup ledger, the local-stack proof, one worker and
// the run lock; any failure stops the run before a test is listed (utils/regression/run/prepareRun.ts).
prepareRun({ configDir: __dirname });

/**
 * Regression suite (REG-*): the release checklist's configuration and usage flows, create-only on a shared tier.
 * Projects (utils/regression/regressionProjects.ts): snapshot → regression → logout (REG-AUTH-99-*.spec.ts) →
 * non-interference, then the run-end teardown. Safety model and how to run: tests/regression/README.md.
 */
export default defineConfig({
    testDir: './tests/regression',
    timeout: 240_000,
    expect: {
        timeout: 15_000,
    },
    ...SINGLE_WORKER,
    reporter: reporters('regression'),
    outputDir: 'test-results/regression',
    globalTeardown: require.resolve('./utils/regression/teardown/runTeardown'),
    use: {
        baseURL: process.env.BASE_URL,
        actionTimeout: 15_000,
        ignoreHTTPSErrors: true,
        screenshot: 'on',
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
    },
    projects: regressionProjects(),
});
