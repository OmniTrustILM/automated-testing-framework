/**
 * rawMutations — the deny-by-default lint of the REG / API specs and helpers (utils/regression/specLint/rawMutations.ts,
 * rules.ts, bindings.ts): raw contexts, request methods, imports by allow-list, env and fs writes, dynamic code, request
 * options and the token fixtures.
 *
 * WHAT: lints inline sources and checks the rules reported (line and rule name) or that nothing is reported; the
 * last block gives every rule of the table one positive and one negative case.
 * WHY: the lint is the proof that no spec can reach a shared tier around the guarded context; a rule that stops
 * firing is a hole, a rule that fires on clean code blocks the suite.
 * HOW: pure unit cases over `rawMutations` (the real tree is linted by specGuards.spec.ts).
 */
import { test, expect } from '@playwright/test';
import { RawMutationRule, rawMutations, rawMutationsWith } from '../../utils/regression/specLint/rawMutations';
import { RULES, type Rule } from '../../utils/regression/specLint/rules';

// The sources in this file are linted, never compiled: an `as any` inside one is lint input, not a cast of this file.
const lint = (src: string, file = 'tests/api/X.spec.ts') => rawMutations(src, file).map((m) => `${m.line} ${m.rule}`);

// deny by default: the api fixture, GuardedApi parameters and guard factories may mutate; raw contexts may only read
test('deny by default: api fixture, GuardedApi and guard factories may mutate; raw contexts read', () => {
    const src = `
test('T-1', async ({ api, request, page, env }) => {
    await api.delete('/api/v1/roles/1');
    const alias = api;
    await alias.patch('/api/v1/x');
    await apiJson(api, 'PUT', '/api/v1/roles/1', {});
    await send(api, 'DELETE', '/api/v1/roles/1');
    await api['delete']('/api/v1/roles/1');
    await request.get('/api/v1/roles');
    await page.request.get('/api/v1/roles');
    const g = await getGuardedApiContext(request, env);
    await g.put('/api/v1/roles/1', {});
    await guardApi(await other(env)).post('/api/v1/certificates/1/renew');
});
async function helper(api: GuardedApi) { await api.patch('/api/v1/x'); await apiJsonWithDate(api, 'PATCH', '/api/v1/x'); }`;
    expect(lint(src)).toEqual([]);
});

// raw contexts: every non-GET method, POST included, unless the literal URL is a read-only / protocol POST (creates included)
test('raw contexts: every non-GET method is flagged unless the literal URL is a read-only or protocol POST', () => {
    const src = `
test('T-1', async ({ request, page }) => {
    await request.post('/api/v1/certificates/1/revoke');
    await request.post('/api/v1/roles', { data: {} });
    await page.request.post('/api/v1/roles');
    await page.request.patch('/api/v1/roles/1');
});
async function f(raw: APIRequestContext, uuid: string, m: string) {
    await raw.post('/api/v1/roles', { data: {} });
    await raw.post(\`/api/v1/authorities/\${uuid}/raProfiles\`, { data: {} });
    await raw.post(\`/api/v1/certificates/\${uuid}/renew\`);
    await raw.post(\`\${base}/certificates\`);
    await raw.post(allowedRawPost(url));
    await raw.put('/api/v1/roles/1');
    await raw.fetch('/api/v1/roles/1', { method: 'DELETE' });
    await raw.fetch('/api/v1/roles', { method: 'POST' });
    await raw.fetch('/api/v1/roles/1', { method: m });
    await raw.fetch('/api/v1/roles/1', { ...opts });
    await raw.fetch('/api/v1/roles/1');
    await raw.get('/api/v1/roles/1');
    await raw.post('/api/v1/certificates', { data: {} });
    await raw.post(\`/api/v1/connectors/\${uuid}/authorityProvider/ejbca/validate\`, { data: [] });
}`;
    expect(lint(src)).toEqual([
        '3 raw-request-use',
        '4 raw-request-use',
        '5 raw-request-use',
        '6 raw-request-use',
        '9 context-method',
        '10 context-method',
        '11 context-method',
        '12 context-method',
        '14 context-method',
        '15 fetch-method',
        '16 fetch-method',
        '17 fetch-method',
        '18 fetch-method',
    ]);
});

test('aliases, element access, dynamic methods, method extraction and casts are caught', () => {
    const src = `
async function f(raw: APIRequestContext, m: string, ctx: { api: APIRequestContext }) {
    const c = raw;
    await c.delete('/api/v1/roles/1');
    await raw['delete']('/api/v1/roles/1');
    await raw['post']('/api/v1/certificates/1/revoke');
    await raw[m]('/api/v1/roles/1');
    const del = raw.delete;
    const bound = raw.patch.bind(raw);
    await ctx.api.patch('/api/v1/x');
    const forged = raw as unknown as GuardedApi;
    let g = guardApi(raw);
    g = raw;
    const seen = new Set<string>();
    seen.delete('k');
    unknownThing.delete('k');
}`;
    expect(lint(src)).toEqual([
        '4 context-method',
        '5 context-method',
        '6 context-method',
        '7 dynamic-method',
        '8 method-extraction',
        '9 method-extraction',
        '10 context-method',
        '11 guarded-cast',
        '13 guarded-reassign',
        '16 context-method',
    ]);
});

test('a binding guarded in one function is not trusted in another (symbols, not names)', () => {
    const src = `
test('T-1', async ({ api }) => { await api.delete('/api/v1/roles/1'); });
async function other(api: APIRequestContext) { await api.delete('/api/v1/roles/1'); }`;
    expect(lint(src)).toEqual(['3 context-method']);
});

test('apiJson variants, aliases and namespace calls, the template send, and global fetch', () => {
    const src = `
import { apiJson as aj, apiJsonWithDate } from '../../utils/regression/apiReads';
import * as ra from '../../utils/regression/apiReads';
async function f(raw: APIRequestContext, m: 'GET' | 'PATCH') {
    await aj(raw, 'PATCH', '/api/v1/x');
    await apiJsonWithDate(raw, 'DELETE', '/api/v1/roles/1');
    await ra.apiJson(raw, 'PUT', '/api/v1/roles/1');
    const j = aj;
    await j(raw, 'PATCH', '/api/v1/x');
    await aj(raw, m, '/api/v1/x');
    await aj(raw, 'GET', '/api/v1/x');
    await aj(raw, 'POST', '/api/v1/certificates', {});
    await send(raw, 'PUT', '/api/v1/roles/1');
    await fetch('/api/v1/roles/1', { method: 'DELETE' });
    await fetch(url, { method: 'POST' });
    await fetch(allowedRawPost(url), { method: 'POST' });
    await fetch(url);
    await fetch(url, { method: 'HEAD' });
    const x = new XMLHttpRequest();
}`;
    expect(lint(src)).toEqual([
        '5 apiJson',
        '6 apiJson',
        '7 apiJson',
        '9 apiJson',
        '10 apiJson',
        '13 send-method',
        '14 fetch-method',
        '15 fetch-method',
        '19 raw-xhr',
    ]);
});

