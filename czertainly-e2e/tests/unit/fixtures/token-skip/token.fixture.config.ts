/**
 * A minimal config over this folder for the restricted-token skip proof (tests/unit/tokenFixtures.spec.ts).
 */
import { defineConfig } from '@playwright/test';
import * as path from 'path';

export default defineConfig({
    testDir: __dirname,
    testMatch: /token\.fixture\.ts$/,
    workers: 1,
    retries: 0,
    timeout: 30_000,
    reporter: [['json']],
    outputDir: path.join(__dirname, '..', '..', '..', '..', 'test-results', 'token-skip'),
});
