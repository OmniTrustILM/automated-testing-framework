/**
 * regressionFixtures — unit tests of the spec-facing fixtures of fixtures/regressionFixtures.ts, against a loopback fake core.
 *
 * Checks:
 *   - own: a create followed by a throwing step still leaves its ledger line; no CA skips `own.raProfile`
 *   - needs: an unmet need skips with its reason and creates nothing; an unknown need errors
 *   - live: refuses a foreign object; a forged own-object handle does not type-check
 *   - localApi: refused outside a proven local stack and for a test that is not `@local`
 */
import { APIRequestContext, expect, request, TestInfo } from '@playwright/test';
import { test as fixtures, needsApi, localApiProblem, withLocalApi } from '../../fixtures/regressionFixtures';
import { LiveOwn } from '../../utils/regression/ledger/liveOwn';
import type { TestEnv } from '../../utils/env';
import { guardApi } from '../../utils/regression/guard/createGuard';
import type { GuardedApi } from '../../utils/regression/guard/types';
import { declaredNeedsOf, resolveNeed, resolveNeeds } from '../../utils/regression/needs';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { readLedger } from '../../utils/regression/ledger/ledger';
import { runId, updateRunState } from '../../utils/regression/ledger/runState';
import { issueOwnCertificate } from '../../utils/regression/ownCertificates';
import { secondIdentityBlocker } from '../../utils/regression/rbac/identities';
import { NEEDS, testMeta, type Needs } from '../../utils/regression/tags';
import { Answer, Arrived, loopbackServer, LoopbackServer } from './helpers/loopbackServer';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FOREIGN_GROUP = U(31);
const ENV_KEYS = ['REG_STATE_DIR', 'BASE_URL', 'TIER_KIND', 'REG_RUN_ID', 'REG_RESTRICTED_USERNAME', 'REG_RESTRICTED_PASSWORD', 'REG_RA_PROFILE_NAME', 'REG_CA_CONNECTORS', 'REG_SMTP_CATCHER_URL', 'REG_OPENSSL_BIN', 'REG_SSCEP_BIN', 'REG_KUBECTL_BIN', 'REG_DOCKER_BIN', 'REG_WEBHOOK_HOST', 'KUBECONFIG', 'REG_CM_NAMESPACE', 'REG_CM_AUTH_SECRET'];
const META = (id: string, extra: Partial<Parameters<typeof testMeta>[0]> = {}) => testMeta({ id, prio: 'P1', issue: 'ilm#428', ...extra });

/** A fake core that remembers what the test created (GET answers it) and serves a tier without connectors. */
let server: LoopbackServer;
const store = new Map<string, Record<string, unknown>>();
let seq = 5000;
const certs: Array<Record<string, unknown>> = [];
/** The uuid the fake core answers to a v2 certificate issue. */
let issueUuid = '';
/** A certificate uuid whose reads answer 500 once its `failed` state was served (the key read after a failed wait). */
let brokenAfterFailed: string | undefined;
let failedServed = false;

let answerOverride: ((a: Arrived) => Answer | undefined) | undefined;

function answer(a: Arrived): Answer {
    const forced = answerOverride?.(a);
    if (forced) return forced;
    const path = a.url.split('?')[0];
    const body = a.body ? (JSON.parse(a.body) as Record<string, unknown>) : undefined;
    if (a.method === 'GET') {
        if (path === `/api/v1/groups/${FOREIGN_GROUP}`) return { status: 200, body: { uuid: FOREIGN_GROUP, name: 'Everyone' } };
        if (brokenAfterFailed && path === `/api/v1/certificates/${brokenAfterFailed}`) {
            if (failedServed) return { status: 500, body: { message: 'read broke' } };
            failedServed = true;
        }
        if (store.has(path)) return { status: 200, body: store.get(path) };
        // Connectors, authorities, RA profiles and custom-attribute definitions: none.
        return /\/(connectors|authorities|raProfiles|resources\/\w+)$/.test(path) ? { status: 200, body: [] } : { status: 404, body: { message: 'not found' } };
    }
    if (a.method === 'POST' && path === '/api/v1/groups') {
        seq += 1;
        const uuid = U(seq);
        store.set(`/api/v1/groups/${uuid}`, { uuid, name: body?.name });
        return { status: 200, body: { uuid } };
    }
    if (a.method === 'POST' && /^\/api\/v2\/operations\/authorities\/[0-9a-f-]{36}\/raProfiles\/[0-9a-f-]{36}\/certificates$/.test(path)) return { status: 200, body: { uuid: issueUuid, certificateData: '' } };
    if (a.method === 'POST' && path === '/api/v1/certificates') {
        const filter = ((body?.filters ?? []) as Array<Record<string, unknown>>)[0];
        return { status: 200, body: { certificates: certs.filter((c) => !filter || c.commonName === filter.value) } };
    }
    return { status: 404, body: { message: `no fake route ${a.method} ${path}` } };
}

