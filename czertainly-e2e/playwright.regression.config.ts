import { defineConfig } from '@playwright/test';
import { reporters, SINGLE_WORKER } from './utils/regression/configBase';
import { regressionProjects } from './utils/regression/regressionProjects';
import { prepareRun } from './utils/regression/run/prepareRun';

// Run preparation: env, run id, ledger, local-stack proof, one worker, run lock (utils/regression/run/prepareRun.ts).
prepareRun({ configDir: __dirname });

/** Regression suite (REG-*): the release checklist flows, create-only on a shared tier; see tests/regression/README.md. */
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
