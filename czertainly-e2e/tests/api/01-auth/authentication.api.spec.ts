/**
 * API-AUTH-01, 02, 03, 06 — Who may call the API: no credentials, valid, tampered and forged bearers, a disabled user (ilm#426).
 *
 * core#2502: the refused-method row is wrong on the migrated build (test.fail there).
 * Skips: the refused-method row when the ingress answers before core; tampered bearers in header mode; the disabled-user
 * row without the second identity and one core replica; the anonymous reads on a header-mode stack without
 * REG_LOCAL_CORE_URL (anonymous calls go to the core's own port, where no proxy authenticates them).
 * A role an anonymous call manages to create is ledgered before the assertion.
 */
import { FEW_CALLS_TEST_MS, MANY_STEPS_TEST_MS, SEVERAL_STEPS_TEST_MS } from '../../../utils/regression/timeouts';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { INGRESS_SKIP_MESSAGE, checkRefusedMethod } from '../../../utils/regression/errorContract';
import { getBuildInfo, isMigratedBuild } from '../../../utils/regression/coreBuild';
import { expectHealthGroupUp, PROBE_PATHS } from '../../../utils/regression/platform/connectorApi';
import { anonymousTarget, callAs, callWithAuthorization, coreReplicas, isNotGrantableAction, leaksInternals, parseProfile, readProfile, replicaBlocker, restrictedIdentity } from '../../../utils/regression/rbac/identities';
import { ANONYMOUS_VARIANTS, buildVariant, claimOf, echoesToken, TOKEN_VARIANTS, TOKENLESS_VARIANTS, TokenVariant } from '../../../utils/regression/rbac/jwtTools';
import { usersOrRolesNamed } from '../../../utils/regression/listReads';
import { ownName } from '../../../utils/regression/ledger/runState';
import { restrictedRoleSwitch } from '../../../utils/regression/rbac/permissionObjects';
import { testMeta, tags } from '../../../utils/regression/tags';
import { answerOf } from '../../../utils/regression/apiReads';

/** The default listings every profile carries (core#1555: dashboard and approvals for every user; owner resources always). */
const DEFAULT_LISTINGS = ['dashboard', 'approvals', 'certificates', 'keys', 'secrets'];