/** The real fixtures; only the environment, the authenticated context and the transport of `needs` are replaced. */
const test = fixtures.extend<{ raw: APIRequestContext; setup: void }>({
    // The process environment of one test, set up before the fixtures under test (fixtures run before beforeEach hooks).
    setup: [async ({}, use, testInfo) => {
        saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
        for (const k of ENV_KEYS) delete process.env[k];
        Object.assign(process.env, {
            REG_STATE_DIR: testInfo.outputPath('state'),
            BASE_URL: `${server.origin}/administrator/`,
            TIER_KIND: 'shared',
            REG_RUN_ID: runId(),
        });
        store.clear();
        certs.length = 0;
        brokenAfterFailed = undefined;
        failedServed = false;
        server.reset();
        await use();
    }, { auto: true }],
    env: async ({}, use) => use({ baseUrl: process.env.BASE_URL, authMode: 'local', username: 'admin', password: 'unused' } as TestEnv),
    raw: async ({ setup: _setup }, use) => {
        // Only the loopback fake core may receive these requests, whatever BASE_URL the shell exported.
        const host = new URL(process.env.BASE_URL ?? 'http://invalid').hostname;
        if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`regressionFixtures unit: BASE_URL must point at the loopback fake core, got ${host}`);
        const raw = await request.newContext({ baseURL: process.env.BASE_URL, extraHTTPHeaders: { Authorization: 'Bearer UNIT' } });
        await use(raw);
        await raw.dispose();
    },
    api: async ({ raw }, use) => use(guardApi(raw) as GuardedApi),
    needs: async ({ api, env }, use, testInfo) => use(needsApi(async () => api, env, (reason) => testInfo.skip(true, reason))),
});

/** The skip each test must end with (by title); a test without an entry must pass (or, under `test.fail`, fail). */
const expectedSkip = new Map<string, string | RegExp>();
let saved: Record<string, string | undefined> = {};

