/// <reference types="node" />
/**
 * Playwright config for the EST (RFC 7030) suite under tests/est.
 *
 * Kept apart from the smoke config: it needs its own environment (`.env.est`), drives the EST
 * endpoints directly rather than a browser, and runs serially because the specs share the
 * pre-provisioned RA Profiles. The log-hygiene spec runs after every other spec, so it scans their
 * traffic, and the Core restart runs last of all; a failure earlier skips both, and either alone runs
 * with `--no-deps`. The variables are validated by the specs' hooks, not here, so listing the tests
 * works without them.
 */
import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env.est') });

export default defineConfig({
  testDir: './tests/est',

  globalSetup: require.resolve('./utils/estGlobalSetup'),
  globalTeardown: require.resolve('./utils/estGlobalTeardown'),

  // An enrollment goes through the CA and can take seconds; a spec chains several.
  timeout: 120_000,
  expect: { timeout: 15_000 },

  workers: 1,
  retries: 0,

  projects: [
    { name: 'est', testMatch: '**/*.est.spec.ts', testIgnore: ['**/hygiene.est.spec.ts', '**/restart.est.spec.ts'] },
    { name: 'est-hygiene', testMatch: '**/hygiene.est.spec.ts', dependencies: ['est'] },
    { name: 'est-restart', testMatch: '**/restart.est.spec.ts', dependencies: ['est-hygiene'] },
  ],

  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: 'playwright-report-est' }],
    ['junit', { outputFile: 'test-results/junit-est.xml' }],
  ],
});
