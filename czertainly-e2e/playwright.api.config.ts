import { defineConfig } from '@playwright/test';
import { reporters, SINGLE_WORKER } from './utils/regression/configBase';
import { apiProjects } from './utils/regression/regressionProjects';
import { prepareRun } from './utils/regression/run/prepareRun';

// Run preparation: env, run id, ledger, local-stack proof, one worker, run lock (utils/regression/run/prepareRun.ts).
prepareRun({ configDir: __dirname });

/** API suite (API-*): create-only rules as the regression suite; see tests/regression/README.md. */
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
