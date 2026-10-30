/**
 * areaFixtureLint — the shape rule of an area fixture (utils/regression/specLint/areaFixtures.ts).
 *
 * Checks inline fixture sources: the accepted shape (one extend that adds new names), and every way found to hand a spec
 * something under a trusted name (a redefined fixture, a spread or computed key, a second extend, an extend without an object
 * literal, a `.use(...)` call). The spec lint trusts `api`, `own`, `signedIn` by name; a case that stops failing is a hole.
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import { PLAYWRIGHT_FIXTURES, areaFixtureProblems, fixtureNamesOf, playwrightFixtureNamesOf } from '../../utils/regression/specLint/areaFixtures';
import { rawMutations } from '../../utils/regression/specLint/rawMutations';

const RESERVED = new Set([...PLAYWRIGHT_FIXTURES, 'api', 'anonymousApi', 'localApi', 'workerApi', 'own', 'live', 'needs', 'declaredNeeds', 'signedIn', 'regressionEnv', 'env']);
const HEAD = "import { test as base } from '../regressionFixtures';\n";
const FILE = 'fixtures/areas/x.ts';
/** The distinct rules found (one construct may break a rule twice, e.g. a raw input that is also a raw member name). */
const rules = (body: string, head = HEAD): string[] => [...new Set(areaFixtureProblems(head + body, FILE, RESERVED).map((p) => p.rule))];
const ONE = "export const test = base.extend<{ a: number }>({ a: async ({}, use) => { await use(1); } });\n";

test('the one shape is accepted: one base import, one exported extend that adds names, test and worker scope', () => {
    expect(rules(`export const test = base.extend<{ rig: number }, { seed: string }>({
    seed: [async ({}, use) => use('s'), { scope: 'worker' }],
    rig: async ({ api, seed: _s }, use) => { await api.get('/api/v1/roles'); await use(1); },
});
export { expect } from '../regressionFixtures';`)).toEqual([]);
    // the fixture callback `use(…)` is a plain call, not a `.use(…)`; another area fixture may be the base
    expect(rules(ONE)).toEqual([]);
    expect(rules(ONE, "import { test as base } from './otherArea';\n")).toEqual([]);
    expect(rules(ONE, "import type { Page } from '@playwright/test';\nimport { test as base, type Needs } from '../regressionFixtures';\n")).toEqual([]);
});

test('redefining a guarded, spec-facing or Playwright fixture is refused', () => {
    for (const name of ['api', 'localApi', 'anonymousApi', 'own', 'live', 'needs', 'signedIn', 'request', 'page', 'context', 'browser', 'playwright', 'baseURL', 'extraHTTPHeaders', 'storageState', 'ignoreHTTPSErrors']) {
        expect(rules(`export const test = base.extend({ ${name}: async ({ api }, use) => use(api) });`), name).toEqual(['reserved-name']);
        expect(rules(`export const test = base.extend({ '${name}': async ({}, use) => use(1) });`), `'${name}'`).toEqual(['reserved-name']);
    }
    expect(rules("export const test = base.extend({ async api({ request }, use) { await use(request); } });")).toEqual(['raw-source', 'reserved-name']);
    expect(rules("const api = async ({ request }, use) => use(request);\nexport const test = base.extend({ api });")).toEqual(['raw-source', 'extend-shape', 'reserved-name']);
    // a fixture written elsewhere cannot be read here: inline only
    expect(rules("const raw = async ({ request }, use) => use(request);\nexport const test = base.extend({ raw });")).toEqual(['raw-source', 'extend-shape']);
    expect(rules("const raw = async ({ request }, use) => use(request);\nexport const test = base.extend({ other: raw });")).toEqual(['raw-source', 'extend-shape']);
    expect(rules("export const test = base.extend({ get other() { return 1; } });")).toEqual(['extend-shape']);
});

test('a key that is not a plain name (spread, computed) is refused', () => {
    expect(rules("const more = {};\nexport const test = base.extend({ ...more });")).toEqual(['dynamic-key']);
    expect(rules("const k = 'api';\nexport const test = base.extend({ [k]: async ({}, use) => use(1) });")).toEqual(['dynamic-key']);
});

test('the shape is exactly one `export const test = base.extend({…})`', () => {
    expect(rules("export const test = base;")).toContain('extend-shape');
    expect(rules("export let test = base.extend({ a: async ({}, use) => use(1) });")).toContain('extend-shape');
    expect(rules("const fx = { a: async ({}, use) => use(1) };\nexport const test = base.extend(fx);")).toContain('extend-shape');
    expect(rules("const t = base.extend({ a: async ({}, use) => use(1) });\nexport const test = t;")).toEqual(expect.arrayContaining(['extend-shape']));
    // a comment or a string that only mentions the word in passing does not count; a string that IS the word does
    expect(rules("// base.extend({ api })\nconst s = 'x.extend(';\n" + ONE)).toEqual([]);
});

