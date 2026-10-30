import { defineConfig } from '@playwright/test';
import { reporters, SINGLE_WORKER } from './utils/regression/configBase';
import { apiProjects } from './utils/regression/regressionProjects';
import { prepareRun } from './utils/regression/run/prepareRun';

// Env file, frozen tier variables, one run id for both suites, the cleanup ledger, the local-stack proof, one worker and
// the run lock; any failure stops the run before a test is listed (utils/regression/run/prepareRun.ts).
prepareRun({ configDir: __dirname });

/**
 * API suite (API-*): positive and negative cases per area, under the same create-only rules as the regression suite.
 * Projects (utils/regression/regressionProjects.ts `apiProjects`): snapshot → gate → api-p1 / api-rest →
 * non-interference, then the run-end teardown. Safety model and how to run: tests/regression/README.md.
 */
export default defineConfig({
    testDir: './tests/api',
    timeout: 60_000,
    expect: { timeout: 10_000 },
    ...SINGLE_WORKER,
    reporter: reporters('api'),
    outputDir: 'test-results/api',
    globalTeardown: require.resolve('./utils/regression/teardown/runTeardown'),
    use: {
        baseURL: process.env.BASE_URL,
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: { Accept: 'application/json' },
    },
    projects: apiProjects(),
});