test.beforeAll(async () => {
    server = await loopbackServer(answer);
});
test.afterAll(async () => {
    await server.close();
});
test.afterEach(({}, testInfo: TestInfo) => {
    const want = expectedSkip.get(testInfo.title);
    try {
        if (want === undefined) return;
        expect(testInfo.status, 'the fixture skips the test').toBe('skipped');
        const reason = testInfo.annotations.find((a) => a.type === 'skip')?.description ?? '';
        if (typeof want === 'string') expect(reason).toBe(want);
        else expect(reason).toMatch(want);
        expect(server.mutations(), 'a skipped test sends no mutation').toEqual([]);
        expect(readLedger(), 'a skipped test leaves no ledger line').toEqual([]);
        // The identity refusals are decided before the helper is even loaded: not a single request, reads included.
        if (testInfo.annotations.some((a) => a.type === 'ledger-id' && a.description === 'REG-FIX-10')) expect(server.arrived, 'nothing is sent, reads included').toEqual([]);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});

const created = (type: string) => readLedger().filter((l) => l.type === type && l.event === 'created');
const wire = () => server.mutations().map((a) => `${a.method} ${a.url.split('?')[0]}`);

// ------------------------------------------------------------------ own

test('own: a create followed by a throwing step still leaves its ledger line, under the test ledger id', META('REG-FIX-01'), async ({ own }) => {
    expect(own.spec).toBe('REG-FIX-01');
    const step = async (): Promise<void> => {
        await own.group('g1', { note: 'fixture unit' });
        throw new Error('a step after the create fails');
    };
    await expect(step()).rejects.toThrow('a step after the create fails');
    expect(wire()).toEqual(['POST /api/v1/groups']);
    const [line] = created('groups');
    expect(line).toMatchObject({ type: 'groups', event: 'created', spec: 'REG-FIX-01', note: 'fixture unit' });
    expect(line.name.startsWith(`${runId()}-g1-`), 'the name carries the run prefix').toBe(true);
});

test('own.record: the ledger line comes from the form answer and the name from the request body, before anything else', META('REG-FIX-02'), async ({ own }) => {
    const ref = own.record('groups', { status: 201, uuid: U(70), text: '{}', body: { name: `${runId()}-ui-group` } }, { note: 'created in the dialog', parents: { raProfile: U(71) } });
    expect(ref).toEqual({ uuid: U(70), name: `${runId()}-ui-group`, kind: 'own' });
    const [line] = created('groups');
    expect(line).toMatchObject({ uuid: U(70), spec: 'REG-FIX-02', note: 'created in the dialog', parents: { raProfile: U(71) } });
    // The same object is not recorded twice (the helper keeps the first line).
    own.record('groups', { status: 201, uuid: U(70), text: '{}', body: { name: `${runId()}-ui-group` } });
    expect(created('groups')).toHaveLength(1);
    // A user's name is the `username`; an explicit name wins over the body.
    expect(own.record('users', { status: 201, uuid: U(72), text: '{}', body: { username: `${runId()}-ui-user` } }).name).toBe(`${runId()}-ui-user`);
    expect(own.record('groups', { status: 201, uuid: U(73), text: '{}' }, { name: `${runId()}-given` }).name).toBe(`${runId()}-given`);
    expect(wire(), 'recording sends nothing').toEqual([]);
});

test('own.record: an accepted duplicate is recorded before the refusal is raised; no name and no id are errors', META('REG-FIX-03'), async ({ own }) => {
    expect(() => own.record('groups', { status: 409, uuid: U(80), text: 'already exists', body: { name: `${runId()}-dup` } })).toThrow(/answered 409.*recorded/);
    expect(created('groups').map((l) => l.uuid), 'the line is written first').toEqual([U(80)]);
    // No name in the request: the object (the answer carries an id) is recorded under a placeholder first, then the author is told.
    expect(() => own.record('groups', { status: 200, uuid: U(81), text: '{}', body: {} })).toThrow(/carries no name/);
    expect(created('groups').map((l) => [l.uuid, l.name]), 'recorded before the error, with no run prefix').toEqual([[U(80), `${runId()}-dup`], [U(81), '(no name)']]);
    expect(() => own.record('groups', { status: 201, text: '{}', body: { name: `${runId()}-noid` } })).toThrow(/without an id/);
    expect(() => own.record('groups', { status: 201, text: '{}', body: {} })).toThrow(/carries no name/);
    expect(created('groups'), 'an answer without an id records nothing').toHaveLength(2);
});

test('own.recordNamed adopts the run-named certificates that are not on the ledger yet; own.deleted writes the deleted line', META('REG-FIX-04'), async ({ own }) => {
    const cn = `${runId()}-cert-1.example.test`;
    certs.push({ uuid: U(90), commonName: cn });
    expect(await own.recordNamed(cn, 'made by the protocol client')).toEqual([U(90)]);
    expect(created('certificates')[0]).toMatchObject({ uuid: U(90), name: cn, spec: 'REG-FIX-04', note: 'made by the protocol client' });
    expect(await own.recordNamed(cn, 'again'), 'idempotent').toEqual([U(90)]);
    expect(created('certificates')).toHaveLength(1);
    const ref = own.record('groups', { status: 201, uuid: U(91), text: '{}', body: { name: `${runId()}-gone` } });
    own.deleted('groups', ref, 'removed by the test');
    expect(readLedger().filter((l) => l.uuid === U(91)).map((l) => [l.event, l.spec, l.note])).toEqual([['created', 'REG-FIX-04', undefined], ['deleted', 'REG-FIX-04', 'removed by the test']]);
    // Nothing of that name: nothing is recorded; a name without the run prefix is refused before any read.
    expect(await own.recordNamed(`${runId()}-other.example.test`, 'n')).toEqual([]);
    await expect(own.recordNamed('somebody-elses.example.test', 'n')).rejects.toThrow(/no run prefix/);
});

expectedSkip.set('own.raProfile on a tier without a CA skips the test with the deploy gate and creates nothing', /^deploy gate: no healthy CA .*not registered/);
test('own.raProfile on a tier without a CA skips the test with the deploy gate and creates nothing', META('REG-FIX-05'), async ({ own }) => {
    await own.raProfile('ra1');
    throw new Error('not reached');
});

test('own offers the creators of the own* helpers and the certificate steps', META('REG-FIX-06'), async ({ own }) => {
    expect(Object.keys(own).sort()).toEqual(['acmeAccount', 'adoptNamed', 'certificate', 'customAttribute', 'deleted', 'derivedKey', 'group', 'issuedNamed', 'probe', 'raProfile', 'record', 'recordNamed', 'restrictedUser', 'role', 'runAuthority', 'spec', 'user']);
    expect(Object.keys(own.certificate).sort()).toEqual(['issue', 'upload', 'uploadSelfSigned']);
});

// ------------------------------------------------------------------ needs

expectedSkip.set('needs: a declared need skips the test before the base fixture creates anything', secondIdentityBlocker('admin', {}) ?? '');
test('needs: a declared need skips the test before the base fixture creates anything', META('REG-FIX-10', { needs: 'second-identity' }), async ({ ownRaProfile, own }) => {
    // The base fixture would skip with the CA reason (and read the tier); the declared need decides first, with no request at all.
    expect(ownRaProfile, 'not reached').toBeUndefined();
    expect(own, 'not reached').toBeUndefined();
});

expectedSkip.set('needs: an unmet ca need skips with the deploy gate after reads only', /^deploy gate: no healthy CA .*not registered/);
test('needs: an unmet ca need skips with the deploy gate after reads only', META('REG-FIX-11', { needs: ['ca'] }), async ({ own }) => {
    expect(own, 'not reached').toBeUndefined();
});

expectedSkip.set('needs.require skips inside the body with the named reason of the first unmet need', secondIdentityBlocker('admin', {}) ?? '');
test('needs.require skips inside the body with the named reason of the first unmet need', META('REG-FIX-12'), async ({ needs, own }) => {
    await needs.require('scan-target', 'second-identity', 'ca');
    await own.group('never');
});

expectedSkip.set('needs.secondIdentity and the other per-need methods skip like require', secondIdentityBlocker('admin', {}) ?? '');
test('needs.secondIdentity and the other per-need methods skip like require', META('REG-FIX-13'), async ({ needs }) => {
    expect(Object.keys(needs).sort()).toEqual([...NEEDS.map((n) => n.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase())), 'require'].sort());
    await needs.scanTarget();
    await needs.secondIdentity();
});

