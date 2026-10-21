/**
 * The guarded fixtures `anonymousApi` and `adminToken` / `restrictedToken` (a failed password grant is remembered for the process and every later test that takes the fixture SKIPS
 * with the named reason), proven on the wire and through a REAL Playwright run of the fixtures:
 * - anonymousApi u1: a credential-less guarded context sends no authorization / ssl-client-cert / cookie header;
 *   u2: `X-Forwarded-For: 192.0.2.1` for a loopback / private BASE_URL or a local tier, never for a public host, and a
 *   per-request `x-forwarded-for` is still refused; u3: the guard rules are unchanged for it;
 * - token fixtures u1: one grant per identity per validity window against a loopback token endpoint, the second call served from
 *   the cache, a token inside the 60 s margin fetched again, the form carrying the identity's own credentials;
 *   u2: a 401 throws once and the second call throws WITHOUT a request; u3: neither the token nor the secret appears in
 *   the logger output or in the thrown message; u4: `String(token)` / `JSON.stringify` / a template literal print
 *   `[token]`, `bearer()` is the only way out;
 * - a real run: `playwright test` over tests/unit/fixtures/token-skip with the real fixtures and a 401 identity provider: the
 *   grant is sent exactly ONCE across the three tests taking `restrictedToken` (and once for `adminToken`), and every
 *   test ends SKIPPED with the reason.
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import { spawn } from 'child_process';
import * as net from 'net';
import type { AddressInfo } from 'net';
import * as path from 'path';
import {
    ADMIN_TOKEN_UNAVAILABLE, anonymousForwardedFor, anonymousHeaders, DOCUMENTATION_ADDRESS, fetchAccessToken, opaqueToken, resetTokenCacheForUnitTests, RESTRICTED_TOKEN_UNAVAILABLE,
    TokenGrantFailed, tokenFailureFile, tokenOrSkip,
} from '../../fixtures/testFixtures';
import * as fs from 'fs';
import type { TestEnv } from '../../utils/env';
import { Logger } from '../../utils/Logger';
import { guardApiWithSeams } from '../../utils/regression/guard/createGuard';
import { OwnObjectViolation, RefusalKind } from '../../utils/regression/ledger/ownership';
import { Arrived, loopbackServer, LoopbackServer } from './helpers/loopbackServer';
import { randomBytes } from 'node:crypto';
// Run-scoped generated test passwords (merge follow-up 2026-10-15): no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_2 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_3 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_4 = `qa-${randomBytes(9).toString('base64url')}`;

const RUN = 'qa-reg-20261014-210000-tk01';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FOREIGN_ROLE = U(20);
const SECRET = 'client-secret-7f3a';
const b64u = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A compact JWT (unsigned payload is enough: the fixtures never verify) with `exp` seconds from now. */
const jwt = (username: string, expInSeconds: number, nonce = 'n') =>
    `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ username, exp: Math.floor(Date.now() / 1000) + expInSeconds, nonce }))}.${b64u(`sig-${nonce}`)}`;

let A: LoopbackServer;
let BASE_URL: string;
let raw: APIRequestContext;
/** The token endpoint's answer per username (status, token), and the grants it received. */
const grants: Array<{ username: string; form: URLSearchParams }> = [];
let answer: (username: string) => { status: number; token?: string } = () => ({ status: 401 });

const tokenAnswer = (a: Arrived) => {
    if (a.method === 'POST' && a.url === '/kc/realms/ILM/protocol/openid-connect/token') {
        const form = new URLSearchParams(a.body);
        const username = form.get('username') ?? '';
        grants.push({ username, form });
        const r = answer(username);
        return r.status === 200 ? { status: 200, body: { access_token: r.token, token_type: 'Bearer' } } : { status: r.status, body: { error: 'invalid_grant' } };
    }
    return undefined;
};

