/**
 * tags — the tag builders and `testMeta()` (every tag spelled in utils/regression/tags.ts, the tag rules enforced when a
 * test's details are built), the AST reader of spec sources (testBlocks, inherited describe tags, @bug needs test.fail())
 * and the deny-by-default lint `rawMutations`: imports by allow-list, env and fs writes, raw contexts, request options.
 */
import { test, expect } from '@playwright/test';
import { bugTagsWithoutFail, codeNames, suiteTagProblems, testBlocks } from '../../utils/regression/specLint/parseSpec';
import { idTag, testMeta, tags } from '../../utils/regression/tags';
import { rawMutations } from '../../utils/regression/specLint/rawMutations';

test('builders spell every tag', () => {
    expect(tags.issue('ilm#429')).toBe('@issue:ilm#429');
    expect(tags.prio('P1')).toBe('@p1');
    expect(tags.prio('P3')).toBe('@p3');
    expect(tags.pin('A6')).toBe('@pin:A6');
    expect(tags.needs('openssl')).toBe('@needs:openssl');
    expect(tags.bug('core#2502')).toBe('@bug:core#2502');
    expect([tags.regression, tags.api, tags.gate, tags.phaseB, tags.local]).toEqual(['@regression', '@api', '@gate', '@phaseB', '@local']);
});

