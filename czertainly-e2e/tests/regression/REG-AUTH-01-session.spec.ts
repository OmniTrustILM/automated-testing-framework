/**
 * REG-AUTH-01 — sign-in and the session (auth-rbac area, ilm#426 steps 1–5, 9; Boot 4 risk: the session store).
 *
 * Rows: REG-AUTH-01 (sign-in per auth mode reaches the dashboard as the test user and sets the session cookie), REG-AUTH-02
 * (the session holds across navigation, reloads and a second tab: the Boot 4 symptom was a NEW session on every request),
 * REG-AUTH-05 (the session survives a core restart; `@local @needs:keycloak-local`), REG-AUTH-07 (a disabled user's live
 * browser session is refused, re-enabling restores access; needs the second identity). REG-AUTH-03 (sign-out) ends the shared
 * admin's identity-provider session and therefore lives in its own file that sorts last: REG-AUTH-99-logout.spec.ts (phase-06 m1).
 *
 * Two auth modes: `AUTH_MODE=local` (shared tiers and any stack with a Keycloak: a browser sign-in, a `session-id` cookie) and
 * `AUTH_MODE=header` (a local development stack: the dev proxy authenticates every request with the admin certificate, there is
 * no browser session and no cookie). The shared-tier variants skip in header mode with that reason; the header variant of
 * REG-AUTH-01 runs under `describeLocal`.
 *
 * Shape of the profile (`GET /api/v1/auth/profile`): `UserProfileDetailDto`, top-level `username` (identities.ts `parseProfile`);
 * the ledger text "user.username" predates that read of the code.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { AccessPage } from '../../pages/AccessPage';
import { LoginPage } from '../../pages/LoginPage';
import { deleteOwn } from '../../utils/regression/authApi';
import { keycloakLocalBlocker, parseProfile, readProfile, replicaBlocker, restrictedIdentity, secondIdentityBlocker } from '../../utils/regression/identities';
import { ensureRestrictedUser, ensureRestrictedUserOrSkip, setRestrictedEnabled } from '../../utils/regression/rbacData';
import { restartCore } from '../../utils/regression/platformStack';
import { describeLocal } from '../../utils/regression/tier';
import { requireTool } from '../../utils/regression/tools';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-AUTH-01';

/** The pages REG-AUTH-02 walks (plan: Dashboard, Certificates, RA Profiles, Roles, Users; hash routes of the admin UI). */
const ROUTES: ReadonlyArray<readonly [string, string]> = [
    ['Dashboard', 'dashboard'], ['Certificates', 'certificates'], ['RA Profiles', 'raprofiles'], ['Roles', 'roles'], ['Users', 'users'],
];

