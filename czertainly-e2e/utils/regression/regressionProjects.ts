/**
 * regressionProjects — the project table of playwright.regression.config.ts as a pure function, so a unit test can
 * check what the config selects without loading the config (which calls `prepareRun` at import).
 *
 * Guard-integration pass GD-14 (manifest decision "logout-last"): `REG-AUTH-99-logout.spec.ts` (REG-AUTH-03, the
 * identity-provider sign-out of the suite's admin browser session) must run after EVERY other regression row.
 * Playwright runs the files of a project alphabetically, so inside `regression` the REG-CFG / REG-DEP / REG-USE files
 * would follow it. It therefore gets its own project `logout`, the TEARDOWN project of `regression` (option A of the
 * design): Playwright 1.58 runs a teardown project after its setup project and all of that project's dependents,
 * failed or not (runner/tasks.js:295-308), and a teardown project may not have dependencies (common/config.js:239-240).
 * A `dependencies: ['regression']` project would instead be SKIPPED whenever any regression test is not ok
 * (runner/tasks.js:348-364): never use `dependencies` for it. `logout` is not infrastructure: the `@local` invert and
 * the `@phaseB` grep apply to it like to any row project. Order: regression rows → logout → non-interference (the
 * teardown of `snapshot`, whose dependents' closure includes `logout`) → the global runTeardown.
 */
import { devices, PlaywrightTestProject } from '@playwright/test';
import { withTierFilters } from './projectFilters';

export const SETUP_FILES = /_run-setup\.setup\.ts$/;
export const NON_INTERFERENCE = /API-GEN-33-non-interference\.api\.spec\.ts$/;
/** The one file of the `logout` project (REG-AUTH-03). */
export const LOGOUT_FILE = /REG-AUTH-99-logout\.spec\.ts$/;

/** The use / timeout the row projects share. */
const ROW_USE = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };

/** The regression config's projects (the tier rules folded in; `env` is the unit-test seam). */
export function regressionProjects(env: NodeJS.ProcessEnv = process.env): PlaywrightTestProject[] {
    return withTierFilters(
        [
            { name: 'snapshot', testDir: './tests/api', testMatch: SETUP_FILES, teardown: 'non-interference', timeout: 120_000 },
            { name: 'non-interference', testDir: './tests/api', testMatch: NON_INTERFERENCE, timeout: 120_000 },
            {
                name: 'regression',
                dependencies: ['snapshot'],
                teardown: 'logout',
                testIgnore: LOGOUT_FILE,
                use: ROW_USE,
            },
            // GD-14: the teardown project of `regression` — runs after every regression row, failed or not; no dependencies.
            { name: 'logout', testMatch: LOGOUT_FILE, use: ROW_USE },
        ],
        { env, infrastructure: ['snapshot', 'non-interference'] },
    );
}

const asList = (v: RegExp | string | Array<RegExp | string> | undefined): Array<RegExp | string> => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const matches = (p: RegExp | string, file: string): boolean => (typeof p === 'string' ? file.includes(p) : (p.lastIndex = 0, p.test(file)));

/**
 * The names of the projects whose testMatch / testIgnore select a spec file path under the config's testDir (the
 * default testMatch `**\/*.@(spec|test).?(c|m)[jt]s?(x)` when none is set). Mirrors Playwright's file filter for the
 * forms this config uses (RegExps and plain strings), for the unit test of GD-14.
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
