/**
 * The run-setup project and logout-last: the regression config's project table (utils/regression/regressionProjects.ts) — the logout file
 * is selected by the `logout` project only, every other REG file by `regression` only, nothing twice; `logout` is the
 * TEARDOWN of `regression` (runs after failed rows too) and has no dependencies (a teardown may not, and a
 * `dependencies` project would be skipped on any red row: playwright runner/tasks.js:348-364); it is not infrastructure,
 * so the `@local` invert and the `@phaseB` grep apply to it. The real `--list` is part of the exit check.
 *
 * `run-setup` makes the run objects once: it depends on `snapshot`, `regression` depends on it, it is infrastructure (kept by
 * REG_PHASE=B, `@local` still excluded), `regression` ignores its file, and the API config neither has it nor depends on it (its
 * `api-p1` rows must run when the gate is red). Order: snapshot → run-setup → regression → logout, then non-interference.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { resolveProjectFilters, selectsTest } from '../../utils/regression/projectFilters';
import { apiProjects, LOGOUT_FILE, projectsSelectingFile, regressionProjects, RUN_SETUP_FILES } from '../../utils/regression/regressionProjects';

const FILES = [
    'tests/regression/01-sign-in-and-access/01-login.spec.ts', 'tests/regression/01-sign-in-and-access/99-sign-out.spec.ts',
    'tests/regression/03-configuration/01-x.spec.ts', 'tests/regression/12-main-usage/05-acme.spec.ts', 'tests/regression/13-last-area/01-last.spec.ts',
    'tests/regression/03-configuration/99-sign-out.spec.ts',
];
const RUN_SETUP = 'tests/api/run-objects.setup.ts';

test('the logout file is selected by logout only, every other REG spec by regression only, no file twice', () => {
    const projects = regressionProjects({});
    expect(projects.map((p) => p.name)).toEqual(['snapshot', 'non-interference', 'run-setup', 'regression', 'logout']);
    for (const f of FILES) {
        const names = projectsSelectingFile(projects.filter((p) => p.name === 'regression' || p.name === 'logout'), f);
        expect(names, f).toEqual(LOGOUT_FILE.test(f) ? ['logout'] : ['regression']);
    }
    // The logout file is the sign-out spec of the sign-in and access folder, anchored at a path boundary.
    expect(LOGOUT_FILE.test('tests/regression/01-sign-in-and-access/99-sign-out.spec.ts')).toBe(true);
    expect(LOGOUT_FILE.test('tests/regression/01-sign-in-and-access/98-sign-out.spec.ts')).toBe(false);
    expect(LOGOUT_FILE.test('tests/regression/03-configuration/99-sign-out.spec.ts')).toBe(false);
    expect(LOGOUT_FILE.test('tests/regression/x01-sign-in-and-access/99-sign-out.spec.ts')).toBe(false);
    expect(LOGOUT_FILE.test('01-sign-in-and-access/99-sign-out.spec.ts')).toBe(true);
    expect(LOGOUT_FILE.test('tests\\regression\\01-sign-in-and-access\\99-sign-out.spec.ts'), 'a Windows path').toBe(true);
    expect(projectsSelectingFile(projects, 'tests/api/tier-snapshot.setup.ts')).toEqual(['snapshot']);
    expect(projectsSelectingFile(projects, 'tests/api/tier-non-interference.api.spec.ts')).toEqual(['non-interference']);
    expect(projectsSelectingFile(projects, RUN_SETUP), 'the run-setup file belongs to run-setup only').toEqual(['run-setup']);
    expect(projectsSelectingFile(projects.filter((p) => p.name === 'regression'), RUN_SETUP.replace('tests/api', 'tests/regression')), 'regression ignores it wherever it sits').toEqual([]);
    expect(RUN_SETUP_FILES.test(RUN_SETUP)).toBe(true);
    expect(RUN_SETUP_FILES.test('tests/api/other-run-objects.setup.ts.bak')).toBe(false);
});

test('run-setup runs after snapshot and before regression, and is infrastructure', () => {
    const projects = regressionProjects({});
    const byName = (name: string) => projects.find((p) => p.name === name)!;
    expect(byName('run-setup').dependencies).toEqual(['snapshot']);
    expect(byName('regression').dependencies, 'regression waits for the run objects (and, through them, for the snapshot)').toEqual(['run-setup']);
    expect(byName('run-setup').teardown).toBeUndefined();
    // The order Playwright derives from the dependencies: every project after the ones it depends on.
    const order: string[] = [];
    const place = (name: string): void => {
        if (order.includes(name)) return;
        for (const dep of byName(name).dependencies ?? []) place(dep);
        order.push(name);
    };
    for (const p of projects.filter((x) => x.name !== 'logout' && x.name !== 'non-interference')) place(p.name!);
    expect(order).toEqual(['snapshot', 'run-setup', 'regression']);
    // REG_PHASE=B keeps the setup (infrastructure: no @phaseB grep), and the @local invert still applies to it.
    const [, , setupB] = resolveProjectFilters({ projects: regressionProjects({ REG_PHASE: 'B' }) });
    expect(setupB.name).toBe('run-setup');
    expect(selectsTest(setupB, 'REG-RUN-01 @regression')).toBe(true);
    expect(selectsTest(setupB, 'REG-RUN-01 @regression @local')).toBe(false);
    const [, , setupA] = resolveProjectFilters({ projects: regressionProjects({}) });
    expect(selectsTest(setupA, 'REG-RUN-01 @regression')).toBe(true);
});

test('logout is the teardown project of regression, has no dependencies and shares its browser use', () => {
    const projects = regressionProjects({});
    const regression = projects.find((p) => p.name === 'regression')!;
    const logout = projects.find((p) => p.name === 'logout')!;
    expect(regression.teardown).toBe('logout');
    expect(regression.dependencies).toEqual(['run-setup']);
    expect(logout.dependencies, 'never a dependencies project (a red row would skip it); a teardown may not have any').toBeUndefined();
    expect(logout.teardown).toBeUndefined();
    expect(logout.use).toEqual(regression.use);
    expect(logout.timeout).toEqual(regression.timeout);
    expect(projects.find((p) => p.name === 'snapshot')!.teardown).toBe('non-interference');
    // Playwright 1.58 refuses a teardown with dependencies and a dependency on a teardown: neither is declared.
    expect(projects.filter((p) => p.dependencies?.includes('logout') || p.dependencies?.includes('non-interference'))).toEqual([]);
});

test('logout is not infrastructure: the @local invert and @phaseB grep apply to it like to regression', () => {
    const [, , , regression, logout] = resolveProjectFilters({ projects: regressionProjects({ REG_PHASE: 'B' }) });
    for (const p of [regression, logout]) {
        expect(selectsTest(p, 'REG-AUTH-03 @regression @phaseB')).toBe(true);
        expect(selectsTest(p, 'REG-AUTH-03 @regression')).toBe(false);
        expect(selectsTest(p, 'REG-AUTH-03 @regression @phaseB @local')).toBe(false);
    }
    const [, , , regressionA, logoutA] = resolveProjectFilters({ projects: regressionProjects({}) });
    for (const p of [regressionA, logoutA]) {
        expect(selectsTest(p, 'REG-AUTH-03 @regression')).toBe(true);
        expect(selectsTest(p, 'REG-AUTH-03 @regression @local')).toBe(false);
    }
    const [snapshot] = resolveProjectFilters({ projects: regressionProjects({ REG_PHASE: 'B' }) });
    expect(selectsTest(snapshot, 'setup')).toBe(true);
});

// the API projects: snapshot → gate → first and rest API projects, the regexes shared with the regression config
test('the API projects: snapshot, gate, then the first and rest projects share the config regexes', () => {
    const projects = apiProjects({});
    expect(projects.map((p) => p.name)).toEqual(['snapshot', 'non-interference', 'gate', 'api-p1', 'api-rest']);
    const files = (name: string, file: string) => projectsSelectingFile(projects.filter((p) => p.name === name), file, './tests/api');
    expect(files('snapshot', 'tests/api/tier-snapshot.setup.ts')).toEqual(['snapshot']);
    expect(files('non-interference', 'tests/api/tier-non-interference.api.spec.ts')).toEqual(['non-interference']);
    for (const p of ['gate', 'api-p1', 'api-rest']) expect(files(p, 'tests/api/tier-non-interference.api.spec.ts'), p).toEqual([]);
    const resolved = resolveProjectFilters({ projects });
    const sel = (name: string, title: string) => selectsTest(resolved.find((f) => f.name === name)!, title);
    expect(sel('gate', 'x @api @gate @p1')).toBe(true);
    expect(sel('api-p1', 'x @api @gate @p1'), 'the gate is not repeated in api-p1').toBe(false);
    expect(sel('api-p1', 'x @api @p1')).toBe(true);
    expect(sel('api-rest', 'x @api @p3')).toBe(true);
    expect(sel('api-rest', 'x @api @p2 @local'), 'the @local invert applies').toBe(false);
    expect(projects.find((p) => p.name === 'api-rest')!.dependencies).toEqual(['gate']);
    expect(projects.find((p) => p.name === 'snapshot')!.teardown).toBe('non-interference');
    // The setup is not part of the API config: no project of it, none depends on it, and no file of it is selected.
    expect(projects.map((p) => p.name)).not.toContain('run-setup');
    expect(projects.filter((p) => p.dependencies?.includes('run-setup'))).toEqual([]);
    for (const p of projects) expect(projectsSelectingFile([p], RUN_SETUP, './tests/api'), `${p.name} does not select the run-setup file`).toEqual([]);
});

test('in the real tree the sign-out spec is the only file of the logout project and no other regression test file matches', () => {
    const root = path.resolve(__dirname, '..', '..');
    // every file Playwright's default testMatch would pick up: *.spec / *.test with a ts, js, tsx, jsx, mts, cts, mjs or cjs extension
    const PLAYWRIGHT_TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;
    const walk = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.posix.join(dir, e.name)) : PLAYWRIGHT_TEST_FILE.test(e.name) ? [path.posix.join(dir, e.name)] : []));
    const specs = walk('tests/regression');
    expect(specs.length, 'the regression tree holds specs').toBeGreaterThan(15);
    // The sign-out spec lives in the secondary tree; the main-flow branch has none and its logout project selects nothing.
    const signOut = specs.filter((f) => LOGOUT_FILE.test(f));
    expect(signOut).toEqual(signOut.length ? ['tests/regression/01-sign-in-and-access/99-sign-out.spec.ts'] : []);
    const projects = regressionProjects({}).filter((p) => p.name === 'regression' || p.name === 'logout');
    const byProject = (name: string) => specs.filter((f) => projectsSelectingFile(projects.filter((p) => p.name === name), f).includes(name));
    expect(byProject('logout')).toEqual(signOut);
    expect(byProject('regression').length + signOut.length, 'every spec belongs to exactly one of the two projects').toBe(specs.length);
});
