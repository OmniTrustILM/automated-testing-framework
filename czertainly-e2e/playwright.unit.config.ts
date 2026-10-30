/**
 * Unit tests under tests/unit: pure helpers, page objects on static stand-in pages and the guard against a loopback
 * fake core. No globalSetup, no tier, no environment. tests/unit/fixtures/ holds inputs of the config tests (listed
 * through the real configs), never unit tests, so it is ignored here.
 */
import { defineConfig } from '@playwright/test';
import * as path from 'path';

// Unit tests never run the real docker CLI (utils/regression/requireTool.ts `dockerBin`): a test injects the seam or names a
// fake REG_DOCKER_BIN. Set before the workers start, so they inherit it.
process.env.REG_UNIT_NO_DOCKER = '1';

export default defineConfig({
    testDir: './tests/unit',
    testIgnore: [path.join(__dirname, 'tests', 'unit', 'fixtures', '**')],
    workers: 1,
    retries: 0,
    timeout: 20_000,
    // The page-object unit files assert on static documents: nothing is asynchronous, so a negative assertion must not
    // wait for the 5 s default.
    expect: { timeout: 500 },
    reporter: [['list']],
});
