/**
 * A minimal config over this folder for the GD-02 / F4 proof (tests/unit/tokenFixtures.spec.ts): the REAL fixtures of
 * fixtures/testFixtures.ts, three tests taking `restrictedToken`, a loopback identity provider answering 401 — the
 * grant must be sent ONCE and every test must SKIP with the named reason. Never run by the unit config (fixtures/ is
 * ignored there) and invisible to the REG / API configs.
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
