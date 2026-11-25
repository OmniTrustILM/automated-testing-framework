/**
 * flows — unit tests of the main / secondary split (utils/regression/flows.ts) in both project tables.
 */
import { test, expect, PlaywrightTestProject } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { flowOf, flowPattern, SECONDARY_FLOW } from '../../utils/regression/flows';
import { apiProjects, LOGOUT_FILE, projectsSelectingFile, regressionProjects } from '../../utils/regression/regressionProjects';

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN_API = 'tests/api/02-certificates/revoke.api.spec.ts';
const SECONDARY_API = 'tests/api/05-discovery/create-rejections.api.spec.ts';
const MAIN_REG = 'tests/regression/12-main-usage/05-issue-with-an-acme-client.spec.ts';
const SIGN_OUT = 'tests/regression/01-sign-in-and-access/99-sign-out.spec.ts';

const rows = (projects: PlaywrightTestProject[], names: string[]) => projects.filter((p) => names.includes(p.name ?? ''));
const regRows = (env: NodeJS.ProcessEnv) => rows(regressionProjects(env), ['regression', 'logout']);
const apiRows = (env: NodeJS.ProcessEnv) => rows(apiProjects(env), ['api-p1', 'api-rest']);
const rowProjectsOf = (file: string, env: NodeJS.ProcessEnv) => (file.startsWith('tests/api/')
    ? projectsSelectingFile(apiRows(env), file, './tests/api')
    : projectsSelectingFile(regRows(env), file));

test('REG_FLOW is main by default, takes main, secondary and all, and refuses anything else', () => {
    expect(flowOf({})).toBe('main');
    expect(flowOf({ REG_FLOW: ' ' })).toBe('main');
    for (const flow of ['main', 'secondary', 'all'] as const) expect(flowOf({ REG_FLOW: flow })).toBe(flow);
    expect(() => flowOf({ REG_FLOW: 'Secondary' })).toThrow('REG_FLOW="Secondary" is not one of main, secondary, all');
    expect(() => regressionProjects({ REG_FLOW: 'nightly' }), 'a config with an unknown flow does not load').toThrow(/REG_FLOW/);
});

test('a folder entry matches the files below it only, a file entry exactly that file', () => {
    const folder = flowPattern('tests/api/05-discovery/');
    expect(folder.test('tests/api/05-discovery/a.api.spec.ts')).toBe(true);
    expect(folder.test('/w/czertainly-e2e/tests/api/05-discovery/sub/a.api.spec.ts')).toBe(true);
    expect(folder.test('C:\\w\\tests\\api\\05-discovery\\a.api.spec.ts'), 'a Windows path').toBe(true);
    expect(folder.test('tests/api/05-discovery-x/a.api.spec.ts')).toBe(false);
    expect(folder.test('tests/api/x05-discovery/a.api.spec.ts')).toBe(false);
    const file = flowPattern('tests/api/06-groups/crud.api.spec.ts');
    expect(file.test('/w/czertainly-e2e/tests/api/06-groups/crud.api.spec.ts')).toBe(true);
    expect(file.test('tests/api/06-groups/crud.api.spec.ts.bak')).toBe(false);
    expect(file.test('tests/api/06-groups/xcrud.api.spec.ts')).toBe(false);
    expect(file.test('tests/api/06-groups/crud-api-spec-ts'), 'the dots are literal').toBe(false);
});

test('main leaves the secondary files out of the row projects, secondary keeps only them, all keeps both', () => {
    expect(rowProjectsOf(MAIN_API, {})).toEqual(['api-p1', 'api-rest']);
    expect(rowProjectsOf(SECONDARY_API, {})).toEqual([]);
    expect(rowProjectsOf(MAIN_REG, {})).toEqual(['regression']);
    expect(rowProjectsOf(MAIN_API, { REG_FLOW: 'secondary' })).toEqual([]);
    expect(rowProjectsOf(SECONDARY_API, { REG_FLOW: 'secondary' })).toEqual(['api-p1', 'api-rest']);
    expect(rowProjectsOf(MAIN_REG, { REG_FLOW: 'secondary' })).toEqual([]);
    expect(rowProjectsOf(SIGN_OUT, { REG_FLOW: 'secondary' }), 'logout keeps its own file').toEqual(['logout']);
    for (const file of [MAIN_API, SECONDARY_API]) expect(rowProjectsOf(file, { REG_FLOW: 'all' }), file).toEqual(['api-p1', 'api-rest']);
    expect(rowProjectsOf(MAIN_REG, { REG_FLOW: 'all' })).toEqual(['regression']);
});

test('the run infrastructure and the gate run in every flow', () => {
    for (const flow of ['main', 'secondary', 'all']) {
        const reg = regressionProjects({ REG_FLOW: flow });
        expect(projectsSelectingFile(reg, 'tests/api/tier-snapshot.setup.ts'), flow).toEqual(['snapshot']);
        expect(projectsSelectingFile(reg, 'tests/api/run-objects.setup.ts'), flow).toEqual(['run-setup']);
        expect(projectsSelectingFile(reg, 'tests/api/tier-non-interference.api.spec.ts'), flow).toEqual(['non-interference']);
        const gate = apiProjects({ REG_FLOW: flow }).filter((p) => p.name === 'gate');
        expect(projectsSelectingFile(gate, MAIN_API, './tests/api'), flow).toEqual(['gate']);
    }
});

test('every entry names a file or folder of the tree in path order, and every row spec belongs to exactly one flow', () => {
    for (const entry of SECONDARY_FLOW) {
        const p = path.join(ROOT, entry);
        expect(fs.existsSync(p), `${entry} exists`).toBe(true);
        expect(fs.statSync(p).isDirectory(), `${entry}: a folder entry ends with "/"`).toBe(entry.endsWith('/'));
    }
    expect([...SECONDARY_FLOW].sort(), 'the list is kept in path order').toEqual(SECONDARY_FLOW);
    const SPEC = /\.(spec|test)\.[cm]?[jt]sx?$/;
    const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.posix.join(dir, e.name)) : SPEC.test(e.name) ? [path.posix.join(dir, e.name)] : []));
    const specs = [...walk('tests/api'), ...walk('tests/regression')];
    let secondary = 0;
    for (const file of specs) {
        const inMain = rowProjectsOf(file, {}).length > 0;
        const inSecondary = rowProjectsOf(file, { REG_FLOW: 'secondary' }).length > 0;
        const inAll = rowProjectsOf(file, { REG_FLOW: 'all' }).length > 0;
        expect(inAll, `${file}: all runs what main or secondary runs`).toBe(inMain || inSecondary);
        if (inAll) expect(inMain && inSecondary, `${file} is in one flow only`).toBe(false);
        expect(LOGOUT_FILE.test(file) && inMain, `${file}: the sign-out spec is a secondary file`).toBe(false);
        if (inSecondary) secondary++;
    }
    expect(secondary, 'the secondary flow selects files').toBeGreaterThan(0);
});
