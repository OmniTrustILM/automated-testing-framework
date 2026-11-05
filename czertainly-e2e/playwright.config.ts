/// <reference types="node" />

import { defineConfig, devices } from '@playwright/test';
import { loadDotenv } from './utils/envFile';

// Load environment variables: the file REG_ENV_FILE names (it must exist), else the .env next to this config. A variable
// that is set is never overwritten, so loading .env first would win over REG_ENV_FILE.
loadDotenv(process.env, __dirname, { requireExplicit: true });

export default defineConfig({
  // Only the smoke suite belongs to this config: the visual, unit, regression and API suites have their own configs,
  // and a bare `playwright test` must not sweep them up. Pointing testDir at tests/smoke (instead of an ignore list)
  // means a new suite folder never needs an entry here.
  testDir: './tests/smoke',

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