test('needs: a test that declares none, and a met need, run on', META('REG-FIX-14', { needs: 'scan-target' }), async ({ needs, own }) => {
    await needs.require();
    await needs.connectorOnline();
    await own.group('g14');
    expect(created('groups')).toHaveLength(1);
});

test('needs: a need outside the catalogue is an error, the declared needs are read from the tags in order', () => {
    expect(declaredNeedsOf(['@regression', '@needs:ca', '@p1', '@needs:second-identity'])).toEqual(['ca', 'second-identity']);
    expect(declaredNeedsOf(['@regression'])).toEqual([]);
    expect(() => declaredNeedsOf(['@needs:email'])).toThrow(/not one of/);
});

test('needs: every need in the catalogue has a resolver; the first unmet one decides; a met list is undefined', async ({ api, env }, testInfo) => {
    process.env.REG_RESTRICTED_USERNAME = 'qa-dedicated';
    process.env.REG_RESTRICTED_PASSWORD = 'unused-secret';
    // No runner tool is run here, not even a fake one: every tool name points at a file that does not exist.
    for (const key of ['REG_OPENSSL_BIN', 'REG_SSCEP_BIN', 'REG_KUBECTL_BIN', 'REG_DOCKER_BIN']) process.env[key] = testInfo.outputPath(`no-such-${key}`);
    const context = { api, env };
    // A need that reads the tier fails the test when the read fails (the fake core answers 404 to a path it does not serve): not a skip.
    const READS_THE_TIER = ['platform-triggers-free', 'metadata-field', 'registration-settings', 'utils-service'];
    for (const need of NEEDS.filter((n) => !READS_THE_TIER.includes(n))) expect(['string', 'undefined'], need).toContain(typeof (await resolveNeed(need, context)));
    for (const need of READS_THE_TIER) await expect(resolveNeed(need as Needs, context), `${need}: a failed read is an error`).rejects.toThrow(/→ 404|answered 404/);
    expect(await resolveNeeds(['scan-target', 'connector-online'], context)).toBeUndefined();
    expect(await resolveNeeds(['second-identity'], context), 'a second identity is set').toBeUndefined();
    expect(await resolveNeeds(['smtp-catcher', 'second-identity'], context)).toMatch(/SMTP catcher/);
    expect(await resolveNeeds([], context)).toBeUndefined();
    expect(await resolveNeed('keycloak-local', context)).toMatch(/local stack/);
    expect(await resolveNeed('email-provider', context)).toMatch(/no connected e-mail notification connector/);
    expect(await resolveNeed('webhook-receiver', context)).toMatch(/REG_WEBHOOK_HOST/);
    expect(await resolveNeed('v1-discovery', context)).toMatch(/V1 IP discovery/i);
    expect(await resolveNeed('openssl', context)).toMatch(/openssl not found on the runner/);
    expect(await resolveNeed('sscep', context)).toMatch(/sscep not found on the runner/);
    expect(await resolveNeed('docker', context)).toMatch(/docker|unit tests/);
    expect(await resolveNeed('cluster', context)).toMatch(/^@needs:cluster — cert-manager flow needs KUBECONFIG/);
    expect(wire(), 'the resolvers only read').toEqual([]);
});

