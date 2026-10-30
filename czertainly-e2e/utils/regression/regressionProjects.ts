/**
 * regressionProjects — the project tables of playwright.regression.config.ts and playwright.api.config.ts as pure functions,
 * so a unit test can check what each config selects.
 *
 * Logout (REG-AUTH-03) must run after EVERY other regression row, so it is the TEARDOWN project of `regression`: it runs
 * after all dependents, failed or not. Never use `dependencies: ['regression']` for it: it would be SKIPPED whenever any
 * test is not ok (tests/unit/regressionProjects.spec.ts pins this).
 * Order: regression rows, logout, non-interference, the global runTeardown.
 */
import { devices, PlaywrightTestProject } from '@playwright/test';
import { withTierFilters } from './projectFilters';

export const SETUP_FILES = /tier-snapshot\.setup\.ts$/;
export const NON_INTERFERENCE = /tier-non-interference\.api\.spec\.ts$/;
/** The one file of the `run-setup` project (REG-RUN-01): the run objects the later specs build on. */
export const RUN_SETUP_FILES = /run-objects\.setup\.ts$/;
/**
 * The one file of the `logout` project (REG-AUTH-03): `99-sign-out.spec.ts` in the sign-in and access folder. Anchored at
 * a path boundary: a longer folder or file name that merely ends the same way is another file.
 */
export const LOGOUT_FILE = /(^|[\\/])01-sign-in-and-access[\\/]99-sign-out\.spec\.ts$/;

/** The use / timeout the row projects share. */
const ROW_USE = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };

/** The regression config's projects (the tier rules folded in; `env` is the unit-test seam). */
export function regressionProjects(env: NodeJS.ProcessEnv = process.env): PlaywrightTestProject[] {
    return withTierFilters(
        [
            { name: 'snapshot', testDir: './tests/api', testMatch: SETUP_FILES, teardown: 'non-interference', timeout: 120_000 },
            { name: 'non-interference', testDir: './tests/api', testMatch: NON_INTERFERENCE, timeout: 120_000 },
            // Makes the run objects (authority, RA profile, ACME profile, role, token chain) once, after the "before" snapshot has listed
            // what existed. It skips with a named reason on any tier condition and never fails: Playwright starts a dependent project only
            // when every test of its dependencies is ok, and a skipped test is ok.
            { name: 'run-setup', testDir: './tests/api', testMatch: RUN_SETUP_FILES, dependencies: ['snapshot'], timeout: 240_000 },
            {
                name: 'regression',
                dependencies: ['run-setup'],
                teardown: 'logout',
                testIgnore: [LOGOUT_FILE, RUN_SETUP_FILES],
                use: ROW_USE,
            },
            // The teardown project of `regression` — runs after every regression row, failed or not; no dependencies.
            { name: 'logout', testMatch: LOGOUT_FILE, use: ROW_USE },
        ],
        { env, infrastructure: ['snapshot', 'non-interference', 'run-setup'] },
    );
}

/** The API config's projects (the tier rules folded in; `env` is the unit-test seam). */
export function apiProjects(env: NodeJS.ProcessEnv = process.env): PlaywrightTestProject[] {
    return withTierFilters(
        [
            { name: 'snapshot', testMatch: SETUP_FILES, teardown: 'non-interference' },
            { name: 'non-interference', testMatch: NON_INTERFERENCE },
            { name: 'gate', grep: /@gate\b/, testIgnore: NON_INTERFERENCE, dependencies: ['snapshot'],
                // A browser for the session sentinel; no forced JSON Accept header on page loads.
                use: { ...devices['Desktop Chrome'], extraHTTPHeaders: {} } },
            // `@p1` rows except the gate: they run whether the gate is green or not (they explain a red gate).
            { name: 'api-p1', grep: /@p1\b/, grepInvert: /@gate\b/, testIgnore: NON_INTERFERENCE, dependencies: ['snapshot'] },
            // `@p2|@p3` rows: skipped when the gate fails.
            { name: 'api-rest', grep: /@p2\b|@p3\b/, testIgnore: NON_INTERFERENCE, dependencies: ['gate'] },
        ],
        { env, infrastructure: ['snapshot', 'non-interference'] },
    );
}

const asList = (v: RegExp | string | Array<RegExp | string> | undefined): Array<RegExp | string> => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const matches = (p: RegExp | string, file: string): boolean => (typeof p === 'string' ? file.includes(p) : (p.lastIndex = 0, p.test(file)));

/**
 * The names of the projects whose testMatch / testIgnore select a spec file path under the config's testDir (the
 * default testMatch `**\/*.@(spec|test).?(c|m)[jt]s?(x)` when none is set). Mirrors Playwright's file filter for the
 * forms this config uses (RegExps and plain strings), for the unit test of the logout-last ordering.
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