test.beforeAll(async () => {
    A = await loopbackServer(tokenAnswer);
    BASE_URL = `${A.origin}/`;
    raw = await request.newContext({ baseURL: BASE_URL });
});
test.afterAll(async () => {
    await raw.dispose();
    await A.close();
});
let savedStateDir: string | undefined;
test.beforeEach(({}, testInfo) => {
    A.reset();
    grants.length = 0;
    // The run's failure file lives under REG_STATE_DIR — a folder of this test, never the shared state dir.
    savedStateDir = process.env.REG_STATE_DIR;
    process.env.REG_STATE_DIR = testInfo.outputPath('token-state');
    resetTokenCacheForUnitTests();
    answer = () => ({ status: 401 });
});
test.afterEach(() => {
    resetTokenCacheForUnitTests();
    if (savedStateDir === undefined) delete process.env.REG_STATE_DIR;
    else process.env.REG_STATE_DIR = savedStateDir;
});

const env = (over: Partial<TestEnv> = {}): TestEnv =>
    ({ baseUrl: BASE_URL, authMode: 'local', username: 'admin', password: GEN_PW_1, clientSecret: SECRET, authClientId: 'ilm', authRealm: 'ILM', ...over } as TestEnv);

async function outcome(call: Promise<unknown>): Promise<RefusalKind | 'sent' | string> {
    try {
        await call;
        return 'sent';
    } catch (e) {
        return e instanceof OwnObjectViolation ? e.kind : `error: ${String(e).slice(0, 160)}`;
    }
}

// ------------------------------------------------------------------ anonymousApi

// anonymousApi: the anonymous context carries no credential header; X-Forwarded-For only for a loopback / private BASE_URL or a
// local tier; a per-request one is refused
test('anonymousApi carries no credential header; X-Forwarded-For only on loopback, private or local tiers', async () => {
    expect(anonymousForwardedFor('http://127.0.0.1:8443/', {})).toBe(DOCUMENTATION_ADDRESS);
    expect(anonymousForwardedFor('https://localhost/', {})).toBe(DOCUMENTATION_ADDRESS);
    expect(anonymousForwardedFor('https://10.1.2.3/', {})).toBe(DOCUMENTATION_ADDRESS);
    expect(anonymousForwardedFor('https://192.168.1.10:8443/', {})).toBe(DOCUMENTATION_ADDRESS);
    expect(anonymousForwardedFor('https://ilm.qa.example.test/', {})).toBeUndefined();
    expect(anonymousForwardedFor('https://ilm.qa.example.test/', { TIER_KIND: 'local' })).toBe(DOCUMENTATION_ADDRESS);
    expect(anonymousForwardedFor('https://corp.localhost/', {}), 'a *.localhost NAME is not a loopback literal').toBeUndefined();
    expect(anonymousForwardedFor('not a url', {})).toBeUndefined();
    expect(anonymousHeaders('https://ilm.qa.example.test/', {})).toEqual({ Accept: 'application/json' });
    const ctx = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: anonymousHeaders(BASE_URL, {}) });
    try {
        const g = guardApiWithSeams(ctx, { lines: [], runId: RUN, tier: null, env: { BASE_URL } });
        expect(await outcome(g.post('/api/v1/roles', { data: { name: `${RUN}-r` } }))).toBe('sent');
        const [arrived] = A.mutations();
        expect(arrived.url).toBe('/api/v1/roles');
        expect(arrived.headers.authorization).toBeUndefined();
        expect(arrived.headers['ssl-client-cert']).toBeUndefined();
        expect(arrived.headers.cookie).toBeUndefined();
        expect(arrived.headers['x-forwarded-for'], 'a loopback BASE_URL: the documentation address goes along').toBe(DOCUMENTATION_ADDRESS);
        expect(arrived.headers.accept).toBe('application/json');
        expect(await outcome(g.put(`/api/v1/users/${g.probeUuid()}`, { data: { description: 'x' }, headers: { 'X-Forwarded-For': '127.0.0.1' } })), 'a per-request x-forwarded-for: refused (kind request)').toBe('request');
        // u3: every guard rule still judges what it sends.
        expect(await outcome(g.delete(`/api/v1/roles/${FOREIGN_ROLE}`))).toBe('ownership');
        expect(await outcome(g.post('/api/v1/connector/register', { data: { name: 'x' } }))).toBe('request');
        expect(await outcome(g.put('/api/v1/settings/platform', { data: {} }))).toBe('request');
        expect(await outcome(g.put('/api/v1/oauth2/x', { data: {} }))).toBe('request');
        expect(await outcome(g.delete(`/api/v1/roles/${g.probeUuid()}`))).toBe('sent');
        expect(A.mutations().map((a) => `${a.method} ${a.url.replace(/[0-9a-f-]{36}/, '<probe>')}`)).toEqual(['POST /api/v1/roles', 'DELETE /api/v1/roles/<probe>']);
    } finally {
        await ctx.dispose();
    }
});