test.describe('Authentication of API callers', { tag: tags.api }, () => {
    // ------------------------------------------------------------------ API-AUTH-01

    test('no credentials answer 401 on every protected read, and health and branding stay open',
        testMeta({
            id: 'API-AUTH-01', row: 'reads', prio: 'P1', issue: 'ilm#426',
            rule: [
                '401 means no or failed authentication; public without credentials: the health endpoints and GET branding; the credential state decides the status; ilm#426 step 2 ("no certificate → 401")',
                'a loopback caller with no credentials is the `localhost` system user: on a local stack the call is sent from a documentation-range address',
            ],
        }),
        async ({ request, env }, testInfo) => {
            test.setTimeout(SEVERAL_STEPS_TEST_MS);
            const target = anonymousTarget();
            test.skip(env.authMode === 'header' && !target.base, 'a header-mode stack without REG_LOCAL_CORE_URL: the dev proxy authenticates every /api call, so no anonymous request can be made through BASE_URL');
            testInfo.annotations.push({ type: 'anonymous-target', description: target.base ? 'local stack: the core\'s own port, X-Forwarded-For from the documentation range' : 'BASE_URL, no credentials' });
            const url = (path: string): string => `${target.base}${path}`;

            await test.step('Protected reads: 401 each, a body without internals', async () => {
                const probes: Array<{ what: string; send: () => Promise<{ status: number; text: string }> }> = [
                    ...['/api/v1/auth/profile', '/api/v1/users', '/api/v1/roles', '/api/v1/info'].map((path) => ({
                        what: `GET ${path}`,
                        send: async () => {
                            const res = await request.get(url(path), { headers: target.headers });
                            return { status: res.status(), text: await res.text() };
                        },
                    })),
                ];
                for (const p of probes) {
                    const answer = await p.send();
                    expect(answer.status, `${p.what}: ${answer.text.slice(0, 200)}`).toBe(401);
                    expect(leaksInternals(answer.text), `${p.what}: the 401 body`).toBeUndefined();
                }
            });

            await test.step('Controls: liveness and readiness answer 200 {"status":"UP"} without credentials; GET branding answers 200', async () => {
                for (const which of ['liveness', 'readiness'] as const) {
                    const started = Date.now();
                    const p = await answerOf(await request.get(url(PROBE_PATHS[which]), { headers: target.headers }), started);
                    expectHealthGroupUp(p, which);
                }
                const branding = await request.get(url('/api/v1/branding'), { headers: target.headers });
                expect(branding.status(), 'GET /api/v1/branding is open to everyone').toBe(200);
            });
        });

    test('create, update and delete calls without credentials answer 401 and leave nothing behind',
        testMeta({
            id: 'API-AUTH-01', row: 'mutations', prio: 'P1', issue: 'ilm#426',
            rule: [
                '401 comes before anything else, so DELETE of a random uuid answers 401, not 404',
                'the platform branding endpoint is on the guard\'s platform deny-list: its POST 401 control is not expressible on a shared tier and is left out',
                'calls sent: POST /v1/certificates (search), POST /v1/roles, PUT /v1/users/{uuid} and DELETE /v1/roles/{uuid}',
            ],
        }),
        async ({ api, anonymousApi, own }) => {
            test.setTimeout(SEVERAL_STEPS_TEST_MS);
            const name = ownName('anon-role');

            const created = await test.step('POST /v1/roles with a valid body and no credentials → 401', async () => {
                const started = Date.now();
                const answer = await answerOf(await anonymousApi.post('/api/v1/roles', { data: { name, description: 'API-AUTH-01 anonymous probe', customAttributes: [] } }), started);
                // Ledger before assertion: a role an anonymous caller managed to create is this run's object.
                own.probe('roles', answer, { name, note: 'role created without credentials (API-AUTH-01[mutations])' });
                expect(answer.status, answer.text.slice(0, 200)).toBe(401);
                expect(leaksInternals(answer.text)).toBeUndefined();
                return name;
            });

            await test.step('The search POST (POST /v1/certificates) → 401', async () => {
                const res = await anonymousApi.post('/api/v1/certificates', { data: { itemsPerPage: 1, pageNumber: 1, filters: [] } });
                expect(res.status(), (await res.text()).slice(0, 200)).toBe(401);
            });

            await test.step('PUT /v1/users/{random uuid} → 401 (before any 404) and DELETE /v1/roles/{random uuid} → 401', async () => {
                const put = await anonymousApi.put(`/api/v1/users/${anonymousApi.probeUuid()}`, { data: { groupUuids: [] } });
                expect(put.status(), (await put.text()).slice(0, 200)).toBe(401);
                const del = await anonymousApi.delete(`/api/v1/roles/${anonymousApi.probeUuid()}`);
                expect(del.status(), (await del.text()).slice(0, 200)).toBe(401);
            });

            await test.step('Nothing behind it: the admin list holds no role of that name', async () => {
                expect(await usersOrRolesNamed(api, 'roles', created)).toEqual([]);
            });
        });

    // ------------------------------------------------------------------ API-AUTH-02

    test('a valid identity gets its profile: JSON, its own name, the default listings, no ANY / NONE',
        testMeta({
            id: 'API-AUTH-02', row: 'profile', prio: 'P1', issue: 'ilm#426',
            rule: [
                'valid bearer, user exists and enabled → profile 200; allowedListings always holds dashboard and approvals, plus the owner resources; allowedActions reports resource-level grants only and never ANY / NONE); core#1555, core#2183',
                'ilm#426 step 7 (bearer token → 200); the response-time budget (3 s) is a soft assertion',
            ],
        }),
        async ({ api, env }, testInfo) => {
            test.setTimeout(SEVERAL_STEPS_TEST_MS);
            const started = Date.now();
            const res = await api.get('/api/v1/auth/profile');
            const elapsed = Date.now() - started;
            const text = await res.text();

            expect(res.status(), text.slice(0, 300)).toBe(200);
            expect(res.headers()['content-type'] ?? '').toMatch(/^application\/json/);
            const profile = parseProfile(JSON.parse(text));
            if (env.authMode === 'header') {
                testInfo.annotations.push({ type: 'local-stack', description: 'header mode: the identity is the dev proxy\'s certificate user, not env.username (not compared)' });
            } else {
                expect(profile.username.toLowerCase(), 'the profile names the signed-in user').toBe(env.username.trim().toLowerCase());
            }
            expect(profile.enabled, 'the signed-in user is enabled').toBe(true);
            for (const listing of DEFAULT_LISTINGS) expect(profile.allowedListings, `allowedListings holds ${listing}`).toContain(listing);
            const notGrantable = profile.allowedActions.flatMap((a) => a.actions.map((x) => `${a.resource}:${x}`)).filter((x) => isNotGrantableAction(x.split(':')[1]));
            expect(notGrantable, 'allowedActions never reports ANY / NONE').toEqual([]);
            expect.soft(elapsed, 'the profile answers within 3 s').toBeLessThan(3000);
        });

    test('the profile\'s username equals the username claim decoded from the bearer token',
        testMeta({ id: 'API-AUTH-02', row: 'claim', prio: 'P1', issue: 'ilm#426', needs: 'bearer-token', rule: ['the username claim is the identity; ilm#426 step 7 — the claim is decoded WITHOUT verification: it only proves the profile belongs to the token'] }),
        async ({ api, adminToken }) => {
            const profile = await readProfile(api);
            expect(String(claimOf(adminToken!.bearer(), 'username')).toLowerCase()).toBe(profile.username.toLowerCase());
        });

    test('a refused HTTP method with valid credentials answers 400 on the main build',
        testMeta({
            id: 'API-AUTH-02', row: 'method', prio: 'P1', issue: 'ilm#426', bug: 'core#2502',
            rule: [
                'TRACE or any method outside the firewall allow list: 400 baseline, 401 migrated (core#2502, open); ilm#424 "status codes stay the same"',
                'the credential state decides the status; only meaningful where the ingress lets the method reach core (otherwise the test skips)',
                'core#2502: the migrated build answers 401 to a refused method',
            ],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(FEW_CALLS_TEST_MS);
            const build = await getBuildInfo(api);
            testInfo.annotations.push({ type: 'build', description: `core ${build.version ?? '?'} branch ${build.branch ?? '?'}` });
            const migrated = await isMigratedBuild(api, testInfo);
            const res = await api.fetch('/api/v1/auth/profile', { method: 'TRACE' });
            // Whose answer is it (as in API-GEN-32[method])? An ingress that refuses TRACE before core (405, a proxy `Server`
            // header, a non-JSON body) says nothing about core: skip with the named reason. The body is never printed (a proxy could
            // echo the bearer); the verdict's problems and the skip detail are status codes, byte counts and a proxy name only.
            const verdict = checkRefusedMethod({ status: res.status(), headers: res.headers(), bodyText: await res.text() });
            if (verdict.outcome === 'skip') {
                testInfo.annotations.push({ type: 'ingress-answer', description: verdict.why });
                test.skip(true, INGRESS_SKIP_MESSAGE);
                return;
            }
            // The known bug only on the migrated build (the build marker from /v1/info; REG_BUILD overrides it): core answers 401 there.
            test.fail(migrated, 'core#2502: the migrated build answers 401 to a refused method');
            expect(verdict.problems, 'a refused method with valid credentials answers 400 with an empty body (core, not the ingress)').toEqual([]);
        });

    // ------------------------------------------------------------------ API-AUTH-03

    for (const variant of TOKENLESS_VARIANTS) {
        test(`a bearer built from nothing (${variant}) is refused with 401 between two controls`,
            testMeta({
                id: 'API-AUTH-03', row: variant, prio: 'P1', issue: 'ilm#426', needs: 'bearer-token',
                rule: [
                    'the provider is chosen by iss; validators: issuer, timestamp, audience; refusal texts "Token is not an instance of Signed JWT.", "Issuer URI is not present in JWT.", "No OAuth2 Provider with issuer URI … configured"; each answers 401; ilm#426 step 8',
                    'each variant runs between two controls with the untouched token (200 before and after), so a 401 cannot come from a bad base token',
                ],
            }),
            async ({ api, env }) => {
                test.setTimeout(SEVERAL_STEPS_TEST_MS);
                test.skip(env.authMode === 'header', `AUTH_MODE=header: the certificate header wins over any bearer (the certificate header is checked first); a bearer needs a Keycloak in the local compose (@needs:keycloak-local)`);
                const me = await test.step('Control before: the context\'s own token answers 200', async () => readProfile(api));
                const req = buildVariant(variant, { username: me.username });
                await test.step(`The ${variant} token (${req.why}) → 401, no echo, no internals`, async () => {
                    const res = await callWithAuthorization(api, req.authorization, 'GET', '/api/v1/auth/profile');
                    expect(res.status, `${variant}: ${res.text.slice(0, 200)}`).toBe(401);
                    expect(leaksInternals(res.text), `${variant}: the 401 body`).toBeUndefined();
                    expect(echoesToken(res.text, req.authorization?.split(' ')[1]), `${variant}: the refusal does not echo the token`).toBe(false);
                });
                await test.step('Control after: the context\'s own token still answers 200', async () => {
                    expect((await readProfile(api)).username).toBe(me.username);
                });
            });
    }

    for (const variant of [...TOKEN_VARIANTS, ...ANONYMOUS_VARIANTS] as TokenVariant[]) {
        test(`the valid token altered (${variant}) is refused with 401 between two controls`,
            testMeta({
                id: 'API-AUTH-03', row: variant, prio: 'P1', issue: 'ilm#426',
                rule: [
                    'one character of the signature or payload changed → 401, each with its own audit failure; ilm#426 step 8 ("bearer token 200, one character changed 401")',
                    'the FIRST signature character is changed (the last base64url character of an RS256 signature has four padding bits: another character can decode to the identical bytes and the token would stay valid)',
                ],
            }),
            async ({ api, anonymousApi, adminToken }) => {
                test.setTimeout(SEVERAL_STEPS_TEST_MS);
                const me = await readProfile(api);
                const req = buildVariant(variant, { username: me.username, validToken: adminToken?.bearer() });
                const res = variant === 'query-only'
                    ? await callWithAuthorization(anonymousApi, undefined, 'GET', '/api/v1/auth/profile', { params: req.query })
                    : await callWithAuthorization(api, req.authorization, 'GET', '/api/v1/auth/profile');
                expect(res.status, `${variant}: ${res.text.slice(0, 200)}`).toBe(401);
                expect(leaksInternals(res.text)).toBeUndefined();
                expect(echoesToken(res.text, adminToken!.bearer())).toBe(false);
                expect((await readProfile(api)).username, 'control after: the untouched token still answers 200').toBe(me.username);
            });
    }

    // ------------------------------------------------------------------ API-AUTH-06

    test('a disabled user\'s token is refused on the next request, and re-enabling restores it',
        testMeta({
            id: 'API-AUTH-06', prio: 'P1', issue: 'ilm#426', needs: 'second-identity',
            rule: [
                'a disabled user is refused for every method: 401, "User \'<name>\' is disabled"; disable evicts the user\'s authentication cache entries; failed authentications are never cached; enable needs no cache action; ilm#426 step 10',
                'one core replica (REG_CORE_REPLICAS) — with more, the token stays valid for the cache TTL on the other instances',
            ],
        }),
        async ({ api, env, own, restrictedToken }) => {
            test.setTimeout(MANY_STEPS_TEST_MS);
            const blocker = replicaBlocker();
            test.skip(!!blocker, blocker);
            test.skip(restrictedToken === undefined, `no bearer token for the second identity on AUTH_MODE=${env.authMode}`);
            const dedicatedUser = restrictedIdentity()!;
            const user = await test.step('The dedicated ILM user (created by this run; the identity-provider account is provisioned outside the suite)', async () => own.restrictedUser());
            const sw = restrictedRoleSwitch(api, user, restrictedToken!.bearer());

            const tampered = await test.step('Reference: a tampered token\'s 401 (the shape a disabled user must share)', async () => {
                const me = await callAs(api, restrictedToken!.bearer(), 'GET', '/api/v1/auth/profile');
                expect(me.status, 'the second identity\'s token works before the change').toBe(200);
                const req = buildVariant('signature', { username: dedicatedUser.username, validToken: restrictedToken?.bearer() });
                return callWithAuthorization(api, req.authorization, 'GET', '/api/v1/auth/profile');
            });

            try {
                await test.step('Admin disables the second identity → the SAME token is refused at once with 401, and the body does not say "disabled"', async () => {
                    expect((await sw.setEnabled(false)).status).toBe(200);
                    const res = await callAs(api, restrictedToken!.bearer(), 'GET', '/api/v1/auth/profile');
                    expect(res.status, res.text.slice(0, 200)).toBe(401);
                    expect(res.text.toLowerCase(), 'no enumeration: the refusal does not name the cause').not.toContain('disabled');
                    expect(res.contentType, 'same shape as the tampered-token 401').toBe(tampered.contentType);
                });
                await test.step('Admin enables the second identity → the same token answers 200 again (a failed authentication is never cached)', async () => {
                    expect((await sw.setEnabled(true)).status).toBe(200);
                    expect((await callAs(api, restrictedToken!.bearer(), 'GET', '/api/v1/auth/profile')).status).toBe(200);
                });
            } finally {
                await sw.setEnabled(true); // state repair: the dedicated user is left enabled
            }
            expect(coreReplicas()).toBe(1);
        });
});