// the anonymous context factory belongs to the fixtures: any reference in a spec or a helper is a raw context
test('the anonymous context factory belongs to the fixtures: any use in a spec or helper is a raw context', () => {
    const src = `
import { newAnonymousContext } from '../../utils/auth/apiContext';
test('T-1', async ({ env }) => {
    const anon = await newAnonymousContext(env);
    const f = newAnonymousContext;
});`;
    expect(lint(src)).toEqual(['2 raw-context', '4 raw-context', '5 raw-context']);
    expect(lint(src, 'utils/regression/x.ts'), 'a regression helper too').toEqual(['2 raw-context', '4 raw-context', '5 raw-context']);
});

test('raw contexts and test seams: getAuthenticatedApiContext, the request factory, guardApiWithSeams', () => {
    const src = `
import { request as pw } from '@playwright/test';
import { getAuthenticatedApiContext } from '../../fixtures/testFixtures';
test('T-1', async ({ request, env }) => {
    const raw = await getAuthenticatedApiContext(request, env);
    const g = guardApiWithSeams(raw, { lines: [] });
    await ensureRole(request as any, 'X');
});`;
    expect(lint(src)).toEqual([
        '2 raw-context',
        '3 raw-context',
        '5 raw-context',
        '5 raw-request-use',
        '6 unit-seam',
        '7 raw-request-use',
    ]);
});

// util imports: allow-list by prefix, no namespace / default / require / dynamic import, type-only is fine
test('util imports: allow-list by prefix; no namespace, default, require or dynamic import; type-only fine', () => {
    const src = `
import { deleteCertificate, waitForCertificateState, uploadCertificate } from '../../utils/certificateUtils';
import { revokeCertificate as revoke } from '../../utils/certificateUtils';
import * as cu from '../../utils/certificateUtils';
import cud from '../../utils/certificateUtils';
import { enableRaProfile, createRaProfile } from '../../utils/raProfileUtils';
import { approveConnector, ensureConnectorRegistered, findConnectorByName } from '../../utils/connectorUtils';
import type { WaitForStateOptions } from '../../utils/certificateUtils';
import { type WaitForDiscoveryOptions, listNewlyDiscoveredInventoryUuids } from '../../utils/discoveryUtils';
const k = require('../../utils/keyUtils');
const t = await import('../../utils/tokenUtils');
import { execFileSync } from 'child_process';`;
    expect(lint(src)).toEqual([
        '2 util-import',
        '3 util-import',
        '4 util-import',
        '5 util-import',
        '6 util-import',
        '7 util-import',
        '7 util-import',
        '10 util-import',
        '11 util-import',
        '12 raw-process',
    ]);
    // A utils/regression helper resolves "../xUtils" to the same modules; child_process is fine outside specs.
    expect(rawMutations("import { revokeCertificate } from '../certificateUtils';\nimport { execFileSync } from 'child_process';", 'utils/regression/x.ts', { spec: false })
        .map((m) => `${m.line} ${m.rule}`)).toEqual(['1 util-import']);
});

// spec rules: test only from the fixtures, no .extend(, no route method rewrite, no raw network modules
test('spec rules: test only from the fixtures, no .extend(, no route method rewrite, no raw network', () => {
    const src = `
import { test, expect } from '@playwright/test';
import { test as fx } from '../../fixtures/testFixtures';
import { test as gen } from '../../utils/api/apiCase';
import * as pw from '@playwright/test';
import type { Page } from '@playwright/test';
import { Page as P2 } from '@playwright/test';
import * as http from 'http';
import { request as httpsRequest } from 'node:https';
import { fetch as uf } from 'undici';
import { KubeConfig } from '@kubernetes/client-node';
import { getAuthorizationApi } from '../../utils/k8sClient';
const myTest = fx.extend({ api: async ({}, use) => use(null) });
expect.extend({});
test('T-1', async ({ page }) => {
    await page.route('**', (route) => route.continue({ method: 'DELETE' }));
    await page.route('**', (route) => route.continue(opts));
    await page.route('**', (route) => route.fulfill({ status: 200, body: '' }));
    await page.route('**', (route) => route.continue());
    await page.route('**', async (route) => { await route.fetch({ method: 'DELETE' }); });
    const t = require('@playwright/test');
    const h2 = await import('http2');
});`;
    expect(lint(src)).toEqual([
        '2 spec-import', // `expect` is a runtime value of @playwright/test (types only; it comes from the fixtures)
        '2 test-import',
        '5 test-import',
        '8 raw-network',
        '9 raw-network',
        '10 raw-network',
        '11 raw-network',
        '12 raw-network',
        '13 fixture-extend',
        '14 fixture-extend',
        '16 route-method',
        '17 route-method',
        '20 fetch-method',
        '21 test-import',
        '22 raw-network',
    ]);
    // The same text in a helper (spec: false) only meets the helper rules.
    expect(rawMutations(src, 'utils/api/apiChecks.ts', { spec: false }).map((m) => `${m.line} ${m.rule}`)).toEqual(['20 fetch-method']);
});

// anonymousApi is a guarded fixture (mutations pass), test.use may not replace it or the token fixtures, a cast stays caught
test('anonymousApi is a guarded fixture; test.use may not replace it or the token fixtures', () => {
    const ok = `
test('API-AUTH-01: m', async ({ anonymousApi, env }) => {
    test.skip(env.authMode === 'header', 'the dev proxy injects the admin certificate');
    await anonymousApi.post('/api/v1/roles', { data: { name: 'x' } });
    await anonymousApi.delete('/api/v1/roles/00000000-0000-4000-8000-000000000000');
    const alias = anonymousApi;
    await alias.put('/api/v1/users/x', { data: {} });
});`;
    expect(rawMutations(ok, 'tests/api/X.spec.ts')).toEqual([]);
    expect(rawMutations("test.use({ anonymousApi: undefined });", 'tests/api/X.spec.ts').map((m) => m.rule)).toEqual(['fixture-extend']);
    expect(rawMutations("test.use({ restrictedToken: undefined });", 'tests/api/X.spec.ts').map((m) => m.rule)).toEqual(['fixture-extend']);
    expect(rawMutations("test.use({ adminToken: undefined });", 'tests/api/X.spec.ts').map((m) => m.rule)).toEqual(['fixture-extend']);
    expect(rawMutations("test('T', async ({ request }) => { const a = request as GuardedApi; await a.post('/api/v1/roles'); });", 'tests/api/X.spec.ts').map((m) => m.rule)).toContain('guarded-cast');
    // Mutant: dropping anonymousApi from the guarded set makes the first spec a context-method violation.
    expect(rawMutations("test('T', async ({ other }) => { await other.post('/api/v1/roles', { data: {} }); });", 'tests/api/X.spec.ts').map((m) => m.rule)).toEqual(['context-method']);
});