// ------------------------------------------------------------------ token fixtures

// token fixtures: one grant per identity per validity window; a cached token is reused; one inside the 60 s margin is fetched
// again; the form carries the identity's own credentials
test('token fixtures: one grant per identity per validity window; cached token reused, refetched at 60 s', async () => {
    const tokens: Record<string, string> = { admin: jwt('admin', 3600, 'a1'), ded: jwt('ded', 3600, 'd1') };
    answer = (u) => ({ status: 200, token: tokens[u] });
    const e = env();
    const admin1 = await fetchAccessToken(raw, e, { username: 'admin', password: GEN_PW_1 });
    const admin2 = await fetchAccessToken(raw, e, { username: 'admin', password: GEN_PW_1 });
    const ded = await fetchAccessToken(raw, e, { username: 'ded', password: GEN_PW_2 });
    expect(admin1).toBe(admin2);
    expect(admin1.bearer()).toBe(tokens.admin);
    expect(admin1.claims().username).toBe('admin');
    expect(ded.bearer()).toBe(tokens.ded);
    expect(grants.map((g) => g.username)).toEqual(['admin', 'ded']);
    const form = grants[0].form;
    expect([form.get('grant_type'), form.get('client_id'), form.get('client_secret'), form.get('username'), form.get('password')]).toEqual(['password', 'ilm', SECRET, 'admin', GEN_PW_1]);
    expect(grants[1].form.get('password')).toBe(GEN_PW_2);
    expect(A.arrived.every((a) => a.url === '/kc/realms/ILM/protocol/openid-connect/token')).toBe(true);
    // Another base URL is another cache key.
    await fetchAccessToken(raw, env({ baseUrl: `${A.origin}/other/`, authBaseUrl: `${A.origin}/kc` }), { username: 'admin', password: GEN_PW_1 });
    expect(grants).toHaveLength(3);
    // A token that expires inside the margin is fetched again (the clock moves instead of the token).
    const soon = jwt('admin', 3600, 'a2');
    answer = () => ({ status: 200, token: soon });
    const near = await fetchAccessToken(raw, e, { username: 'admin', password: GEN_PW_1 }, { now: () => Date.now() + 3600_000 - 30_000 });
    expect(near.bearer()).toBe(soon);
    expect(grants).toHaveLength(4);
    expect((await fetchAccessToken(raw, e, { username: 'admin', password: GEN_PW_1 })).bearer(), 'the fresh token is cached').toBe(soon);
    expect(grants).toHaveLength(4);
    // An unreadable exp (0) is never reused.
    answer = () => ({ status: 200, token: 'opaque-token' });
    await fetchAccessToken(raw, e, { username: 'svc', password: GEN_PW_4 });
    await fetchAccessToken(raw, e, { username: 'svc', password: GEN_PW_4 });
    expect(grants.filter((g) => g.username === 'svc')).toHaveLength(2);
});

