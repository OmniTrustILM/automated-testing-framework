/// <reference types="node" />

import { defineConfig } from '@playwright/test';
import smoke from './playwright.config';

// Epic tests written by the QA test agent (tests/epic/ilm-<n>/), run by the Testkube Epic workflow
// on the Epic branch. Same environment, global setup and reports as the smoke suite, which that workflow copies;
// only the folder differs, since playwright.config.ts covers tests/smoke alone.
export default defineConfig({
  ...smoke,
  testDir: './tests/epic',
});