test.describe('REG-AUTH sign-in and session', { tag: tags.regression }, () => {
    test('REG-AUTH-01[session]: sign-in reaches the dashboard as the test user, the profile names that user, the session cookie is set',
        meta({
            id: 'REG-AUTH-01', prio: 'P1', issue: 'ilm#426',
            rule: [
                'auth-rbac B1 (browser sign-in is an OAuth2 login; the session lives in spring_session, cookie `session-id`, path `/`); AR-101, AR-130; ilm#426 steps 1 and 3 (dashboard as the test user)',
                'the profile is UserProfileDetailDto: `username` at the top level (core AuthServiceImpl.getAuthProfile)',
            ],
        }),
        async ({ page, api, env }) => {
            test.setTimeout(90_000);
            test.skip(env.authMode !== 'local', `AUTH_MODE=${env.authMode}: no identity-provider sign-in and no session cookie (the header-mode variant is REG-AUTH-01[header], @local)`);
            const me = await test.step('The token user, from the API (the identity the suite signs in as)', async () => readProfile(api));
            const login = new LoginPage(page, env);
            const access = new AccessPage(page);

            await test.step('Sign in → the dashboard shell is shown and the user menu shows the username', async () => {
                await loginAsSmokeUser(page, env);
                await login.assertSignedInAs(me.username);
            });

            await test.step('The page context\'s profile answers 200 for that user', async () => {
                const res = await page.request.get('/api/v1/auth/profile');
                expect(res.status(), (await res.text()).slice(0, 200)).toBe(200);
                expect(parseProfile(await res.json()).username).toBe(me.username);
            });

            await test.step('The session cookie `session-id` is set, path /', async () => {
                const cookie = await access.sessionCookie();
                expect(cookie, 'a session-id cookie').toBeDefined();
                expect(cookie!.path).toBe('/');
                expect(cookie!.value.length, 'a non-empty session id').toBeGreaterThan(0);
            });
        });

    test('REG-AUTH-02: the session holds across navigation, reloads and a second tab — no 401 / 403, one session cookie throughout',
        meta({
            id: 'REG-AUTH-02', prio: 'P1', issue: 'ilm#426',
            rule: [
                'auth-rbac B1 / B2 (every request on a session is revalidated; the session lives in the database); ilm#426 step 4 and its context ("Boot 4 dropped the session filter until core restored spring-boot-session; without it every request starts a new session, and an OIDC sign-in is lost at once"); AR-131',
            ],
        }),
        async ({ page, env }) => {
            test.setTimeout(180_000);
            test.skip(env.authMode !== 'local', `AUTH_MODE=${env.authMode}: no browser session to keep (header-mode stacks authenticate every request with the certificate header)`);
            const access = new AccessPage(page);
            await test.step('Sign in', async () => loginAsSmokeUser(page, env));
            const watch = access.watchApi();
            const first = await test.step('The session cookie after sign-in', async () => {
                const cookie = await access.sessionCookie();
                expect(cookie, 'a session-id cookie after sign-in').toBeDefined();
                return cookie!.value;
            });

            for (const [label, route] of ROUTES) {
                await test.step(`${label}: open, then reload — still signed in, same session`, async () => {
                    await access.visit(route);
                    await access.settle();
                    await access.assertNoLoginForm();
                    expect((await access.sessionCookie())?.value, `${label}: the session cookie did not change`).toBe(first);
                    await access.reload();
                    await access.settle();
                    await access.assertNoLoginForm();
                    expect((await access.sessionCookie())?.value, `${label} after the reload: the session cookie did not change`).toBe(first);
                });
            }

            await test.step('A second tab in the same context is signed in with the same session', async () => {
                const tab = await page.context().newPage();
                try {
                    const second = new AccessPage(tab);
                    const tabWatch = second.watchApi();
                    await tab.goto('administrator/');
                    await expect(second.shell, 'the second tab is signed in').toBeVisible({ timeout: 30_000 });
                    await second.settle();
                    await second.assertNoLoginForm();
                    expect((await second.sessionCookie())?.value, 'the session cookie is the same in the second tab').toBe(first);
                    expect(tabWatch.refusals(), 'no 401 / 403 in the second tab').toEqual([]);
                    tabWatch.stop();
                } finally {
                    await tab.close();
                }
            });

            await test.step('Not one /api response was a 401 or 403', async () => {
                expect(watch.refusals(), 'refusals during the walk').toEqual([]);
                expect(watch.answers().length, 'the walk made API calls').toBeGreaterThan(0);
                watch.stop();
            });
        });

    test('REG-AUTH-07: a disabled user\'s live browser session is refused, re-enabling restores access (needs the second identity)',
        meta({
            id: 'REG-AUTH-07', prio: 'P1', issue: 'ilm#426', needs: 'second-identity',
            rule: [
                'auth-rbac A9 (a disabled user is refused for every method), B4 (disable deletes the user\'s sessions and evicts the caches: core#1132), C5; ilm#426 step 9 / T2.6; AR-140, AR-145',
                'plan §0: one core replica; "L-disable": the target uuid differs from the admin\'s own (asserted by the helper)',
            ],
        }),
        async ({ api, browser, env }) => {
            test.setTimeout(240_000);
            test.skip(env.authMode !== 'local', `AUTH_MODE=${env.authMode}: no identity-provider sign-in`);
            const blocker = secondIdentityBlocker(env.username) ?? replicaBlocker();
            test.skip(!!blocker, blocker);
            const ded = restrictedIdentity()!;
            const user = await test.step('The dedicated ILM user (created by this run)', async () => ensureRestrictedUserOrSkip(api, SPEC, ded, (reason) => test.skip(true, reason)));

            const context = await browser.newContext({ baseURL: env.baseUrl, ignoreHTTPSErrors: true });
            try {
                const page = await context.newPage();
                const login = new LoginPage(page, env);
                const access = new AccessPage(page);
                await test.step('DED signs in (its own browser context) → the dashboard', async () => {
                    await login.loginAs(ded);
                    await expect(access.shell).toBeVisible();
                });
                try {
                    await test.step('Admin disables DED → its next navigation shows the sign-in, its cookie\'s profile is 401', async () => {
                        expect((await setRestrictedEnabled(api, user, false)).status).toBe(200);
                        await page.reload();
                        await login.assertLoggedOut();
                        const res = await page.request.get('/api/v1/auth/profile');
                        expect(res.status()).toBe(401);
                    });
                    await test.step('Admin enables DED → DED signs in again to the dashboard', async () => {
                        expect((await setRestrictedEnabled(api, user, true)).status).toBe(200);
                        await login.loginAs(ded);
                        await expect(access.shell).toBeVisible();
                    });
                } finally {
                    await setRestrictedEnabled(api, user, true); // state repair: DED is left enabled (Rst)
                }
            } finally {
                await context.close();
            }
        });
});