test('builders refuse malformed references', () => {
    expect(() => tags.issue('429')).toThrow(/repo>#<number/);
    expect(() => tags.bug('core 2502')).toThrow(/repo>#<number/);
    expect(() => tags.prio('P4' as 'P1')).toThrow(/P1, P2 or P3/);
    expect(() => tags.needs('Open SSL')).toThrow(/capability/);
});

test('testMeta builds the Playwright details of one ledger row', () => {
    expect(testMeta({ id: 'API-GEN-33', prio: 'P1', issue: 'ilm#428' })).toEqual({
        tag: ['@issue:ilm#448', '@issue:ilm#428', '@p1', '@API-GEN-33'],
        annotation: [{ type: 'ledger-id', description: 'API-GEN-33' }],
    });
    const full = testMeta({ id: 'REG-CFG-07.a', prio: 'P2', issue: ['ilm#427', 'ilm#448'], needs: ['openssl', 'sscep'], local: true, phaseB: true, bug: 'core#2502', pin: 'A6' });
    expect(full.tag).toEqual(['@issue:ilm#448', '@issue:ilm#427', '@p2', '@phaseB', '@local', '@pin:A6', '@needs:openssl', '@needs:sscep', '@bug:core#2502', '@REG-CFG-07.a']);
    expect(testMeta({ id: 'API-GEN-32', prio: 'P1', issue: 'ilm#428', gate: true }).tag).toContain('@gate');
});

test('testMeta tags the test with its id and names a table row as an annotation; testBlocks reads the testMeta id', () => {
    expect(idTag('REG-USE-05')).toBe('@REG-USE-05');
    const m = testMeta({ id: 'REG-CERT-41', prio: 'P2', issue: 'ilm#429', row: 'T-3', rule: 'one rule' });
    expect(m.tag).toContain('@REG-CERT-41');
    expect(m.annotation).toEqual([
        { type: 'ledger-id', description: 'REG-CERT-41' },
        { type: 'row', description: 'T-3' },
        { type: 'rule', description: 'one rule' },
    ]);
    expect(() => testMeta({ id: 'REG-CERT-41', prio: 'P2', issue: 'ilm#429', row: ' ' }), 'a blank row').toThrow(/row/);
    const blocks = testBlocks(`
test('the filter keeps the rows it names', testMeta({ id: 'REG-CERT-41', prio: 'P2', issue: 'ilm#429', row: 'T-3' }), async () => {});
test('REG-CERT-42: the title still carries the id', { tag: ['@regression'] }, async () => {});`);
    expect(blocks.map((b) => b.id)).toEqual(['REG-CERT-41', undefined]);
    expect(blocks[0].tags).toContain('@REG-CERT-41');
});

test('testMeta enforces the tag rules', () => {
    expect(() => testMeta({ id: 'SMK-001', prio: 'P1', issue: 'ilm#428' }), 'not a REG / API ledger id').toThrow(/ledger id/);
    expect(() => testMeta({ id: 'API-GEN-07', prio: 'P1', issue: 'ilm#428', pin: 'A6' }), 'a pin is never P1').toThrow(/never P1/);
    expect(() => testMeta({ id: 'API-GEN-07', prio: 'P1', issue: 'ilm#428', gate: true }), '@gate is API-GEN-32 only').toThrow(/API-GEN-32 only/);
    expect(() => testMeta({ id: 'API-GEN-07', prio: 'P1', issue: 'ilm#448' }), 'the area issue is required').toThrow(/sub-issue/);
});

test('testBlocks finds each test call with its whole body', () => {
    const src = [
        "test.describe('x', () => {",
        "  test('A-1: first', async () => { const s = ')'; /* ) */ await f(\"(\"); });",
        '  test(`A-2: second`, testMeta({ id: "A" }), async () => {',
        '    // a comment with ) and }',
        '    await g();',
        '  });',
        '});',
    ].join('\n');
    const blocks = testBlocks(src);
    expect(blocks.map((b) => b.title)).toEqual(['A-1: first', 'A-2: second']);
    expect(blocks[1].body).toContain('await g();');
    expect(blocks[0].body).not.toContain('A-2');
});

test('a @bug tag without test.fail() is found, with test.fail() it passes', () => {
    const src = `
test('API-GEN-07: refused method answers 400', testMeta({ id: 'API-GEN-07', prio: 'P1', issue: 'ilm#428', bug: 'core#2502' }), async () => {
    test.fail(await isMigratedBuild(api), '@bug:core#2502 on the migrated build');
    expect(1).toBe(1);
});
test('API-GEN-08: tag literal, no fail', { tag: ['@bug:core#1'] }, async () => {
    expect(1).toBe(1);
});
test('API-GEN-09: tags.bug builder, no fail', { tag: [tags.bug('core#2')] }, async () => {});
test('API-GEN-10: no bug at all', async () => {});
`;
    expect(bugTagsWithoutFail(src)).toEqual(['API-GEN-08: tag literal, no fail', 'API-GEN-09: tags.bug builder, no fail']);
});

test('the AST finds every declaration form, ignores modifiers and steps, and inherits describe tags', () => {
    const src = `
import { tags } from 'x';
test.describe('@regression REG-X suite', () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!process.env.BASE_URL, 'no tier');            // a modifier, not a test
    test('REG-X-01: brackets in regexes and strings do not end the block', async () => {
        const re = /\\)[}]/;
        await test.step('a step is not a test', async () => {});
        const s = \`)\${'}'}\`;
    });
    test.fixme('REG-X-02: fixme counts', { tag: tags.bug('core#1') }, async () => {});
    test.skip('REG-X-03: skip counts', async () => {});
    test.describe('inner', { tag: ['@local'] }, () => {
        test.fail('REG-X-04: declared failing', testMeta({ id: 'REG-X-04', prio: 'P2', issue: 'ilm#1', bug: 'core#2' }), async () => {});
    });
});`;
    const blocks = testBlocks(src);
    expect(blocks.map((b) => [b.title, b.kind])).toEqual([
        ['REG-X-01: brackets in regexes and strings do not end the block', 'test'],
        ['REG-X-02: fixme counts', 'fixme'],
        ['REG-X-03: skip counts', 'skip'],
        ['REG-X-04: declared failing', 'fail'],
    ]);
    expect(blocks[0].body).toContain('a step is not a test');
    expect(blocks[1].tags).toEqual(['@regression', '@bug:core#1']);
    expect(blocks[3].tags).toEqual(expect.arrayContaining(['@regression', '@local', '@p2', '@bug:core#2']));
    expect(blocks[3].describes).toEqual(['@regression REG-X suite', 'inner']);
});

test('a @bug in a fixme or skip block, or inherited from a describe, needs test.fail()', () => {
    const src = `
test.fixme('A-1: fixme as a bug marker', { tag: ['@bug:core#3'] }, async () => {});
test.describe('known bug', { tag: '@bug:core#4' }, () => {
    test('A-2: inherits the bug', async () => {});
    test('A-3: asserts it', async () => { test.fail(true, 'core#4'); });
});
test.fail('A-4: a failing declaration is fine', { tag: ['@bug:core#5'] }, async () => {});`;
    expect(bugTagsWithoutFail(src)).toEqual(['A-1: fixme as a bug marker', 'A-2: inherits the bug']);
});

test('exactly one suite tag per test: missing and doubled tags are reported', () => {
    const src = `
test.describe('@regression R suite', () => { test('R-1: fine', async () => {}); });
test.describe('API suite', { tag: tags.api }, () => { test('A-1: fine', async () => {}); test('A-2: two', { tag: ['@regression'] }, async () => {}); });
test('X-1: none', async () => {});`;
    expect(suiteTagProblems(src)).toEqual(['A-2: two (line 3): @api + @regression', 'X-1: none (line 4): no suite tag']);
});

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

// codeNames sees identifiers and strings, not comments (the describeLocalOnly rule for localStack / guardOptions)
test('codeNames sees identifiers and strings, not comments, for the describeLocalOnly rule', () => {
    const names = codeNames("// test.use({ guardOptions: { localStack: true } })\nconst a = 1; /* apiGuardOptions */ test.use({ 'apiGuardOptions': {} });");
    expect(['guardOptions', 'localStack'].map((n) => names.has(n))).toEqual([false, false]);
    expect(names.has('apiGuardOptions')).toBe(true);
});

// ------------------------------------------------------------------ @slow, anonymousApi, token-use

test('@slow is a registered tag: builder, testMeta and the AST reader know it', () => {
    expect(tags.slow).toBe('@slow');
    expect(testMeta({ id: 'REG-DISC-03', prio: 'P2', issue: 'ilm#430', slow: true }).tag).toEqual(['@issue:ilm#448', '@issue:ilm#430', '@p2', '@slow', '@REG-DISC-03']);
    const blocks = testBlocks(`
test('REG-DISC-03: a', { tag: [tags.slow] }, async () => {});
test('REG-DISC-04: b', testMeta({ id: 'REG-DISC-04', prio: 'P2', issue: 'ilm#430', slow: true }), async () => {});
test('REG-DISC-05: c', { tag: ['@regression', '@slow'] }, async () => {});`);
    expect(blocks.map((b) => b.tags.includes('@slow'))).toEqual([true, true, true]);
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

// token use: the token fixtures may be used as a header value / helper argument / truthiness check, never printed, compared or
// annotated
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

// ------------------------------------------------------------------ testMeta rule annotations

test('testMeta({ rule }) adds one `rule` annotation per cited rule after the ledger id', () => {
    const m = testMeta({ id: 'REG-CFG-07.a', prio: 'P1', issue: 'ilm#427', bug: 'core#2297', rule: ['release plan CFG-07 N1', 'core#2297'] });
    expect(m.annotation).toEqual([
        { type: 'ledger-id', description: 'REG-CFG-07.a' },
        { type: 'rule', description: 'release plan CFG-07 N1' },
        { type: 'rule', description: 'core#2297' },
    ]);
    expect(testMeta({ id: 'API-GEN-32', prio: 'P1', issue: 'ilm#428', gate: true, rule: 'one rule' }).annotation).toEqual([
        { type: 'ledger-id', description: 'API-GEN-32' },
        { type: 'rule', description: 'one rule' },
    ]);
    expect(m.tag).toEqual(['@issue:ilm#448', '@issue:ilm#427', '@p1', '@bug:core#2297', '@REG-CFG-07.a']);
});

// ------------------------------------------------------------------ the lint: process through aliases, dynamic code, request options the guard does not forward (own helpers, so a block scope)

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
            ['test.use({ api })', 'test.use({ api: undefined as any });\n' + T(''), 'fixture-extend'],
            ['test.use({ request })', 'test.use({ request: undefined as any });\n' + T(''), 'fixture-extend'],
            ['test.use(options)', 'const o = {};\ntest.use(o);\n' + T(''), 'fixture-extend'],
        ];
        for (const [name, src, rule] of flagged) expect(rules(src), name).toContain(rule);
        const clean: Array<[string, string]> = [
            ['forwarded options', T("await api.post('/api/v1/roles', { data: {}, params: { a: 1 }, headers: { accept: 'x' }, timeout: 1, failOnStatusCode: false, maxRetries: 0 });")],
            ['method on fetch', T("await api.fetch('/api/v1/roles', { method: 'GET', identityOverride: true, headers: { authorization: 'Bearer x' } });")],
            ['test.use of an option', "test.use({ locale: 'en-GB' });\n" + T('')],
        ];
        for (const [name, src] of clean) expect(rules(src), name).toEqual([]);
    });
}

// ------------------------------------------------------------------ the spec rules: imports by allow-list, env and fs writes, the literal raw POST (own helpers, so a block scope)

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

    // spec-import: relative imports stay inside the suite; @playwright/test for types only; built-ins by allow-list; dynamic module
    // names refused
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
