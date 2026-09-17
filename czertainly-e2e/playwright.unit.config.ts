/**
 * Playwright config for the unit tests under tests/unit.
 *
 * Kept apart from the smoke config because these exercise pure helpers and must not provision
 * anything: no globalSetup, no browser, no environment.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests/unit',
    workers: 1,
    retries: 0,
    timeout: 20_000,
    reporter: [['list']],
});