test.describe('REG-AUTH local stack', { tag: tags.regression }, () => {
    describeLocal(test);

    test('REG-AUTH-01[header]: a header-mode stack reaches the dashboard as the dev proxy\'s admin; the profile answers 200',
        meta({
            id: 'REG-AUTH-01', prio: 'P1', issue: 'ilm#426', local: true,
            rule: ['auth-rbac A1 / A2 (certificate header identification: the dev proxy sends the admin certificate on /api); AR-101; ilm#426 step 1 (dashboard through the proxy that sends the admin certificate)'],
        }),
        async ({ page, api, env }, testInfo) => {
            test.setTimeout(90_000);
            test.skip(env.authMode !== 'header', `AUTH_MODE=${env.authMode}: this variant is for a header-mode stack`);
            const me = await readProfile(api);
            await test.step('Open the app → the shell is shown (the proxy authenticates)', async () => {
                await loginAsSmokeUser(page, env);
                await expect(new AccessPage(page).shell).toBeVisible();
            });
            await test.step('The page context\'s profile answers 200 for the same user as the API', async () => {
                const res = await page.request.get('/api/v1/auth/profile');
                expect(res.status(), (await res.text()).slice(0, 200)).toBe(200);
                expect(parseProfile(await res.json()).username).toBe(me.username);
            });
            const cookie = await new AccessPage(page).sessionCookie();
            testInfo.annotations.push({ type: 'local-stack', description: `session cookie ${cookie ? 'present' : 'absent'} (not asserted in header mode)` });
        });

    test('REG-AUTH-05: the session survives a core restart — the same cookie answers the same profile, no login form',
        meta({
            id: 'REG-AUTH-05', prio: 'P1', issue: 'ilm#426', local: true, needs: 'keycloak-local',
            rule: [
                'auth-rbac B1 (spring_session table, `spring-boot-session` restored on Boot 4); ilm#426 step 3 ("docker compose restart core, then reload → signed in as on the baseline (the session lives in the database)"); core bb20aaba; AR-132',
                'blocked until the local compose has a Keycloak (decision D3, development-environment overlay): the skip names it, never a pass',
            ],
        }),
        async ({ page, request, env }) => {
            test.setTimeout(420_000);
            const blocker = keycloakLocalBlocker(env.authMode);
            test.skip(!!blocker, blocker);
            const tool = requireTool('docker');
            test.skip(!!tool, tool);
            const access = new AccessPage(page);

            const before = await test.step('Sign in; profile 200; remember the cookie and the profile', async () => {
                await loginAsSmokeUser(page, env);
                const cookie = await access.sessionCookie();
                expect(cookie, 'a session-id cookie').toBeDefined();
                const res = await page.request.get('/api/v1/auth/profile');
                expect(res.status()).toBe(200);
                return { cookie: cookie!.value, profile: parseProfile(await res.json()) };
            });

            await test.step('docker compose restart core, then wait for readiness {"status":"UP"}', async () => {
                restartCore();
                await expect
                    .poll(async () => {
                        const res = await request.get('/api/v1/health/readiness').catch(() => undefined);
                        return res?.status() === 200 ? JSON.stringify(await res.json()) : 'not ready';
                    }, { timeout: 300_000, intervals: [3_000], message: 'core is ready again after the restart' })
                    .toBe('{"status":"UP"}');
            });

            await test.step('Reload: still signed in, no login form; the same cookie gives an identical profile', async () => {
                await access.reload();
                await access.assertNoLoginForm();
                expect((await access.sessionCookie())?.value, 'the session cookie is unchanged').toBe(before.cookie);
                const res = await page.request.get('/api/v1/auth/profile');
                expect(res.status()).toBe(200);
                expect(parseProfile(await res.json())).toEqual(before.profile);
            });
        });

    test('REG-AUTH-07[delete]: a deleted user\'s live browser session is refused; the ILM user is re-created (needs keycloak-local and the second identity)',
        meta({
            id: 'REG-AUTH-07', prio: 'P1', issue: 'ilm#426', local: true, needs: ['second-identity', 'keycloak-local'],
            rule: ['auth-rbac B4, C6 (delete ends sessions and clears the certificate link), A8 (the identity is the username: the IdP account stays, the ILM user is re-created); AR-145 — LOCAL only (deletes the dedicated ILM user)'],
        }),
        async ({ api, browser, env }) => {
            test.setTimeout(240_000);
            const blocker = keycloakLocalBlocker(env.authMode) ?? secondIdentityBlocker(env.username) ?? replicaBlocker();
            test.skip(!!blocker, blocker);
            const ded = restrictedIdentity()!;
            const user = await ensureRestrictedUserOrSkip(api, SPEC, ded, (reason) => test.skip(true, reason));
            const context = await browser.newContext({ baseURL: env.baseUrl, ignoreHTTPSErrors: true });
            try {
                const page = await context.newPage();
                const login = new LoginPage(page, env);
                await login.loginAs(ded);
                await expect(new AccessPage(page).shell).toBeVisible();
                const status = await deleteOwn(api, 'users', user, SPEC, 'deleted by REG-AUTH-07[delete] (the behaviour under test); re-created below');
                expect(status, 'delete the dedicated ILM user').toBe(204);
                await page.reload();
                await login.assertLoggedOut();
                expect((await page.request.get('/api/v1/auth/profile')).status()).toBe(401);
            } finally {
                await context.close();
                await ensureRestrictedUser(api, SPEC, ded); // the ILM user is re-created (ensureRestrictedUser)
            }
        });
});