// ------------------------------------------------------------------ live

test('live: an own object passes the check and comes back as a LiveOwn; a foreign one is refused', META('REG-FIX-20'), async ({ own, live }) => {
    const group = await own.group('g20');
    const handle = await live('groups', group);
    expect(handle).toBeInstanceOf(LiveOwn);
    expect(handle.type).toBe('groups');
    expect(handle.uuid).toBe(group.uuid);
    expect(handle.name).toBe(group.name);
    expect(handle.proof.body?.name).toBe(group.name);
    // A pre-existing object (no ledger line, a name without the run prefix) is refused for ownership; a made-up reference is too.
    await expect(live('groups', { uuid: FOREIGN_GROUP, name: 'Everyone' })).rejects.toBeInstanceOf(OwnObjectViolation);
    await expect(live('groups', { uuid: U(99), name: `${runId()}-not-in-the-ledger` })).rejects.toBeInstanceOf(OwnObjectViolation);
});

test('live: a LiveOwn cannot be forged (type level) and a hand-built object is refused at run time (the #proven brand)', async ({ own, live }) => {
    const ref = { uuid: U(1), name: `${runId()}-x`, kind: 'own' as const };
    // @ts-expect-error the constructor is private: only LiveOwn.prove builds one
    const built = () => new LiveOwn('groups', ref, { line: {} as never });
    expect(typeof built).toBe('function');
    // @ts-expect-error an object literal is not a LiveOwn (a private field makes the class nominal)
    const forged: LiveOwn<'groups'> = { type: 'groups', ref, proof: { line: {} as never }, uuid: ref.uuid, name: ref.name };
    // Whatever a hand-built object (or a look-alike class) says about itself, the runtime brand check refuses it where a LiveOwn is
    // required.
    const lookAlike = new (class { readonly proven = true; readonly type = 'groups'; readonly uuid = ref.uuid; readonly name = ref.name; readonly ref = ref; readonly proof = { line: {} }; })();
    for (const fake of [forged, lookAlike, { ...forged, proven: true }, null, undefined, 'groups']) {
        expect(LiveOwn.isProven(fake), `${typeof fake} is not a LiveOwn`).toBe(false);
        expect(() => LiveOwn.require(fake)).toThrow(/a LiveOwn from live\(\) is required/);
    }
    // The real handle passes both.
    const group = await own.group('g21');
    const handle = await live('groups', group);
    expect(LiveOwn.isProven(handle)).toBe(true);
    expect(LiveOwn.require(handle)).toBe(handle);
});

