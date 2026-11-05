/**
 * Unit tests under tests/unit: no globalSetup, no tier, no environment. tests/unit/fixtures/ holds config-test inputs, so it is ignored.
 */
import { defineConfig } from '@playwright/test';
import * as path from 'path';

// Unit tests never run the real docker CLI; set before the workers start so they inherit it.
process.env.REG_UNIT_NO_DOCKER = '1';

export default defineConfig({
    testDir: './tests/unit',
    testIgnore: [path.join(__dirname, 'tests', 'unit', 'fixtures', '**')],
    workers: 1,
    retries: 0,
    timeout: 20_000,
    // Static documents: a negative assertion must not wait for the 5 s default.
    expect: { timeout: 500 },
    reporter: [['list']],
});
