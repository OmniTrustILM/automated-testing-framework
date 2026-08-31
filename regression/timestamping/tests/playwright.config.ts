import { defineConfig } from '@playwright/test';
import * as path from 'path';

// The runner points RUN_DIR at runs/<timestamp>/; a standalone `npx playwright test` keeps
// its artifacts out of the runner's tree.
const runDir = process.env.RUN_DIR ?? path.join(__dirname, '..', 'runs', 'manual');

export default defineConfig({
  testDir: './specs',
  // Specs mutate shared platform state (profile enablement, the ntp container), so they run
  // one at a time in file-name order.
  fullyParallel: false,
  workers: 1,
  forbidOnly: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  outputDir: path.join(runDir, 'test-results'),
  reporter: [
    ['list'],
    ['junit', { outputFile: path.join(runDir, 'junit.xml') }],
    ['html', { open: 'never', outputFolder: path.join(runDir, 'playwright-report') }],
  ],
  use: {
    baseURL: process.env.ILM_HOST ?? 'http://localhost:8080',
    ignoreHTTPSErrors: true,
  },
});
