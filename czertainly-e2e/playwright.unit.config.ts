/**
 * Playwright config for the unit tests under tests/unit.
 *
 * Kept apart from the smoke config because these exercise pure helpers and must not provision
 * anything: no globalSetup, no browser, no environment.
 *
 * tests/unit/fixtures/ holds inputs of the unit tests (a fixture spec directory that specGuards lists through the REAL
 * REG / API configs): never unit tests themselves, so they are ignored here (anchored to this folder, like the smoke
 * config's ignores).
 */
import { defineConfig } from '@playwright/test';
import * as path from 'path';

// Unit tests never run the real docker CLI (utils/regression/tier.ts `dockerBin`): a test injects the seam or names a
// fake REG_DOCKER_BIN. Set before the workers start, so they inherit it.
process.env.REG_UNIT_NO_DOCKER = '1';

export default defineConfig({
    testDir: './tests/unit',
    testIgnore: [path.join(__dirname, 'tests', 'unit', 'fixtures', '**')],
    workers: 1,
    retries: 0,
    timeout: 20_000,
    reporter: [['list']],
});
