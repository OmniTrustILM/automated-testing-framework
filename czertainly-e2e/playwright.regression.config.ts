import { defineConfig } from '@playwright/test';
import { regressionProjects } from './utils/regression/regressionProjects';
import { prepareRun } from './utils/regression/runEnv';

// Env file (REG_ENV_FILE, else ./.env; never the cwd .env once one is named; a named file must exist), TIER_KIND / AUTH_MODE /
// REG_RA_PROFILE_NAME frozen, one id per run shared by every worker (qa-reg-<yyyymmdd>-<hhmmss>-<4 random base36>;
// a hand-set REG_RUN_ID must match that format unless REG_RUN_ID_REUSE=1, and keeps its objects unless
// API_DELETE_OWN=1), the run's cleanup ledger, the TIER_KIND=local proof (build marker + container proof), header auth
// only on a local BASE_URL, one worker and the run lock. Any failure stops the run before a test is listed (utils/regression/runEnv.ts).
prepareRun({ configDir: __dirname });

/**
 * Main-functionality regression (REG-*): the release checklist's configuration and usage flows, plus the ilm#424
 * extension rows.
 *
 * Own objects only (decision Q1): the suite reads everything, creates run-prefixed objects (each recorded in
 * $REG_STATE_DIR/created-objects.jsonl right after the create call) and changes only objects it created (`assertOwnLive`,
 * the guarded `api` fixture; deny by default, linted by tests/unit/specGuards.spec.ts).
 * It never changes, disables, revokes or deletes anything that existed before the run. Everything the run created is
 * deleted at the end by `runTeardown` (decision D1; API_DELETE_OWN=0 keeps it), which then re-checks the
 * non-interference snapshot; a leftover or a violation fails the run. `@local` rows run only with TIER_KIND=local.
 *
 * Projects (utils/regression/regressionProjects.ts; the tier rules are ANDed into each, see utils/regression/projectFilters.ts):
 *   snapshot          guard proof, then the "before" snapshot of API-GEN-33 (tests/api/_run-setup.setup.ts, serial)
 *   regression        every REG spec but the logout file, after the snapshot
 *   logout            REG-AUTH-99-logout.spec.ts (REG-AUTH-03), the teardown project of `regression`: runs after every
 *                     other regression row, failed or not (GD-14; never a `dependencies` project, which a red row would skip)
 *   non-interference  API-GEN-33, the teardown project of `snapshot`: runs after `regression` and `logout`, even when they failed
 * The migration gate (API-GEN-32) lives in the API config; a pipeline runs `--project=gate` there first and stops on a
 * non-zero exit, because a Playwright dependency cannot cross two configs.
 *
 * No globalSetup: the smoke setup registers EJBCA objects, which this suite does not need.
 */
export default defineConfig({
    testDir: './tests/regression',
    timeout: 240_000,
    expect: {
        timeout: 15_000,
    },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [
        ['line'],
        ['html', { open: 'never', outputFolder: 'playwright-report/regression' }],
        ['junit', { outputFile: 'test-results/regression-junit.xml' }],
    ],
    outputDir: 'test-results/regression',
    globalTeardown: require.resolve('./utils/regression/runTeardown'),
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