// token fixtures: a 401 throws once and is remembered — the second call throws without a request; the token and the secret
// never reach the logger or a message
test('token fixtures: a 401 throws once and is remembered; token and secret never reach logs or messages', async () => {
    const lines: string[] = [];
    const original = Logger.prototype.error;
    const originalInfo = Logger.prototype.info;
    Logger.prototype.error = function (this: Logger, m: string) { lines.push(`error ${m}`); };
    Logger.prototype.info = function (this: Logger, m: string) { lines.push(`info ${m}`); };
    try {
        const e = env();
        const first = await fetchAccessToken(raw, e, { username: 'ded', password: GEN_PW_2 }).catch((x) => x);
        expect(first).toBeInstanceOf(TokenGrantFailed);
        expect((first as TokenGrantFailed).cached).toBe(false);
        expect(String(first)).toMatch(/failed \(status 401\); not retried/);
        const second = await fetchAccessToken(raw, e, { username: 'ded', password: GEN_PW_2 }).catch((x) => x);
        expect(second).toBeInstanceOf(TokenGrantFailed);
        expect((second as TokenGrantFailed).cached).toBe(true);
        expect(grants, 'exactly one grant for the identity').toHaveLength(1);
        // The skip wrapper names the reason and sends nothing more.
        expect(await tokenOrSkip(raw, e, { username: 'ded', password: GEN_PW_2 }, RESTRICTED_TOKEN_UNAVAILABLE)).toEqual({ skip: RESTRICTED_TOKEN_UNAVAILABLE });
        expect(await tokenOrSkip(raw, e, { username: 'admin', password: GEN_PW_1 }, ADMIN_TOKEN_UNAVAILABLE)).toEqual({ skip: ADMIN_TOKEN_UNAVAILABLE });
        expect(grants).toHaveLength(2);
        // Another identity is independent; a success is logged without the token.
        const t = jwt('ok', 3600, 'o1');
        answer = () => ({ status: 200, token: t });
        const ok = await fetchAccessToken(raw, e, { username: 'ok', password: GEN_PW_3 });
        expect(ok.bearer()).toBe(t);
        // A missing access_token is a failure too, remembered.
        answer = () => ({ status: 200, token: undefined });
        await expect(fetchAccessToken(raw, e, { username: 'empty', password: GEN_PW_4 })).rejects.toThrow(/no access_token/);
        await expect(fetchAccessToken(raw, e, { username: 'empty', password: GEN_PW_4 })).rejects.toThrow(/failed earlier/);
        expect(grants.filter((g) => g.username === 'empty')).toHaveLength(1);
        for (const text of [...lines, String(first), String(second)]) {
            expect(text).not.toContain(SECRET);
            expect(text).not.toContain(GEN_PW_2);
            expect(text).not.toContain(GEN_PW_1);
            expect(text).not.toContain(t);
        }
        expect(lines.some((l) => /^info Successfully obtained an access token/.test(l))).toBe(true);
    } finally {
        Logger.prototype.error = original;
        Logger.prototype.info = originalInfo;
    }
});

// token fixtures u4: the opaque token prints as [token] everywhere; bearer() is the only way out
test('token fixtures: the opaque token prints as [token] everywhere; bearer() is the only way out', () => {
    const rawToken = jwt('admin', 3600, 'p1');
    const token = opaqueToken(rawToken);
    expect(String(token)).toBe('[token]');
    expect(`${token}`).toBe('[token]');
    expect(JSON.stringify(token)).toBe('"[token]"');
    expect(JSON.stringify({ token })).toBe('{"token":"[token]"}');
    expect(`${token}` + token).toBe('[token][token]');
    expect(Object.keys(token)).toEqual(['bearer', 'claims', 'expiresAt', 'toString', 'toJSON']);
    expect(Object.values(token).includes(rawToken as never)).toBe(false);
    expect(require('util').inspect(token)).toBe('[token]');
    expect(token.bearer()).toBe(rawToken);
    expect(token.claims().username).toBe('admin');
    expect(token.expiresAt).toBeGreaterThan(Date.now());
    expect(Object.isFrozen(token)).toBe(true);
    expect(opaqueToken('garbage').claims()).toEqual({});
    expect(opaqueToken('garbage').expiresAt).toBe(0);
});

// ------------------------------------------------------------------ the failure memory outlives the worker