// the spec-facing fixtures of fixtures/regressionFixtures.ts: `test` may come from there, `localApi` is guarded like `api`, `signedIn` is a
// page, and none can be replaced by `test.use`
test('the regression fixtures: test comes from them, localApi is guarded, signedIn is a page, no test.use replaces one', () => {
    const rules = (src: string): string[] => rawMutations(src, 'tests/regression/X.spec.ts').map((m) => m.rule);
    expect(rules("import { test, expect } from '../../fixtures/regressionFixtures';")).toEqual([]);
    expect(rules("import { test } from '../../fixtures/otherFixtures';")).toEqual(['test-import']);
    // an area fixture (fixtures/areas/<name>) may hand a spec its `test`; any other fixtures path may not
    expect(rules("import { test, expect } from '../../fixtures/areas/certificateList';")).toEqual([]);
    expect(rules("import { test } from '../../fixtures/areas/CertificateList';")).toEqual(['test-import']);
    expect(rules("import { test } from '../../fixtures/areas/nested/list';")).toEqual(['test-import']);
    // only the root fixtures/areas folder: a folder of that name elsewhere is not linted as an area fixture
    expect(rules("import { test } from '../../pages/fixtures/areas/evil';")).toEqual(['test-import']);
    expect(rules("import { test } from '../../utils/fixtures/areas/evil';")).toEqual(['test-import']);
    expect(rules("import { test } from '../../fixtures/areas/../../pages/evil';")).toEqual(['test-import']);
    // an area fixture is linted like a spec: its base must be the spec-facing fixtures, and a raw context is refused
    const area = (src: string): string[] => rawMutations(src, 'fixtures/areas/certificateList.ts', { spec: true }).map((m) => m.rule);
    expect(area("import { test as base } from '../regressionFixtures';\nexport const test = base.extend<{ x: number }>({ x: async ({ api }, use) => { await api.get('/api/v1/roles'); await use(1); } });")).toEqual(['fixture-extend']);
    expect(area("import { test as base } from '@playwright/test';\nexport const test = base.extend<{ x: number }>({ x: async ({ request }, use) => { await request.post('/api/v1/roles'); await use(1); } });")).toEqual(['test-import', 'fixture-extend', 'context-method']);
    // localApi: a mutation through it is judged like one through `api`; through another receiver it is a context-method.
    expect(rules("test('x', async ({ localApi }) => { await localApi.post('/api/v1/roles', { data: {} }); const alias = localApi; await alias.delete('/api/v1/roles/1'); });")).toEqual([]);
    expect(rules("test('x', async ({ localApi }) => { let a = localApi; a = other; });")).toEqual(['guarded-reassign']);
    expect(rules("test('x', async ({ own }) => { await own.post('/api/v1/roles', { data: {} }); });")).toEqual(['context-method']);
    // signedIn is the page after the sign-in: its request context is raw, like page.request.
    expect(rules("test('x', async ({ signedIn }) => { await signedIn.request.post('/api/v1/roles', { data: {} }); });")).toEqual(['raw-request-use']);
    expect(rules("test('x', async ({ signedIn }) => { await signedIn.request.get('/api/v1/roles'); });")).toEqual([]);
    for (const name of ['own', 'live', 'needs', 'signedIn', 'regressionEnv', 'localApi', 'workerApi', 'ownRaProfile']) {
        expect(rules(`test.use({ ${name}: undefined });`), `test.use({ ${name} })`).toEqual(['fixture-extend']);
    }
    // A LiveOwn is only built by live(): a cast would fake the proof.
    expect(rules("test('x', async () => { const h = { type: 'roles' } as LiveOwn; });")).toEqual(['live-forge']);
    expect(rules("test('x', async ({ live }) => { const h = await live('roles', ref); });")).toEqual([]);
});

// token use: the token fixtures may be used as a header value / helper argument / truthiness check, never printed, compared or annotated
test('token use: token fixtures may be a header or argument, never printed, compared or annotated', () => {
    const ok = `
test('API-AUTH-02: claim', async ({ api, adminToken, restrictedToken }, testInfo) => {
    test.skip(!restrictedToken, 'no second identity');
    if (adminToken) { const claims = adminToken.claims(); expect(claims.username).toBe('x'); }
    const answered = await callAs(api, restrictedToken?.bearer(), 'GET', '/api/v1/auth/profile');
    await callWithAuthorization(api, 'Bearer ' + restrictedToken!.bearer(), 'GET', '/api/v1/auth/profile');
    const decoded = decodeJwt(adminToken!.bearer());
    const t = restrictedToken;
    await use(t);
});`;
    expect(rawMutations(ok, 'tests/api/X.spec.ts')).toEqual([]);
    const bad: Array<[string, string]> = [
        ['a template literal', 'const m = `token ${adminToken}`;'],
        ['expect(token)', 'expect(restrictedToken).toBe("x");'],
        ['expect.soft(token)', 'expect.soft(restrictedToken).toBeDefined();'],
        ['an annotation', "testInfo.annotations.push({ type: 'token', description: restrictedToken });"],
        ['a shorthand property', 'const o = { restrictedToken };'],
        ['a string concatenation', "const s = 'Bearer ' + restrictedToken;"],
        ['console.log', 'console.log(adminToken);'],
        ['logger.info', 'logger.info(adminToken);'],
        ['JSON.stringify', 'const j = JSON.stringify(restrictedToken);'],
        ['String()', 'const s = String(adminToken);'],
    ];
    for (const [name, stmt] of bad) {
        const src = `test('T', async ({ adminToken, restrictedToken }, testInfo) => { ${stmt} });`;
        expect(rawMutations(src, 'tests/api/X.spec.ts').map((m) => m.rule), name).toEqual(['token-use']);
    }
    // Outside a spec (utils) the rule does not apply; a parameter of the same NAME in another function is not the fixture.
    expect(rawMutations("test('T', async ({ adminToken }) => { helper(adminToken); }); function helper(adminToken: unknown) { console.log(adminToken); }", 'tests/api/X.spec.ts')).toEqual([]);
});

