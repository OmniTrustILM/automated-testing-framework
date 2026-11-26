import { defineConfig } from '@playwright/test';
import { prepareRun } from './utils/regression/run/prepareRun';

// Loads REG_ENV_FILE (the throw-away environment's env file) and prepares the run, as the other configs do.
prepareRun({ configDir: __dirname });

/**
 * Developers' e2e tests on a throw-away ILM (tests/ephemeral/<folder>): tests that may break the platform on purpose
 * (stop a connector, restart Core, change platform settings), so they never run on a shared tier. Each folder brings
 * what it needs in its `env/` (Kubernetes manifests the workflow applies first). See tests/ephemeral/README.md.
 */
export default defineConfig({
    testDir: './tests/ephemeral',
    timeout: 600_000,
    expect: { timeout: 15_000 },
    workers: 1,
    reporter: [['line'], ['junit', { outputFile: 'test-results/ephemeral-junit.xml' }]],
    outputDir: 'test-results/ephemeral',
    use: { baseURL: process.env.BASE_URL, ignoreHTTPSErrors: true },
});