// a failed grant is remembered in <run id>.token-failures.json — a second module load (another worker) makes no grant; the key
// is on record BEFORE the request arrives; success clears it
test('a failed grant is remembered in a token-failures file: a second module load makes no grant', async () => {
    const e = env();
    const file = tokenFailureFile();
    let onRecordWhenReceived: boolean | undefined;
    answer = () => {
        onRecordWhenReceived = fs.existsSync(file) && JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))).includes(`|ded"`);
        return { status: 401 };
    };
    await expect(fetchAccessToken(raw, e, { username: 'ded', password: GEN_PW_2 })).rejects.toBeInstanceOf(TokenGrantFailed);
    expect(onRecordWhenReceived, 'the attempt was written before the request left').toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ [`${BASE_URL}|ded`]: 'status 401' });
    // Another worker: a fresh module instance with an empty process memory reads the file.
    const modulePath = require.resolve('../../fixtures/testFixtures');
    const cached = require.cache[modulePath];
    delete require.cache[modulePath];
    try {
        const fresh = require('../../fixtures/testFixtures') as typeof import('../../fixtures/testFixtures');
        const again = await fresh.fetchAccessToken(raw, e, { username: 'ded', password: GEN_PW_2 }).catch((x) => x);
        expect(again).toBeInstanceOf(fresh.TokenGrantFailed);
        expect((again as TokenGrantFailed).cached).toBe(true);
        expect(await fresh.tokenOrSkip(raw, e, { username: 'ded', password: GEN_PW_2 }, RESTRICTED_TOKEN_UNAVAILABLE)).toEqual({ skip: RESTRICTED_TOKEN_UNAVAILABLE });
    } finally {
        delete require.cache[modulePath];
        if (cached) require.cache[modulePath] = cached;
    }
    expect(grants, 'one grant for the identity across both module instances').toHaveLength(1);
    // Success clears the record: nothing is left for the identity (and an empty file is removed).
    answer = () => ({ status: 200, token: jwt('ok', 3600, 'f2') });
    await fetchAccessToken(raw, e, { username: 'ok', password: GEN_PW_3 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ [`${BASE_URL}|ded`]: 'status 401' });
    resetTokenCacheForUnitTests();
    await fetchAccessToken(raw, e, { username: 'ok2', password: GEN_PW_3 });
    expect(fs.existsSync(file), 'no failure left: the file is gone').toBe(false);
});

// a request that times out after it left is remembered (one attempt); a provider that cannot be reached is an error, not a
// skip, and is not remembered
test('a request that times out after it left is remembered once; an unreachable provider is an error', async () => {
    // A server that accepts the connection and never answers: the request left, the grant may have been made.
    const sockets = new Set<net.Socket>();
    const hang = net.createServer((s) => void sockets.add(s));
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const hangOrigin = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
    try {
        const e = env({ authBaseUrl: `${hangOrigin}/kc` });
        const first = await fetchAccessToken(raw, e, { username: 'ded', password: GEN_PW_2 }, { timeoutMs: 400 }).catch((x) => x);
        expect(first).toBeInstanceOf(TokenGrantFailed);
        expect(String(first)).toMatch(/request error after it left \(apiRequestContext\.post: Timeout 400ms exceeded\.\)/);
        expect(JSON.parse(fs.readFileSync(tokenFailureFile(), 'utf8'))[`${BASE_URL}|ded`]).toMatch(/request error after it left/);
        const second = await fetchAccessToken(raw, e, { username: 'ded', password: GEN_PW_2 }, { timeoutMs: 400 }).catch((x) => x);
        expect((second as TokenGrantFailed).cached).toBe(true);
    } finally {
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => hang.close(() => r()));
    }
    // Not reached: a closed port.
    const closed = await loopbackServer();
    const closedOrigin = closed.origin;
    await closed.close();
    const e2 = env({ authBaseUrl: `${closedOrigin}/kc` });
    const refused = await fetchAccessToken(raw, e2, { username: 'svc', password: GEN_PW_4 }).catch((x) => x);
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(TokenGrantFailed);
    expect(String(refused)).toMatch(/ECONNREFUSED/);
    expect(JSON.parse(fs.readFileSync(tokenFailureFile(), 'utf8'))[`${BASE_URL}|svc`]).toBeUndefined();
    // X08: the fixture wrapper rethrows it (an error, never a skip); a later attempt is allowed.
    await expect(tokenOrSkip(raw, e2, { username: 'svc', password: GEN_PW_4 }, RESTRICTED_TOKEN_UNAVAILABLE)).rejects.toThrow(/ECONNREFUSED/);
});