test('a second extend in any form is refused: again, aliased, destructured, .call / .apply / .bind, Reflect, element access', () => {
    const second = [
        "export const more = test.extend({ api: async ({ request }, use) => use(request) });",
        "const t2 = base.extend.call(base, { api: async ({ request }, use) => use(request) });",
        "const e = base.extend;\nconst t2 = e.call(base, { api: 1 });",
        "const t2 = Reflect.apply(base.extend, base, [{ api: 1 }]);",
        "const { extend } = base;\nconst t2 = extend({ api: 1 });",
        "const t2 = (base as any)['extend']({ api: 1 });",
        "const t2 = Reflect.get(base, 'ext' + 'end').call(base, { api: 1 });",
        "const b = base;\nconst t2 = b.extend({ api: 1 });",
        "const t2 = Reflect.get(test, 'ext' + 'end').call(test, { api: 1 });",
    ];
    for (const extra of second) {
        const found = rules(ONE + extra);
        expect(found.length, extra).toBeGreaterThan(0);
        expect(found.every((r) => ['extend-mention', 'base-use', 'test-reference', 'area-export', 'raw-source'].includes(r)), `${extra} → ${found}`).toBe(true);
    }
});

test('the base comes from one named import of test; default, namespace or a second import is refused', () => {
    expect(rules(ONE, "")).toEqual(expect.arrayContaining(['base-import']));
    expect(rules(ONE, "import * as rf from '../regressionFixtures';\nimport { test as base } from '../regressionFixtures';\n")).toEqual(['base-import']);
    expect(rules(ONE, "import { test as base } from '../regressionFixtures';\nimport { test as other } from '../testFixtures';\n")).toEqual(['base-import']);
    // a base from anywhere else is not a base (and the spec rules refuse a `test` from @playwright/test)
    expect(rules(ONE, "import { test as base } from '@playwright/test';\n")).toEqual(expect.arrayContaining(['base-import']));
});

test('no module is loaded around the static imports: require, import(), import = require', () => {
    expect(rules(ONE + "const m = require('../regressionFixtures');")).toEqual(['module-load']);
    expect(rules(ONE + "const run = async () => { const m = await import('../regressionFixtures'); };")).toEqual(['module-load']);
    expect(rules(ONE + "import m = require('../regressionFixtures');")).toEqual(['module-load']);
});

test('no fixture takes a raw source or reads its inputs undestructured, and the file never builds a context', () => {
    for (const src of ['request', 'playwright', 'browser', 'context', 'page']) {
        expect(rules(`export const test = base.extend<{ raw: unknown }>({ raw: async ({ ${src} }, use) => use(${src}) });`), src).toEqual(['raw-source']);
        expect(rules(`export const test = base.extend<{ raw: unknown }>({ raw: [async ({ ${src}: x }, use) => use(x), { scope: 'worker' }] });`), `${src}: x`).toEqual(['raw-source']);
    }
    expect(rules("export const test = base.extend<{ raw: unknown }>({ async raw({ request }, use) { await use(request); } });")).toEqual(['raw-source']);
    expect(rules("export const test = base.extend<{ raw: unknown }>({ raw: async (all, use) => use(all) });")).toEqual(['raw-source']);
    expect(rules("export const test = base.extend<{ raw: unknown }>({ raw: async ({ ...all }, use) => use(all) });")).toEqual(['raw-source']);
    expect(rules("export const test = base.extend<{ raw: unknown }>({ raw: async ({ ['req' + 'uest']: r }, use) => use(r) });")).toEqual(['raw-source']);
    expect(rules("import { request } from '@playwright/test';\nconst make = () => request.newContext();\n" + ONE)).toEqual(['raw-source']);
    // a page is no input (a page reaches a raw context), nor a token
    for (const input of ['signedIn', 'adminToken', 'restrictedToken', 'browserName', 'baseURL', 'env', 'regressionEnv']) {
        expect(rules(`export const test = base.extend<{ raw: unknown }>({ raw: async ({ ${input} }, use) => use(${input}) });`), input).toEqual(['raw-source']);
    }
    // a raw member reached on any object, by access, destructuring or reflection
    for (const body of ['await use(own.request);', 'await use(own.context().request);', 'const c = own.context(); await use(c.request);',
        'await use(own.context().browser());', "await use(own['request']);", "const k = 'request'; await use(own[k]);",
        'const { request } = own; await use(request);', 'const { context: c } = own; await use(c);', "const { 'request': r } = own; await use(r);",
        "await use(Reflect.get(own, 'req' + 'uest'));", 'await use(Object.getOwnPropertyDescriptor(own, x));', 'await use(new Proxy(own, {}));']) {
        const found = rules(`export const test = base.extend<{ raw: unknown }>({ raw: async ({ own }, use) => { ${body} } });`);
        expect(found.length, body).toBeGreaterThan(0);
        expect(found.every((r) => r === 'raw-source'), `${body} → ${found}`).toBe(true);
    }
    // no credential member is read from any object, by access or destructuring (the inputs are checked above)
    for (const body of ['await use({ p: own.userPassword });', 'await use(own.restrictedPassword);', 'await use(own.kubeconfig);',
        'await use(own.cmAuthSecret);', 'const { userPassword } = own; await use(userPassword);', "const { 'restrictedUsername': u } = own; await use(u);",
        'await use(own.credentialConnector);', 'await use(own.accessToken);', 'await use(own.adminToken);', 'await use(own.bearer);', 'await use(own.privateKey);']) {
        expect(rules(`export const test = base.extend<{ creds: unknown }>({ creds: async ({ own }, use) => { ${body} } });`), body).toEqual(['secret-read']);
    }
    // a cryptographic token object (the platform's key store) and its profile are no credential
    expect(rules("export const test = base.extend<{ chain: unknown }>({ chain: async ({ own }, use) => { const c = await own.chain(); await use({ token: c.token, profile: c.tokenProfile }); } });")).toEqual([]);
    // nor the cookies or headers of a guarded context
    for (const body of ['await use(await api.storageState());', "await use((await api.get('/x')).headers());", "await use(await (await api.get('/x')).allHeaders());"]) {
        expect(rules(`export const test = base.extend<{ raw: unknown }>({ raw: async ({ api }, use) => { ${body} } });`), body).toEqual(['raw-source']);
    }
    // the guarded fixtures, the fixtures of the file and those of the extended area are fine inputs
    expect(rules("export const test = base.extend<{ a: number; b: number }>({ a: async ({ api, own, live, needs, localApi, ownRaProfile }, use) => use(1), b: async ({ a }, use) => use(a) });")).toEqual([]);
    expect(areaFixtureProblems(HEAD + "export const test = base.extend<{ b: number }>({ b: async ({ seed }, use) => use(seed) });", FILE, RESERVED, new Set(['seed'])).map((p) => p.rule)).toEqual([]);
});

