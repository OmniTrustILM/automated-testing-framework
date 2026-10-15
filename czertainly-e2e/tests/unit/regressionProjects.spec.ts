/**
 * GD-14 (logout-last): the regression config's project table (utils/regression/regressionProjects.ts) — the logout file
 * is selected by the `logout` project only, every other REG file by `regression` only, nothing twice; `logout` is the
 * TEARDOWN of `regression` (runs after failed rows too) and has no dependencies (a teardown may not, and a
 * `dependencies` project would be skipped on any red row: playwright runner/tasks.js:348-364); it is not infrastructure,
 * so the `@local` invert and the `@phaseB` grep apply to it. The real `--list` is part of the exit check.
 */
import { test, expect } from '@playwright/test';
import { resolveProjectFilters, selects } from '../../utils/regression/projectFilters';
import { LOGOUT_FILE, projectsSelectingFile, regressionProjects } from '../../utils/regression/regressionProjects';

const FILES = [
    'tests/regression/REG-AUTH-01-login.spec.ts', 'tests/regression/REG-AUTH-99-logout.spec.ts', 'tests/regression/REG-CFG-01-x.spec.ts',
    'tests/regression/REG-USE-05-acme.spec.ts', 'tests/regression/REG-ZZZ-01-last.spec.ts', 'tests/regression/sub/REG-AUTH-99-logout.spec.ts',
];

test('u1: the logout file is selected by `logout` only, every other REG spec by `regression` only, no file twice', () => {
    const projects = regressionProjects({});
    expect(projects.map((p) => p.name)).toEqual(['snapshot', 'non-interference', 'regression', 'logout']);
    for (const f of FILES) {
        const names = projectsSelectingFile(projects.filter((p) => p.name === 'regression' || p.name === 'logout'), f);
        expect(names, f).toEqual(LOGOUT_FILE.test(f) ? ['logout'] : ['regression']);
    }
    expect(projectsSelectingFile(projects, 'tests/api/_run-setup.setup.ts')).toEqual(['snapshot']);
    expect(projectsSelectingFile(projects, 'tests/api/API-GEN-33-non-interference.api.spec.ts')).toEqual(['non-interference']);
});

test('u2: `logout` is the teardown project of `regression`, has no dependencies and shares its browser use', () => {
    const projects = regressionProjects({});
    const regression = projects.find((p) => p.name === 'regression')!;
    const logout = projects.find((p) => p.name === 'logout')!;
    expect(regression.teardown).toBe('logout');
    expect(regression.dependencies).toEqual(['snapshot']);
    expect(logout.dependencies, 'never a dependencies project (a red row would skip it); a teardown may not have any').toBeUndefined();
    expect(logout.teardown).toBeUndefined();
    expect(logout.use).toEqual(regression.use);
    expect(logout.timeout).toEqual(regression.timeout);
    expect(projects.find((p) => p.name === 'snapshot')!.teardown).toBe('non-interference');
    // Playwright 1.58 refuses a teardown with dependencies and a dependency on a teardown: neither is declared.
    expect(projects.filter((p) => p.dependencies?.includes('logout') || p.dependencies?.includes('non-interference'))).toEqual([]);
});

test('u3: `logout` is not infrastructure — the @local invert and the @phaseB grep apply to it like to `regression`', () => {
    const [, , regression, logout] = resolveProjectFilters({ projects: regressionProjects({ REG_PHASE: 'B' }) });
    for (const p of [regression, logout]) {
        expect(selects(p, 'REG-AUTH-03 @regression @phaseB')).toBe(true);
        expect(selects(p, 'REG-AUTH-03 @regression')).toBe(false);
        expect(selects(p, 'REG-AUTH-03 @regression @phaseB @local')).toBe(false);
    }
    const [, , regressionA, logoutA] = resolveProjectFilters({ projects: regressionProjects({}) });
    for (const p of [regressionA, logoutA]) {
        expect(selects(p, 'REG-AUTH-03 @regression')).toBe(true);
        expect(selects(p, 'REG-AUTH-03 @regression @local')).toBe(false);
    }
    const [snapshot] = resolveProjectFilters({ projects: regressionProjects({ REG_PHASE: 'B' }) });
    expect(selects(snapshot, 'setup')).toBe(true);
});