// ------------------------------------------------------------------ the real fixtures, a real run

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'token-skip');
const ROOT = path.resolve(__dirname, '..', '..');
const DROP = /^(PW|PLAYWRIGHT|TEST_|REG_|API_|BASE_URL|AUTH_|SMOKE_|TIER_|CLEANUP_)/;

/** `playwright test` in a child process, asynchronously: the parent's loopback identity provider keeps answering meanwhile. */
function runFixtureConfig(env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '-c', path.join(FIXTURE_DIR, 'token.fixture.config.ts'), '--reporter=json'], { cwd: ROOT, env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));
        const timer = setTimeout(() => child.kill('SIGKILL'), 100_000);
        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
    });
}

// real fixtures: a 401 identity provider — the restricted grant is sent exactly once across three tests taking restrictedToken
// (the admin grant once too) and every test is skipped with the named reason
test('real fixtures with a 401 identity provider: one restricted grant across three tests, all skipped', { tag: '@integration' }, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) env[k] = v;
    const smoke = Object.fromEntries(['DISCOVERY_PROVIDER_NAME', 'DISCOVERY_PROVIDER_URL', 'DISCOVERY_TARGET', 'EJBCA_CONNECTOR_NAME', 'EJBCA_CONNECTOR_URL', 'CREDENTIAL_CONNECTOR_NAME',
        'CREDENTIAL_CONNECTOR_URL', 'EJBCA_WS_URL', 'EJBCA_P12_BASE64', 'EJBCA_P12_PASSWORD', 'EJBCA_CA_NAME', 'EJBCA_END_ENTITY_PROFILE', 'EJBCA_CERTIFICATE_PROFILE', 'SMOKE_TESTS_NAMESPACE']
        .map((k) => [k, 'fixture']));
    Object.assign(env, smoke, {
        BASE_URL, AUTH_BASE_URL: `${A.origin}/kc`, AUTH_MODE: 'local', SMOKE_USERNAME: 'admin', SMOKE_PASSWORD: GEN_PW_1, SMOKE_CLIENT_SECRET: SECRET,
        LOCAL_AUTH_PROVIDER_NAME: 'fixture', REG_RESTRICTED_USERNAME: 'ded', REG_RESTRICTED_PASSWORD: GEN_PW_2, REG_UNIT_NO_DOCKER: '1', REG_STATE_DIR: testInfo.outputDir,
    });
    const r = await runFixtureConfig(env);
    expect(r.stdout.trim().startsWith('{'), `no JSON report; status ${r.status}; stderr: ${(r.stderr || '').slice(0, 800)}; stdout: ${(r.stdout || '').slice(0, 300)}`).toBe(true);
    const report = JSON.parse(r.stdout) as { suites: unknown[] };
    const tests: Array<{ title: string; status: string; annotations: Array<{ type: string; description?: string }> }> = [];
    const walk = (s: { specs?: Array<{ title: string; tests: Array<{ results: Array<{ status: string }>; annotations: Array<{ type: string; description?: string }> }> }>; suites?: unknown[] }) => {
        for (const sp of s.specs ?? []) for (const t of sp.tests) tests.push({ title: sp.title, status: t.results[0]?.status ?? 'none', annotations: t.annotations });
        for (const c of (s.suites ?? []) as Array<typeof s>) walk(c);
    };
    for (const s of report.suites as Array<Parameters<typeof walk>[0]>) walk(s);
    expect(tests.map((t) => t.title).sort()).toEqual(['TOK-01: takes the restricted token', 'TOK-02: takes the restricted token', 'TOK-03: takes the restricted token', 'TOK-04: takes the admin token']);
    expect(tests.map((t) => t.status), `every test skipped; stderr: ${(r.stderr || '').slice(0, 400)}`).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
    for (const t of tests) {
        const reason = t.annotations.find((a) => a.type === 'skip')?.description;
        expect(reason, t.title).toBe(t.title.startsWith('TOK-04') ? ADMIN_TOKEN_UNAVAILABLE : RESTRICTED_TOKEN_UNAVAILABLE);
    }
    expect(grants.map((g) => g.username), 'one grant per identity for the whole run').toEqual(['ded', 'admin']);
    expect(r.status, 'a skipped run exits 0').toBe(0);
});
