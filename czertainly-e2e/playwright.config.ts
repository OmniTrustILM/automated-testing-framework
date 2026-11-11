/// <reference types="node" />

import { defineConfig, devices } from '@playwright/test';
import { loadDotenv } from './utils/envFile';

// A variable that is already set is never overwritten, so loading .env first would win over REG_ENV_FILE.
loadDotenv(process.env, __dirname, { requireExplicit: true });

export default defineConfig({
  // Only the smoke suite and the Epic tests (selected by --grep @epic-<n> on the Epic workflow): a bare `playwright test`
  // must not sweep up the other suites.
  testDir: './tests',
  testMatch: ['smoke/**/*.spec.ts', 'epic/**/*.spec.ts'],

  globalSetup: require.resolve('./global-setup'),
  globalTeardown: require.resolve('./global-teardown'),

  timeout: 30_000,

  expect: {
    timeout: 10_000,
  },

  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],

  use: {
    baseURL: process.env.BASE_URL,

    actionTimeout: 15_000,

    screenshot: 'only-on-failure',

    video: 'retain-on-failure',

    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  retries: process.env.CI ? 1 : 0,

  workers: process.env.CI ? 2 : undefined,
});