// ------------ the lint: process through aliases, dynamic code, request options the guard does not forward (own helpers, so a block scope)

{
    const HEAD = "import { test, expect } from '../../fixtures/testFixtures';\n";

    const T = (body: string) => `test('x', async ({ api }) => { ${body} });`;

    const rules = (src: string) => [...new Set(rawMutations(HEAD + src, 'tests/api/probe.api.spec.ts', { spec: true }).map((h) => h.rule))].sort();

    test('lint: process through globalThis / global / aliases, dynamic code, process.env handed away', () => {
        const flagged: Array<[string, string, string]> = [
            ['globalThis.process.env write', T("globalThis.process.env.TIER_KIND = 'local';"), 'env-write'],
            ['global.process element access', T("global['process'].env.TIER_KIND = 'local';"), 'env-write'],
            ['a process alias', T("const p = globalThis.process; p.env.BASE_URL = 'x';"), 'env-write'],
            ['an alias of an alias', T("const p = process; const q = p; q.env['TIER_KIND'] = 'local';"), 'env-write'],
            ['destructured env of globalThis.process', T("const { env } = globalThis.process; env.TIER_KIND = 'local';"), 'env-write'],
            ['process.env handed to a helper', "function set(e: any) { e.TIER_KIND = 'local'; }\n" + T('set(process.env);'), 'env-write'],
            ['globalThis.process.binding', T("globalThis.process.binding('fs');"), 'spec-import'],
            ['eval', T("eval(\"process.env.TIER_KIND='local'\");"), 'dynamic-code'],
            ['indirect eval', T("(0, eval)('1');"), 'dynamic-code'],
            ['globalThis.eval', T("globalThis.eval('1');"), 'dynamic-code'],
            ['new Function', T("new Function('return process')().env.TIER_KIND = 'local';"), 'dynamic-code'],
            ['Function()', T("Function('return 1')();"), 'dynamic-code'],
            ['globalThis.Function', T("const F = globalThis.Function; F('x');"), 'dynamic-code'],
            ['the constructor of a function', T("(() => 1).constructor('return process')();"), 'dynamic-code'],
            ['constructor of a constructor', T("[].constructor.constructor('return 1')();"), 'dynamic-code'],
            ['new x.constructor', T("new (async () => 1).constructor('return 1');"), 'dynamic-code'],
            ['setTimeout with a string', T("setTimeout('1', 0);"), 'dynamic-code'],
            ['setInterval with a template', T('setInterval(`x`, 10);'), 'dynamic-code'],
            ['setTimeout with a concatenation', T("const a = 'x'; setTimeout('p' + a, 0);"), 'dynamic-code'],
        ];
        for (const [name, src, rule] of flagged) expect(rules(src), name).toContain(rule);
        const clean: Array<[string, string]> = [
            ['a key read', T('const k = process.env.TIER_KIND; expect(k).toBeDefined();')],
            ['Object.keys / entries / JSON.stringify of process.env', T('Object.keys(process.env); Object.entries(process.env); JSON.stringify(process.env);')],
            ['a suite helper reading the environment', "import { isLocalTier } from '../../utils/regression/tier/kind';\n" + T('isLocalTier(process.env);')],
            ['Function as a type', "type Cb = Function;\n" + T('const f: Cb | undefined = undefined; expect(f).toBeUndefined();')],
            ['a timer with a callback', T('setTimeout(() => undefined, 1);')],
            ['a property named eval in a literal', T('const o = { eval: 1 }; expect(o).toBeDefined();')],
        ];
        for (const [name, src] of clean) expect(rules(src), name).toEqual([]);
    });

    test('lint: request options the guard does not forward, and test.use overriding a context fixture', () => {
        const flagged: Array<[string, string, string]> = [
            ['url key', T("await api.post('/api/v1/roles/own/users', { data: [], url: '/api/v1/roles/foreign/users' });"), 'request-option'],
            ['request key', T("await api.post('/api/v1/roles/own/users', { request: undefined });"), 'request-option'],
            ['encodedParams', T("await api.delete('/api/v1/roles/own', { encodedParams: 'x=1' });"), 'request-option'],
            ['method on get', T("await api.get('/api/v1/roles', { method: 'DELETE' } as any);"), 'request-option'],
            ['__testHookLookup', T("await api.get('/api/v1/roles', { __testHookLookup: {} } as never);"), 'request-option'],
            ['maxRedirects', T("await api.get('/api/v1/roles', { maxRedirects: 1 });"), 'request-option'],
            ['maxRetries', T("await api.get('/api/v1/roles', { maxRetries: 0 });"), 'request-option'],
            ['test.use({ api })', 'test.use({ api: undefined as any });\n' + T(''), 'fixture-extend'],
            ['test.use({ request })', 'test.use({ request: undefined as any });\n' + T(''), 'fixture-extend'],
            ['test.use(options)', 'const o = {};\ntest.use(o);\n' + T(''), 'fixture-extend'],
        ];
        for (const [name, src, rule] of flagged) expect(rules(src), name).toContain(rule);
        const clean: Array<[string, string]> = [
            ['forwarded options', T("await api.post('/api/v1/roles', { data: {}, params: { a: 1 }, headers: { accept: 'x' }, timeout: 1, failOnStatusCode: false });")],
            ['method on fetch', T("await api.fetch('/api/v1/roles', { method: 'GET', identityOverride: true, headers: { authorization: 'Bearer x' } });")],
            ['test.use of an option', "test.use({ locale: 'en-GB' });\n" + T('')],
        ];
        for (const [name, src] of clean) expect(rules(src), name).toEqual([]);
    });
}

// ------------------------- the spec rules: imports by allow-list, env and fs writes, the literal raw POST (own helpers, so a block scope)