test('only test, expect and types leave an area fixture', () => {
    expect(rules(ONE + "export { expect } from '../regressionFixtures';\nexport type Rig = number;\nexport interface Seed { a: number }")).toEqual([]);
    for (const extra of [
        "export const t2 = 1;",
        "export function helper() { return 1; }",
        "export class Rig {}",
        "export default 1;",
        "export * from '../regressionFixtures';",
        "const t2 = 1;\nexport { t2 };",
        "const t2 = 1;\nexport { t2 as test2 };",
    ]) expect(rules(ONE + extra), extra).toContain('area-export');
});

test('a spec takes only test, expect and types from an area fixture', () => {
    const spec = (src: string): string[] => rawMutations(src, 'tests/regression/X.spec.ts').map((m) => m.rule);
    expect(spec("import { test, expect, type Rig } from '../../fixtures/areas/certificateList';")).toEqual([]);
    expect(spec("import { t2 as test } from '../../fixtures/areas/certificateList';")).toEqual(['test-import']);
    expect(spec("import { helper } from '../../fixtures/areas/certificateList';")).toEqual(['test-import']);
    expect(spec("import * as area from '../../fixtures/areas/certificateList';")).toEqual(['test-import']);
    expect(spec("import area from '../../fixtures/areas/certificateList';")).toEqual(['test-import']);
});

test('an area fixture calls no .use(…) (no option override of the base)', () => {
    expect(rules("base.use({ baseURL: 'https://elsewhere' });\n" + ONE)).toEqual(expect.arrayContaining(['fixture-use']));
    expect(rules(ONE + "test['use']({ ignoreHTTPSErrors: true });")).toEqual(expect.arrayContaining(['fixture-use']));
});

test('fixtureNamesOf lists the plain keys of every extend in a fixtures file', () => {
    expect(fixtureNamesOf("export const test = base.extend<{ a: 1 }>({ a: async ({}, use) => use(1), 'b': [async ({}, use) => use(2), { scope: 'worker' }] });", 'f.ts')).toEqual(['a', 'b']);
    expect(fixtureNamesOf("const x = 1;", 'f.ts')).toEqual([]);
});

test("the Playwright list equals the installed Playwright's fixture and option names", () => {
    const dts = fs.readFileSync(path.resolve(__dirname, '..', '..', 'node_modules', 'playwright', 'types', 'test.d.ts'), 'utf8');
    const installed = playwrightFixtureNamesOf(dts);
    expect(installed).toEqual(expect.arrayContaining(['page', 'request', 'baseURL', 'storageState']));
    expect([...new Set(installed)].sort()).toEqual([...PLAYWRIGHT_FIXTURES].sort());
});
