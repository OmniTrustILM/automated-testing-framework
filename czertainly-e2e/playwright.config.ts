/// <reference types="node" />

import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '.env') });

export default defineConfig({
  testDir: './tests',

  // Only the smoke suite belongs to this config. The visual baselines need reference images that
  // are captured per environment and deliberately not committed, and the unit tests need no
  // environment at all - both have their own config, and a bare `playwright test` here must not
  // sweep them up along with the suite it is meant to run.
  testIgnore: ['**/visual/**', '**/unit/**'],

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
