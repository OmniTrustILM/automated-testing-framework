/**
 * Unit tests for the tag builders: the spelling of every regression / API tag lives in utils/regression/tags.ts, and
 * the rules of Phase 3 §2 (+ the @p1/@p2/@p3 addition) are enforced when a spec header is built — a pin is never P1,
 * @gate is API-GEN-32 only, ilm#448 is always there next to the area issue, and a @bug tag needs test.fail().
 * The source checks run on the TypeScript AST (review R26): fixme / skip declarations count, modifiers and test.step do
 * not, describe tags are inherited, and the deny-by-default lint (R7b, Q2) tells guarded contexts from raw ones: only
 * the `api` fixture, a `GuardedApi` parameter and the guard factories (plus their aliases) may send anything but a GET.
 */
import { test, expect } from '@playwright/test';
import { bugTagsWithoutFail, codeNames, meta, rawMutations, suiteTagProblems, tags, testBlocks } from '../../utils/regression/tags';

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

test('meta builds the Playwright details of one ledger row', () => {
    expect(meta({ id: 'API-GEN-33', prio: 'P1', issue: 'ilm#428' })).toEqual({
        tag: ['@issue:ilm#448', '@issue:ilm#428', '@p1'],
        annotation: [{ type: 'ledger-id', description: 'API-GEN-33' }],
    });
    const full = meta({ id: 'REG-CFG-07.a', prio: 'P2', issue: ['ilm#427', 'ilm#448'], needs: ['openssl', 'sscep'], local: true, phaseB: true, bug: 'core#2502', pin: 'A6' });
    expect(full.tag).toEqual(['@issue:ilm#448', '@issue:ilm#427', '@p2', '@phaseB', '@local', '@pin:A6', '@needs:openssl', '@needs:sscep', '@bug:core#2502']);
    expect(meta({ id: 'API-GEN-32', prio: 'P1', issue: 'ilm#428', gate: true }).tag).toContain('@gate');
});

test('meta enforces the tag rules', () => {
    expect(() => meta({ id: 'SMK-001', prio: 'P1', issue: 'ilm#428' }), 'not a REG / API ledger id').toThrow(/ledger id/);
    expect(() => meta({ id: 'API-GEN-07', prio: 'P1', issue: 'ilm#428', pin: 'A6' }), 'a pin is never P1').toThrow(/never P1/);
    expect(() => meta({ id: 'API-GEN-07', prio: 'P1', issue: 'ilm#428', gate: true }), '@gate is API-GEN-32 only').toThrow(/API-GEN-32 only/);
    expect(() => meta({ id: 'API-GEN-07', prio: 'P1', issue: 'ilm#448' }), 'the area issue is required').toThrow(/sub-issue/);
});

test('testBlocks finds each test call with its whole body', () => {
    const src = [
        "test.describe('x', () => {",
        "  test('A-1: first', async () => { const s = ')'; /* ) */ await f(\"(\"); });",
        '  test(`A-2: second`, meta({ id: "A" }), async () => {',
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
test('API-GEN-07: refused method answers 400', meta({ id: 'API-GEN-07', prio: 'P1', issue: 'ilm#428', bug: 'core#2502' }), async () => {
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

test('the AST finds every declaration form, ignores modifiers and steps, and inherits describe tags (R26)', () => {
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
        test.fail('REG-X-04: declared failing', meta({ id: 'REG-X-04', prio: 'P2', issue: 'ilm#1', bug: 'core#2' }), async () => {});
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

test('deny by default: the api fixture, GuardedApi parameters and guard factories may mutate; raw contexts may only read (Q2)', () => {
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

test('raw contexts: every non-GET method, POST included, unless the literal URL is a read-only / protocol POST (Q2; creates since fix pass 3)', () => {
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
    await raw.post(allowListedPost(url));
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

test('aliases, element access, dynamic methods, method extraction and casts are caught (Q2)', () => {
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

test('apiJson variants, aliases and namespace calls, the template send, and global fetch (Q2)', () => {
    const src = `
import { apiJson as aj, apiJsonWithDate } from '../../utils/regression/regressionApi';
import * as ra from '../../utils/regression/regressionApi';
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
    await fetch(allowListedPost(url), { method: 'POST' });
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

test('raw contexts and test seams: getAuthenticatedApiContext, the request factory, guardApiForUnitTests (Q2, Q13)', () => {
    const src = `
import { request as pw } from '@playwright/test';
import { getAuthenticatedApiContext } from '../../fixtures/testFixtures';
test('T-1', async ({ request, env }) => {
    const raw = await getAuthenticatedApiContext(request, env);
    const g = guardApiForUnitTests(raw, { lines: [] });
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

test('util imports: allow-list by prefix, no namespace / default / require / dynamic import, type-only is fine (Q2)', () => {
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

test('spec rules of fix pass 3: test only from the fixtures, no .extend(, no route method rewrite, no raw network modules', () => {
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
        '2 spec-import', // fix pass 4: `expect` is a runtime value of @playwright/test (types only; it comes from the fixtures)
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

test('codeNames sees identifiers and strings, not comments (the describeLocal rule for localStack / guardOptions, fix pass 3)', () => {
    const names = codeNames("// test.use({ guardOptions: { localStack: true } })\nconst a = 1; /* apiGuardOptions */ test.use({ 'apiGuardOptions': {} });");
    expect(['guardOptions', 'localStack'].map((n) => names.has(n))).toEqual([false, false]);
    expect(names.has('apiGuardOptions')).toBe(true);
});

// ------------------------------------------------------------------ guard-integration pass: @slow, anonymousApi, token-use

test('@slow is a registered tag (merge rehearsal S10): builder, meta and the AST reader know it', () => {
    expect(tags.slow).toBe('@slow');
    expect(meta({ id: 'REG-DISC-03', prio: 'P2', issue: 'ilm#430', slow: true }).tag).toEqual(['@issue:ilm#448', '@issue:ilm#430', '@p2', '@slow']);
    const blocks = testBlocks(`
test('REG-DISC-03: a', { tag: [tags.slow] }, async () => {});
test('REG-DISC-04: b', meta({ id: 'REG-DISC-04', prio: 'P2', issue: 'ilm#430', slow: true }), async () => {});
test('REG-DISC-05: c', { tag: ['@regression', '@slow'] }, async () => {});`);
    expect(blocks.map((b) => b.tags.includes('@slow'))).toEqual([true, true, true]);
});

test('GD-01: anonymousApi is a guarded fixture (mutations pass), test.use may not replace it or the token fixtures, a cast stays caught', () => {
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

test('GD-02 token-use: the token fixtures may be used as a header value / helper argument / truthiness check, never printed, compared or annotated', () => {
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