// ------------------------------------------------------------------ the rest

test('regressionEnv is the settings reader', async ({ regressionEnv }) => {
    process.env.REG_CA_CONNECTORS = 'One-Connector,Two-Connector';
    expect(regressionEnv.caConnectors).toEqual(['One-Connector', 'Two-Connector']);
});

/**
 * The page fixture on a stand-in: every request of the context is answered by the test; header mode signs in by waiting for the app shell.
 */
const standIn = test.extend<{ served: string[] }>({
    served: async ({}, use) => use([]),
    env: async ({}, use) => use({ baseUrl: 'http://127.0.0.1:9/', authMode: 'header', username: 'qa-user', password: 'unused' } as TestEnv),
    page: async ({ browser, served }, use) => {
        const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9/' });
        await context.route('**/*', (route) => {
            served.push(new URL(route.request().url()).pathname);
            return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body><nav data-testid="sidebar-sticky"><a href="#/dashboard">Dashboard</a></nav><main>shell</main></body></html>' });
        });
        await use(await context.newPage());
        await context.close();
    },
});

standIn('signedIn is the page after the sign-in: the admin app was opened and its shell is shown', async ({ signedIn, served }) => {
    expect(served, 'the sign-in opened the admin app').toContain('/administrator/');
    await expect(signedIn.getByTestId('sidebar-sticky')).toBeVisible();
    expect(signedIn.url()).toContain('/administrator/');
});

expectedSkip.set('signedIn does not open the browser when a declared need is unmet', secondIdentityBlocker('admin', {}) ?? '');
standIn('signedIn does not open the browser when a declared need is unmet', META('REG-FIX-31', { needs: 'second-identity' }), async ({ signedIn, served }) => {
    expect(signedIn, 'not reached').toBeUndefined();
    expect(served).toEqual([]);
});

test('localApi: refused outside a proven local stack and for a test that is not @local', () => {
    expect(localApiProblem(['@regression', '@local'])).toMatch(/only a local stack/);
    process.env.TIER_KIND = 'local';
    expect(localApiProblem(['@regression', '@local'])).toMatch(/no authenticated local-backend proof|only a local stack/);
});

test('localApi: the fixture body throws before it builds anything, and never hands the context over', META('REG-FIX-30'), async ({ raw, env }) => {
    let used = false;
    const use = async (): Promise<void> => {
        used = true;
    };
    const info = { tags: ['@regression', '@local'], timeout: 60_000 };
    await expect(withLocalApi(raw, env, info, use)).rejects.toThrow(/^localApi: only a local stack \(TIER_KIND=local\) may take it/);
    process.env.TIER_KIND = 'local';
    await expect(withLocalApi(raw, env, info, use)).rejects.toThrow(/^localApi: this run holds no authenticated local-backend proof/);
    expect(used, 'use was never called').toBe(false);
    expect(server.arrived, 'no token grant and no request').toEqual([]);
});

// ------------------------------------------------------------------ more needs and the derived key of a timed-out issue

test('needs ca and ejbca-ng skip, never throw, when the run CA cannot be read', async ({ api, env }) => {
    // The run state names an authority the platform no longer has (the read answers 404).
    updateRunState({ raProfile: { uuid: U(3), name: `${runId()}-ra`, kind: 'own', authorityUuid: U(4) } });
    for (const need of ['ca', 'ejbca-ng'] as const) expect(await resolveNeed(need, { api, env }), need).toMatch(/^needs a CA: the run CA could not be read/);
    // REG_RA_PROFILE_NAME that names nothing: the helper's own assertion fails, the need is unmet.
    updateRunState({ raProfile: undefined });
    process.env.TIER_KIND = 'local';
    process.env.REG_RA_PROFILE_NAME = 'no-such-ra-profile';
    for (const need of ['ca', 'ejbca-ng'] as const) expect(await resolveNeed(need, { api, env }), need).toMatch(/^needs a CA: the run CA could not be read/);
});

