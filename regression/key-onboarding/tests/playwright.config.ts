import { defineConfig } from '@playwright/test';
import * as path from 'path';
import { runDir } from './utils/env';

export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  // The specs share one token. They run one at a time, in file-name order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: path.join(runDir, 'test-results'),
  reporter: [
    ['list'],
    ['junit', { outputFile: path.join(runDir, 'junit.xml') }],
    ['html', { open: 'never', outputFolder: path.join(runDir, 'playwright-report') }],
  ],
});