{
    /**
     * The spec rules of the deny-by-default lint (utils/regression/specLint/rawMutations.ts):
     * imports by ALLOW-LIST (relative imports inside the suite, `@playwright/test` for types only, the node
     * built-ins SPEC_BUILTINS), `process.env` writes, fs writes / removals and `createRequire` in tests/**. Every probe of
     * the lint probe spec is a row here, plus the URL check of a literal raw POST (judged like `allowedRawPost`).
     */

    const HEAD = "import { test, expect } from '../../fixtures/testFixtures';\n";
    const rules = (src: string, file = 'tests/api/probe.api.spec.ts') => [...new Set(rawMutations(src, file, { spec: true }).map((h) => h.rule))].sort();

    test('lint probes: every probe is flagged with the rule that covers it; the controls stay clean', () => {
        const probes: Array<[string, string, string[]]> = [
            ['control: raw delete via the request fixture', "test('x', async ({ request }) => { await request.delete('/api/v1/roles/1'); });", ['raw-request-use']],
            ['node-fetch DELETE', "import nodeFetch from 'node-fetch';\ntest('x', async ({ api }) => { await nodeFetch('https://t/api/v1/roles/1', { method: 'DELETE' }); });", ['spec-import']],
            ['node-fetch default named fetch', "import fetch from 'node-fetch';\ntest('x', async ({ api }) => { await fetch('https://t/api/v1/roles/1', { method: 'DELETE' }); });", ['spec-import']],
            ['openid-client / isomorphic-ws imports', "import * as oc from 'openid-client';\nimport WebSocket from 'isomorphic-ws';\ntest('x', async ({ api }) => { });", ['spec-import']],
            ['global fetch DELETE', "test('x', async ({ api }) => { await fetch('https://t/api/v1/roles/1', { method: 'DELETE' }); });", ['fetch-method']],
            ['globalThis.fetch DELETE', "test('x', async ({ api }) => { await globalThis.fetch('https://t/api/v1/roles/1', { method: 'DELETE' }); });", ['fetch-method']],
            ['page.evaluate fetch', "test('x', async ({ page }) => { await page.evaluate(() => fetch('/api/v1/roles/1', { method: 'DELETE' })); });", ['fetch-method']],
            ['page.evaluate XHR', "test('x', async ({ page }) => { await page.evaluate(() => { const x = new XMLHttpRequest(); }); });", ['raw-xhr']],
            ['context.request.delete', "test('x', async ({ context }) => { await context.request.delete('/api/v1/roles/1'); });", ['context-method']],
            ['playwright.request.newContext', "test('x', async ({ playwright }) => { const c = await playwright.request.newContext(); await c.delete('/api/v1/roles/1'); });", ['context-method']],
            ['browser.newContext().request', "test('x', async ({ browser }) => { const c = await browser.newContext(); await c.request.delete('/api/v1/roles/1'); });", ['context-method']],
            ['process.env.TIER_KIND assignment', "test('x', async ({ api }) => { process.env.TIER_KIND = 'local'; });", ['env-write']],
            ['fs write of the proof / ledger', "import * as fs from 'fs';\ntest('x', async ({ api }) => { fs.writeFileSync('/tmp/x', '1'); fs.appendFileSync('/tmp/y', '1'); });", ['fs-write']],
            ['dynamic import of node:http', "test('x', async ({ api }) => { const h = await import('node:http'); });", ['raw-network']],
            ['worker_threads / vm / dgram imports', "import * as vm from 'vm';\nimport * as dgram from 'dgram';\nimport { Worker } from 'worker_threads';\ntest('x', async ({ api }) => { });", ['spec-import']],
            ['node:child_process via require', "const cp = require('node:child_process');\ntest('x', async ({ api }) => { });", ['raw-process']],
            ['http via createRequire', "import { createRequire } from 'module';\nconst r = createRequire(__filename);\nconst h = r('http');\ntest('x', async ({ api }) => { });", ['spec-import']],
            ['@kubernetes/client-node import', "import * as k8s from '@kubernetes/client-node';\ntest('x', async ({ api }) => { });", ['raw-network']],
            // Controls (not flagged by these rules; the runtime guard or describeLocalOnly cover them).
            ['control: api.fetch with a Request object (runtime guard)', "test('x', async ({ api }) => { await api.fetch('/api/v1/roles/1', { method: 'DELETE' }); });", []],
            ['control: apiGuardOptions only in a comment', "// apiGuardOptions\ntest('x', async ({ api }) => { });", []],
            ['control: recordCreated / runTeardown / tier imports (relative, inside the suite)', "import { recordCreated } from '../../utils/regression/ledger/ledger';\nimport { removeOwnObject } from '../../utils/regression/teardown/runTeardown';\nimport { isLocalTier } from '../../utils/regression/tier/kind';\ntest('x', async ({ api }) => { });", []],
            ['control: crypto / path / fs reads / type imports', "import { randomUUID } from 'crypto';\nimport * as path from 'path';\nimport * as fs from 'fs';\nimport type { APIResponse } from '@playwright/test';\nimport { Page } from '@playwright/test';\ntest('x', async ({ api }) => { fs.readFileSync(path.join('a', randomUUID())); });", []],
        ];
        const wrong: string[] = [];
        for (const [name, body, expected] of probes) {
            const got = rules(HEAD + body);
            if (JSON.stringify(got) !== JSON.stringify([...expected].sort())) wrong.push(`${name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
        }
        expect(wrong).toEqual([]);
    });

    // spec-import: relative imports stay inside the suite; @playwright/test for types only; built-ins by allow-list; dynamic module names
    // refused
    test('spec-import: relative imports stay in the suite; @playwright/test types only; built-ins allow-listed', () => {
        const flagged = (src: string) => rawMutations(HEAD + src, 'tests/api/probe.api.spec.ts').filter((h) => h.rule === 'spec-import').length;
        expect(flagged("import { x } from '../../node_modules/undici/index';")).toBe(1);
        expect(flagged("import { x } from '../../../outside/thing';")).toBe(1);
        expect(flagged("import { x } from '../../utils/regression/pkiBuilders';")).toBe(0);
        expect(flagged("import { expect as e } from '@playwright/test';")).toBe(1);
        expect(flagged("import { chromium, devices } from '@playwright/test';")).toBe(2);
        expect(flagged("import { type Page, APIResponse } from '@playwright/test';")).toBe(0);
        expect(flagged("export { test } from '@playwright/test';")).toBe(1);
        expect(flagged("import ws = require('ws');")).toBe(1);
        expect(flagged("const m = require(name);")).toBe(1);
        expect(flagged("const m = await import(name);")).toBe(1);
        expect(flagged("import * as inspector from 'node:inspector';")).toBe(1);
        expect(flagged("const b = process.binding('fs');")).toBe(1);
        expect(flagged("const r = process.mainModule.require;")).toBe(1);
        for (const ok of ['assert', 'node:buffer', 'crypto', 'fs', 'fs/promises', 'os', 'path', 'string_decoder', 'timers', 'timers/promises', 'url', 'util', 'zlib']) {
            expect(flagged(`import * as m from '${ok}';`), ok).toBe(0);
        }
        // Helpers (spec: false) are not bound by the spec allow-list.
        expect(rawMutations("import WebSocket from 'ws';", 'utils/regression/x.ts', { spec: false }).filter((h) => h.rule === 'spec-import')).toEqual([]);
    });

    test('env-write: every way to change process.env from a spec is flagged; reads are fine', () => {
        const flagged = (src: string) => rawMutations(HEAD + src, 'tests/regression/X.spec.ts').filter((h) => h.rule === 'env-write').length;
        expect(flagged("process.env.TIER_KIND = 'local';")).toBe(1);
        expect(flagged("process.env['BASE_URL'] = 'x';")).toBe(1);
        expect(flagged("process.env.REG_RUN_ID ??= 'x';")).toBe(1);
        expect(flagged("process.env.X += 'y';")).toBe(1);
        expect(flagged("delete process.env.API_TEARDOWN_DRY_RUN;")).toBe(1);
        expect(flagged("Object.assign(process.env, { TIER_KIND: 'local' });")).toBe(1);
        expect(flagged("Object.defineProperty(process.env, 'TIER_KIND', { value: 'local' });")).toBe(1);
        expect(flagged("Reflect.set(process.env, 'TIER_KIND', 'local');")).toBe(1);
        expect(flagged("process.env = { TIER_KIND: 'local' };")).toBe(1);
        expect(flagged("const e = process.env;\ne.TIER_KIND = 'local';")).toBe(1);
        expect(flagged("const { env } = process;\nenv['TIER_KIND'] = 'local';")).toBe(1);
        expect(flagged("const kind = process.env.TIER_KIND ?? 'shared';\nconst copy = { ...process.env };\ncopy.TIER_KIND = 'x';")).toBe(0);
    });

    // fs-write: write / append / rm / unlink / rename / copy / mkdir / open on any fs binding; reads are fine
    test('fs-write: write, append, rm, unlink, rename, copy, mkdir and open on any fs binding; reads are fine', () => {
        const flagged = (src: string) => rawMutations(HEAD + src, 'tests/api/X.api.spec.ts').filter((h) => h.rule === 'fs-write').length;
        expect(flagged("import * as fs from 'fs';\nfs.writeFileSync('a', 'b');")).toBe(1);
        expect(flagged("import fs from 'node:fs';\nfs.rmSync('a', { force: true });")).toBe(1);
        expect(flagged("import { writeFileSync, rmSync, readFileSync } from 'fs';")).toBe(2);
        expect(flagged("import { promises } from 'fs';\nawait promises.writeFile('a', 'b');")).toBe(1);
        expect(flagged("import * as fs from 'fs';\nawait fs.promises.unlink('a');")).toBe(1);
        expect(flagged("import * as fsp from 'fs/promises';\nawait fsp.rename('a', 'b');")).toBe(1);
        expect(flagged("const fs = require('fs');\nfs.appendFileSync('a', 'b');")).toBe(1);
        expect(flagged("import * as fs from 'fs';\nconst f = fs;\nf.copyFileSync('a', 'b');")).toBe(1);
        expect(flagged("import * as fs from 'fs';\nconst { mkdirSync, existsSync } = fs;")).toBe(1);
        expect(flagged("import * as fs from 'fs';\nfs['unlinkSync']('a');")).toBe(1);
        expect(flagged("import * as fs from 'fs';\nfs[name]('a');")).toBe(1);
        expect(flagged("import * as fs from 'fs';\nconst s = fs.createWriteStream('a');")).toBe(1);
        expect(flagged("import * as fs from 'fs';\nconst t = fs.readFileSync('a', 'utf8');\nfs.existsSync('b');\nfs.statSync('c');")).toBe(0);
        // Helpers write the ledger, run state and proofs by design: the rule is spec-only.
        expect(rawMutations("import * as fs from 'fs';\nfs.writeFileSync('a', 'b');", 'utils/regression/x.ts', { spec: false }).filter((h) => h.rule === 'fs-write')).toEqual([]);
    });

    test('a literal raw POST is judged like allowedRawPost; tab-split, dotted and encoded paths are not reads', () => {
        const flagged = (url: string) => rawMutations(`${HEAD}test('x', async ({ request }) => {}); const raw = ctx(); await raw.post(${url});`, 'tests/api/X.api.spec.ts')
            .filter((h) => h.rule === 'context-method').length;
        expect(flagged("'/api/v1/certificates'")).toBe(0);
        expect(flagged("'/api/v1/protocols/acme/raProfile/x/new-order'")).toBe(0);
        expect(flagged('`/api/v1/protocols/acme/${name}/new-order`')).toBe(0);
        expect(flagged("'/api/v1/protocols/acme/x/.\\t./.\\t./auditLogs/purge'")).toBe(1);
        expect(flagged("'/api/v1/protocols/acme/x/../../auditLogs/purge'")).toBe(1);
        expect(flagged("'/api/v1/protocols/acme/x/%2e%2e/auditLogs/purge'")).toBe(1);
        expect(flagged("'/api/v1/workflows/events/x/../../../cboms/sync'")).toBe(1);
        expect(flagged("'https://elsewhere.example.test/api/v1/certificates'")).toBe(1);
        expect(flagged("'/api/v1/certificates/'")).toBe(1);
    });
}

// ------------------------------------------------------------ one positive and one negative case per rule (own helpers, so a block scope)

{
    const FIXTURES = "import { test, expect } from '../../fixtures/testFixtures';\n";

    interface RuleCase {
        /** A source the rule must report. */
        bad: string;
        /** A close source the rule must not report. */
        fine: string;
        /** The rule applies to specs only: the same bad source linted as a helper is clean. */
        specOnly?: boolean;
    }

    /** Every rule of the lint; the type makes a new rule name fail to compile until it has its cases. */
    const CASES: Record<RawMutationRule, RuleCase> = {
        'raw-context': { bad: 'const c = getAuthenticatedApiContext(env);', fine: 'const c = getGuardedApiContext(env);' },
        'raw-request-use': {
            bad: "test('x', async ({ request }) => { await request.delete('/api/v1/roles/1'); });",
            fine: "test('x', async ({ request }) => { await request.get('/api/v1/roles'); });",
        },
        'unit-seam': { bad: 'const g = guardApiWithSeams(ctx, seams);', fine: 'const g = guardApi(ctx);' },
        'guard-internal': {
            bad: "import { checkAndSend } from '../../utils/regression/guard/sendRequest';",
            fine: "import { guardApi } from '../../utils/regression/guard/createGuard';",
        },
        'guarded-cast': { bad: 'const a = ctx as GuardedApi;', fine: 'const a = ctx as ApiContext;' },
        'guarded-reassign': {
            bad: "test('x', async ({ api }) => { let a = api; a = other; });",
            fine: "test('x', async ({ api }) => { let a = api; a = api; });",
        },
        'context-method': {
            bad: "test('x', async ({ other }) => { await other.post('/api/v1/roles', { data: {} }); });",
            fine: "test('x', async ({ api }) => { await api.post('/api/v1/roles', { data: {} }); });",
        },
        'fetch-method': { bad: "await fetch('/api/v1/roles/1', { method: 'DELETE' });", fine: "await fetch('/api/v1/roles/1');" },
        'dynamic-method': {
            bad: "test('x', async ({ other }) => { await other[verb]('/api/v1/roles'); });",
            fine: "test('x', async ({ api }) => { await api[verb]('/api/v1/roles'); });",
        },
        'method-extraction': { bad: 'const d = ctx.delete;', fine: "test('x', async ({ api }) => { const d = api.delete; });" },
        'apiJson': { bad: "await apiJson(ctx, 'DELETE', '/api/v1/roles/1');", fine: "await apiJson(ctx, 'GET', '/api/v1/roles');" },
        'send-method': { bad: "await send(ctx, 'DELETE', '/api/v1/roles/1');", fine: "await send(ctx, 'GET', '/api/v1/roles');" },
        'raw-xhr': { bad: 'const x = new XMLHttpRequest();', fine: 'const x = new URLSearchParams();' },
        'response-state': { bad: 'const all = res.allHeaders();', fine: "const type = res.headers()['content-type'];", specOnly: true },
        'live-forge': { bad: 'const handle = { type: "roles", ref } as LiveOwn<"roles">;', fine: 'const handle: LiveOwn<"roles"> = await live("roles", ref);' },
        'util-import': {
            bad: "import * as cu from '../../utils/certificateUtils';",
            fine: "import { createCertificate } from '../../utils/certificateUtils';",
        },
        'raw-process': { bad: "import { execFileSync } from 'child_process';", fine: "import * as path from 'path';", specOnly: true },
        'test-import': {
            bad: "import { test } from '@playwright/test';",
            fine: "import { test } from '../../fixtures/testFixtures';",
            specOnly: true,
        },
        'fixture-extend': { bad: 'const t = base.extend({});', fine: "test.use({ locale: 'en-GB' });", specOnly: true },
        'route-method': {
            bad: "await route.continue({ method: 'DELETE' });",
            fine: "await route.continue({ headers: { accept: 'x' } });",
            specOnly: true,
        },
        'raw-network': { bad: "import * as http from 'http';", fine: "import * as os from 'os';", specOnly: true },
        'spec-import': { bad: "import ws from 'ws';", fine: "import * as crypto from 'crypto';", specOnly: true },
        'env-write': { bad: "process.env.TIER_KIND = 'local';", fine: 'const kind = process.env.TIER_KIND;', specOnly: true },
        'fs-write': {
            bad: "import * as fs from 'fs';\nfs.writeFileSync('a', 'b');",
            fine: "import * as fs from 'fs';\nfs.readFileSync('a');",
            specOnly: true,
        },
        'dynamic-code': { bad: "eval('1');", fine: 'setTimeout(() => undefined, 1);', specOnly: true },
        'request-option': {
            bad: "test('x', async ({ api }) => { await api.post('/api/v1/roles', { url: '/y' }); });",
            fine: "test('x', async ({ api }) => { await api.post('/api/v1/roles', { data: {} }); });",
            specOnly: true,
        },
        'token-use': {
            bad: "test('x', async ({ adminToken }) => { const t = `${adminToken}`; });",
            fine: "test('x', async ({ api, adminToken }) => { await callAs(api, adminToken.bearer(), '/api/v1/roles'); });",
            specOnly: true,
        },
    };

    const reported = (src: string, spec: boolean) => rawMutations(FIXTURES + src, 'tests/api/probe.api.spec.ts', { spec }).map((m) => m.rule);

    for (const [rule, c] of Object.entries(CASES) as Array<[RawMutationRule, RuleCase]>) {
        test(`rule ${rule}: reports its bad source, passes the close one`, () => {
            expect(reported(c.bad, true), 'bad source').toContain(rule);
            expect(reported(c.fine, true), 'close source').not.toContain(rule);
            if (c.specOnly) expect(reported(c.bad, false), 'bad source linted as a helper').not.toContain(rule);
            else expect(reported(c.bad, false), 'bad source linted as a helper').toContain(rule);
        });
    }

    test('guard-internal: every inner module and import form is refused outside the guard and the unit tests; types and the guard itself are fine', () => {
        const GUARD = 'utils/regression/guard';
        const refused = (src: string, file = 'utils/regression/lifecycle/x.ts') => rawMutations(src, file, { spec: false }).map((m) => m.rule);
        for (const mod of ['sendRequest', 'guardState', 'readRequest', 'checkRequest', 'claims']) {
            expect(refused(`import { x } from '../guard/${mod}';`), `import ${mod}`).toEqual(['guard-internal']);
        }
        expect(refused("import * as s from '../guard/sendRequest';"), 'namespace import').toEqual(['guard-internal']);
        expect(refused("import s = require('../guard/sendRequest');"), 'import equals').toEqual(['guard-internal']);
        expect(refused("const s = require('../guard/guardState');"), 'require').toEqual(['guard-internal']);
        expect(refused("const s = await import('../guard/checkRequest');"), 'dynamic import').toEqual(['guard-internal']);
        expect(refused("export { checkAndSend } from '../guard/sendRequest';"), 'export from').toEqual(['guard-internal']);
        expect(refused("import { x } from '../../utils/regression/guard/claims';", 'tests/regression/01-a/01-b.spec.ts'), 'a spec').toContain('guard-internal');
        // Fine: a type-only import, the public modules, the guard's own folder and the unit tests.
        expect(refused("import type { Snapshot } from '../guard/readRequest';")).toEqual([]);
        expect(refused("import { guardApi } from '../guard/createGuard';\nimport { assertGuarded } from '../guard/types';")).toEqual([]);
        expect(refused("import { checkAndSend } from './sendRequest';", `${GUARD}/createGuard.ts`)).toEqual([]);
        expect(refused("import { GuardState } from '../../../utils/regression/guard/guardState';", 'tests/unit/helpers/x.ts')).toEqual([]);
        expect(refused("import { x } from '../other/claims';")).toEqual([]);
        // The unit-test verdict helper is a seam like guardApiWithSeams.
        expect(refused('await judgeWithSeams(api, {}, "GET", "/api/v1/roles");')).toEqual(['unit-seam']);
    });

    test('the table names every rule and keeps findings of one node in table order', () => {
        const names = new Set(RULES.map((r) => r.rule));
        expect([...names].sort()).toEqual(Object.keys(CASES).sort());
        // `test` from the wrong module is reported before the `request` factory: the order of the table.
        expect(rawMutations("import { test, request } from '@playwright/test';", 'tests/api/probe.api.spec.ts').map((m) => m.rule)).toEqual(['test-import', 'raw-context']);
        expect(rawMutations("import { test, request } from '@playwright/test';", 'tests/api/probe.api.spec.ts', { spec: false }).map((m) => m.rule)).toEqual(['raw-context']);
    });

    test('a rule with an allow-list is skipped for the files named there and nowhere else', () => {
        const standIn: Rule = {
            rule: 'dynamic-code',
            scope: 'spec',
            allow: ['tests/api/old.api.spec.ts'],
            hits: (n, _b, ctx) => (ctx.ts.isDebuggerStatement(n) ? [n] : []),
        };
        const lint = (file: string, spec = true) => rawMutationsWith([standIn], 'debugger;', file, { spec }).map((m) => m.rule);
        expect(lint('tests/api/new.api.spec.ts')).toEqual(['dynamic-code']);
        expect(lint('tests/api/old.api.spec.ts')).toEqual([]);
        expect(lint('tests\\api\\old.api.spec.ts'), 'a Windows path names the same file').toEqual([]);
        expect(lint('utils/regression/x.ts', false), 'a spec rule does not apply to helpers').toEqual([]);
        const everywhere: Rule = { ...standIn, scope: 'all', allow: undefined };
        expect(rawMutationsWith([everywhere], 'debugger;', 'utils/regression/x.ts', { spec: false }).map((m) => m.rule)).toEqual(['dynamic-code']);
    });
}

// a page object's own page is the same raw context as the page fixture: `<x>.page.request` is refused like `page.request`
test('<x>.page.request is a raw context like page.request: passed on or aliased it is refused, a GET passes, a write is refused', () => {
    const rules = (src: string): string[] => rawMutations(src, 'tests/regression/X.spec.ts').map((m) => m.rule);
    expect(rules("test('x', async ({ signedIn }) => { const roles = new RolesPage(signedIn); await roles.page.request.get('/api/v1/roles'); });")).toEqual([]);
    expect(rules("test('x', async ({ signedIn }) => { const roles = new RolesPage(signedIn); await roles.page.request.post('/api/v1/roles', { data: {} }); });")).toEqual(['raw-request-use']);
    expect(rules("test('x', async ({ signedIn }) => { const roles = new RolesPage(signedIn); await helper(roles.page.request); });")).toEqual(['raw-request-use']);
    expect(rules("test('x', async ({ signedIn }) => { const roles = new RolesPage(signedIn); const raw = roles.page.request; });")).toEqual(['raw-request-use']);
    expect(rules("test('x', async ({ signedIn }) => { const roles = new RolesPage(signedIn); await roles.api.request.get('/x'); });")).toEqual([]);
    // bracket and alias forms resolve like the dotted one
    const po = "const po = new RolesPage(signedIn); ";
    for (const body of ["await po['page'].request.post('/x');", "await po.page['request'].post('/x');", "const p = po.page; await p.request.post('/x');",
        "const { page } = po; await page.request.post('/x');", "const { page: pg } = po; await pg.request.post('/x');", "const p = po.page; const q = p; await q['request'].post('/x');",
        "const { request } = po.page; await request.post('/x');", "const raw = po['page']['request'];"]) {
        expect(rules(`test('x', async ({ signedIn }) => { ${po}${body} });`), body).toEqual(['raw-request-use']);
    }
    for (const body of ["await po['page'].request.get('/x');", "const p = po.page; await p.request.get('/x');", "const { page } = po; await page['request'].get('/x');"]) {
        expect(rules(`test('x', async ({ signedIn }) => { ${po}${body} });`), body).toEqual([]);
    }
});

// cookies and storage state never reach a spec; a header assertion on a plain header, and the verdict helper's headers option, do
test('response state: only a header assertion on a plain header or the verdict helper option may read response headers', () => {
    const rules = (src: string): string[] => rawMutations(src, 'tests/api/X.api.spec.ts').map((m) => m.rule);
    // allowed
    expect(rules("test('x', async ({ api }) => { const res = await api.get('/v1/a'); expect(res.headers()['content-type']).toContain('json'); });")).toEqual([]);
    expect(rules("test('x', async ({ api }) => { const res = await api.get('/v1/a'); const v = checkRefusedMethod({ status: res.status(), headers: res.headers(), bodyText: '' }); });")).toEqual([]);
    // refused: a whole header map, a credential header, a computed name, storage state, another receiver, another helper
    expect(rules("test('x', async ({ api }) => { const res = await api.get('/v1/a'); const h = res.headers(); });")).toEqual(['response-state']);
    expect(rules("test('x', async ({ api }) => { const res = await api.get('/v1/a'); const c = res.headers()['set-cookie']; });")).toEqual(['response-state']);
    expect(rules("test('x', async ({ api }) => { const res = await api.get('/v1/a'); const c = res.headers()[name]; });")).toEqual(['response-state']);
    expect(rules("test('x', async ({ api }) => { const res = await api.get('/v1/a'); const h = await res.allHeaders(); });")).toEqual(['response-state']);
    expect(rules("test('x', async ({ signedIn }) => { const s = await signedIn.context().storageState(); });")).toEqual(['response-state']);
    expect(rules("test('x', async ({ api }) => { const res = await api.get('/v1/a'); log({ headers: res.headers() }); });")).toEqual(['response-state']);
    // bracket keys, destructuring and call / apply / bind do not get around it
    for (const body of ["const h = res['headers']();", "const h = await res['allHeaders']();", "const h = res['headersArray']();", "const s = await ctx['storageState']();",
        "const c = res['headers']()['set-cookie'];", "const { headers } = res;", "const { allHeaders } = res;", "const { headersArray: list } = res;",
        "const { storageState } = ctx;", "const { 'headers': h } = res;", "const h = res.headers.call(res);", "const h = res.headers.apply(res, []);",
        "const f = res.headers.bind(res);", "const h = res['headers'].call(res);"]) {
        expect(rules(`test('x', async ({ api }) => { const res = await api.get('/v1/a'); const ctx = res; ${body} });`), body).toEqual(['response-state']);
    }
    expect(rules("test('x', async ({ api }) => { const res = await api.get('/v1/a'); expect(res['headers']()['content-type']).toContain('json'); });")).toEqual([]);
    // a helper file is not a spec: the rule applies to specs only
    expect(rawMutations('const h = res.headers();', 'utils/regression/x.ts', { spec: false }).map((m) => m.rule)).toEqual([]);
});
