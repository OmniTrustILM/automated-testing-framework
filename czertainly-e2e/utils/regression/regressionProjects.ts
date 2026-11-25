/**
 * regressionProjects — the project tables of both Playwright configs as pure functions, so a unit test can check what each config selects.
 * Logout (REG-AUTH-03) is the TEARDOWN project of `regression`: it runs after every row, failed or not; never use `dependencies` for it (it
 * would be skipped).
 */
import { devices, PlaywrightTestProject } from '@playwright/test';
import { flowOf, withFlow } from './flows';
import { withTierFilters } from './projectFilters';

export const SETUP_FILES = /tier-snapshot\.setup\.ts$/;
export const NON_INTERFERENCE = /tier-non-interference\.api\.spec\.ts$/;
export const RUN_SETUP_FILES = /run-objects\.setup\.ts$/;
/** The one file of the `logout` project (REG-AUTH-03), anchored at a path boundary. */
export const LOGOUT_FILE = /(^|[\\/])01-sign-in-and-access[\\/]99-sign-out\.spec\.ts$/;

const ROW_USE = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };

export function regressionProjects(env: NodeJS.ProcessEnv = process.env): PlaywrightTestProject[] {
    return withTierFilters(
        withFlow([
            { name: 'snapshot', testDir: './tests/api', testMatch: SETUP_FILES, teardown: 'non-interference', timeout: 120_000 },
            { name: 'non-interference', testDir: './tests/api', testMatch: NON_INTERFERENCE, timeout: 120_000 },
            // Makes the run objects once; skips with a named reason and never fails (a dependent project starts only when every dependency
            // test is ok, and a skip is ok).
            { name: 'run-setup', testDir: './tests/api', testMatch: RUN_SETUP_FILES, dependencies: ['snapshot'], timeout: 240_000 },
            {
                name: 'regression',
                dependencies: ['run-setup'],
                teardown: 'logout',
                testIgnore: [LOGOUT_FILE, RUN_SETUP_FILES],
                use: ROW_USE,
            },
            { name: 'logout', testMatch: LOGOUT_FILE, use: ROW_USE },
        ], ['regression', 'logout'], flowOf(env)),
        { env, infrastructure: ['snapshot', 'non-interference', 'run-setup'] },
    );
}

export function apiProjects(env: NodeJS.ProcessEnv = process.env): PlaywrightTestProject[] {
    return withTierFilters(
        withFlow([
            { name: 'snapshot', testMatch: SETUP_FILES, teardown: 'non-interference' },
            { name: 'non-interference', testMatch: NON_INTERFERENCE },
            { name: 'gate', grep: /@gate\b/, testIgnore: NON_INTERFERENCE, dependencies: ['snapshot'],
                use: { ...devices['Desktop Chrome'], extraHTTPHeaders: {} } },
            { name: 'api-p1', grep: /@p1\b/, grepInvert: /@gate\b/, testIgnore: NON_INTERFERENCE, dependencies: ['snapshot'] },
            { name: 'api-rest', grep: /@p2\b|@p3\b/, testIgnore: NON_INTERFERENCE, dependencies: ['gate'] },
        ], ['api-p1', 'api-rest'], flowOf(env)),
        { env, infrastructure: ['snapshot', 'non-interference'] },
    );
}

const asList = (v: RegExp | string | Array<RegExp | string> | undefined): Array<RegExp | string> => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const matches = (p: RegExp | string, file: string): boolean => (typeof p === 'string' ? file.includes(p) : (p.lastIndex = 0, p.test(file)));

/**
 * The names of the projects whose testMatch / testIgnore select a spec file
 * path (mirrors Playwright's file filter), for the logout-last unit test.
 */
export function projectsSelectingFile(projects: PlaywrightTestProject[], file: string, configTestDir = './tests/regression'): string[] {
    return projects
        .filter((p) => {
            const dir = (p.testDir ?? configTestDir).replace(/^\.\//, '').replace(/\/$/, '');
            if (!file.startsWith(`${dir}/`)) return false;
            const match = asList(p.testMatch);
            const ignore = asList(p.testIgnore);
            const defaultMatch = /\.(spec|test)\.(c|m)?[jt]sx?$/;
            const selected = match.length ? match.some((m) => matches(m, file)) : defaultMatch.test(file);
            return selected && !ignore.some((i) => matches(i, file));
        })
        .map((p) => p.name ?? '');
}