test('needs ca and ejbca-ng fail the test on an error that is not "not found": a 500 is no missing CA', async ({ api, env }) => {
    updateRunState({ raProfile: { uuid: U(3), name: `${runId()}-ra`, kind: 'own', authorityUuid: U(4) } });
    // The authority read answers 500 instead of the connector name: not a missing CA.
    answerOverride = (a) => (a.url.split('?')[0] === `/api/v1/authorities/${U(4)}` ? { status: 500, body: { message: 'core down' } } : undefined);
    try {
        for (const need of ['ca', 'ejbca-ng'] as const) await expect(resolveNeed(need, { api, env }), need).rejects.toThrow(/→ 500/);
    } finally {
        answerOverride = undefined;
    }
});

test('needs cluster asks for the kubeconfig, the namespace and the auth secret before any tool', async ({ api, env }, testInfo) => {
    process.env.REG_KUBECTL_BIN = testInfo.outputPath('no-such-kubectl');
    const expected = /^@needs:cluster — cert-manager flow needs KUBECONFIG, REG_CM_NAMESPACE and REG_CM_AUTH_SECRET/;
    expect(await resolveNeed('cluster', { api, env })).toMatch(expected);
    const keep = { ...process.env };
    try {
        process.env.KUBECONFIG = testInfo.outputPath('kubeconfig');
        process.env.REG_CM_NAMESPACE = 'ns';
        expect(await resolveNeed('cluster', { api, env }), 'the auth secret is missing').toMatch(expected);
        process.env.REG_CM_AUTH_SECRET = 'secret';
        expect(await resolveNeed('cluster', { api, env }), 'all set: now the tool decides').toMatch(/^@needs:cluster — kubectl not found on the runner/);
    } finally {
        for (const k of ['KUBECONFIG', 'REG_CM_NAMESPACE', 'REG_CM_AUTH_SECRET']) {
            if (keep[k] === undefined) delete process.env[k];
            else process.env[k] = keep[k];
        }
    }
});

test('issueOwnCertificate records the key the platform linked even when the wait for issued fails', async ({ api }) => {
    const certUuid = U(60);
    const keyUuid = U(61);
    store.set(`/api/v1/certificates/${certUuid}`, { uuid: certUuid, state: 'failed', key: { uuid: keyUuid } });
    issueUuid = certUuid;
    await expect(issueOwnCertificate(api, { uuid: U(5), name: `${runId()}-ra`, authorityUuid: U(4) }, 'REG-FIX-40', { suffix: 'c40', timeoutMs: 2_000 })).rejects.toThrow();
    const lines = readLedger();
    expect(lines.filter((l) => l.type === 'certificates' && l.event === 'created').map((l) => l.uuid), 'the certificate is on the ledger').toEqual([certUuid]);
    expect(lines.filter((l) => l.type === 'keys').map((l) => [l.uuid, l.derived, l.parents?.certificate]), 'and its derived key').toEqual([[keyUuid, true, certUuid]]);
});

test('issueOwnCertificate warns, naming the certificate, when the key cannot be recorded after a failed wait, and still throws the wait error', async ({ api }) => {
    const certUuid = U(62);
    store.set(`/api/v1/certificates/${certUuid}`, { uuid: certUuid, state: 'failed', key: { uuid: U(63) } });
    brokenAfterFailed = certUuid;
    issueUuid = certUuid;
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '));
    try {
        await expect(issueOwnCertificate(api, { uuid: U(5), name: `${runId()}-ra`, authorityUuid: U(4) }, 'REG-FIX-41', { suffix: 'c41', timeoutMs: 2_000 })).rejects.toThrow(/failed|issued|state/i);
    } finally {
        console.warn = realWarn;
    }
    expect(warnings.filter((w) => w.includes(certUuid) && /derived key could not be recorded/.test(w)), 'one warning that names the certificate').toHaveLength(1);
    expect(readLedger().filter((l) => l.type === 'keys'), 'no key was recorded').toEqual([]);
});
