/**
 * REG-AUTH-01, REG-AUTH-02, REG-AUTH-05, REG-AUTH-07 — Sign-in and the session (release checklist: sign-in). ilm#426.
 *
 * WHAT: 1. Sign in (REG-AUTH-01) → the dashboard shows the test user, the profile answers 200 for that user, the session cookie is set.
 *       2. Header mode (REG-AUTH-01, row header, local stack) → the proxy's admin reaches the dashboard and the profile answers 200.
 *       3. Navigation, reload and a second tab (REG-AUTH-02) → still signed in, one session cookie, no 401 or 403.
 *       4. Core restart (REG-AUTH-05, local stack) → same cookie, same profile, no login form.
 *       5. A disabled user's live browser session (REG-AUTH-07) → refused (login form, profile 401); enabling restores access.
 *       6. A deleted user's live browser session (REG-AUTH-07, row delete, local stack) → refused; the ILM user is re-created.
 * WHY: the session must live in the database and be revalidated on every request (the Spring Boot 4 symptom was a new
 *      session on every request, which loses an OIDC sign-in at once); disable and delete must end live sessions. A red test
 *      means sessions no longer hold or no longer die.
 * HOW: AUTH_MODE=local runs on shared tiers and any stack with a Keycloak; AUTH_MODE=header (dev proxy, no browser session,
 *      no cookie) skips those tests with the mode in the reason and has its own local variant. The disabled and deleted
 *      users are the dedicated second identity (a user this run created, checked before it is changed; skipped with a named
 *      reason until the account exists); a deleted user is re-created in the finally block. The core restart needs docker
 *      and a local Keycloak. Sign-out is in 99-sign-out.spec.ts, which sorts last.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { AppShell } from '../../../pages/AppShell';
import { LoginPage } from '../../../pages/LoginPage';
import { deleteOwnUserOrRole } from '../../../utils/regression/rbac/authApi';
import { keycloakLocalBlocker, parseProfile, readProfile, replicaBlocker, restrictedIdentity } from '../../../utils/regression/rbac/identities';
import { ensureRestrictedUser, setRestrictedEnabled } from '../../../utils/regression/rbac/permissionObjects';
import { restartCore } from '../../../utils/regression/platform/localStack';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { testMeta, tags } from '../../../utils/regression/tags';
import { SIGN_IN_TEST_MS, SESSION_WALK_TEST_MS, SESSION_CHANGE_TEST_MS, CORE_RESTART_TEST_MS, SHELL_VISIBLE_MS, CORE_READY_AFTER_RESTART_MS, READINESS_POLL_INTERVAL_MS } from '../../../utils/regression/timeouts';

/** The pages REG-AUTH-02 walks (Dashboard, Certificates, RA Profiles, Roles, Users; hash routes of the admin UI). */
const ROUTES: ReadonlyArray<readonly [string, string]> = [
    ['Dashboard', 'dashboard'], ['Certificates', 'certificates'], ['RA Profiles', 'raprofiles'], ['Roles', 'roles'], ['Users', 'users'],
];

test.describe('Sign-in and session', { tag: tags.regression }, () => {
    test('sign-in reaches the dashboard, the profile names the test user, the session cookie is set',
        testMeta({
            id: 'REG-AUTH-01', row: 'session', prio: 'P2', issue: 'ilm#426',
            rule: [
                'browser sign-in is an OAuth2 login; the session lives in spring_session, cookie `session-id`, path `/`; ilm#426 steps 1 and 3 (dashboard as the test user)',
                'the profile is UserProfileDetailDto: `username` at the top level (core AuthServiceImpl.getAuthProfile)',
            ],
        }),
        async ({ page, api, env }) => {
            test.setTimeout(SIGN_IN_TEST_MS);
            test.skip(env.authMode !== 'local', `AUTH_MODE=${env.authMode}: no identity-provider sign-in and no session cookie (the header-mode variant is REG-AUTH-01[header], @local)`);
            const me = await test.step('The token user, from the API (the identity the suite signs in as)', async () => readProfile(api));
            const login = new LoginPage(page, env);
            const access = new AppShell(page);

            await test.step('Sign in → the dashboard shell is shown and the user menu shows the username', async () => {
                await login.signIn();
                await login.assertSignedInAs(me.username);
            });

            await test.step('The page context\'s profile answers 200 for that user', async () => {
                const res = await page.request.get('/api/v1/auth/profile');
                expect(res.status(), (await res.text()).slice(0, 200)).toBe(200);
                expect(parseProfile(await res.json()).username).toBe(me.username);
            });

            await test.step('The session cookie `session-id` is set, path /', async () => {
                const cookie = await LoginPage.readSessionCookie(page);
                expect(cookie, 'a session-id cookie').toBeDefined();
                expect(cookie!.path).toBe('/');
                expect(cookie!.value.length, 'a non-empty session id').toBeGreaterThan(0);
            });
        });

    test('the session holds across navigation, reloads and a second tab with one session cookie',
        testMeta({
            id: 'REG-AUTH-02', prio: 'P2', issue: 'ilm#426',
            rule: [
                'every request on a session is revalidated; the session lives in the database; ilm#426 step 4 and its context ("Boot 4 dropped the session filter until core restored spring-boot-session; without it every request starts a new session, and an OIDC sign-in is lost at once")',
            ],
        }),
        async ({ signedIn: page, env }) => {
            test.setTimeout(SESSION_WALK_TEST_MS);
            test.skip(env.authMode !== 'local', `AUTH_MODE=${env.authMode}: no browser session to keep (header-mode stacks authenticate every request with the certificate header)`);
            const access = new AppShell(page);
            const watch = access.watchApi();
            const first = await test.step('The session cookie after sign-in', async () => {
                const cookie = await LoginPage.readSessionCookie(page);
                expect(cookie, 'a session-id cookie after sign-in').toBeDefined();
                return cookie!.value;
            });

            for (const [label, route] of ROUTES) {
                await test.step(`${label}: open, then reload — still signed in, same session`, async () => {
                    await access.loadingData(watch, () => access.goTo(route));
                    await access.assertNoLoginForm();
                    expect((await LoginPage.readSessionCookie(page))?.value, `${label}: the session cookie did not change`).toBe(first);
                    await access.loadingData(watch, () => access.reload());
                    await access.assertNoLoginForm();
                    expect((await LoginPage.readSessionCookie(page))?.value, `${label} after the reload: the session cookie did not change`).toBe(first);
                });
            }

            await test.step('A second tab in the same context is signed in with the same session', async () => {
                const tab = await page.context().newPage();
                try {
                    const second = new AppShell(tab);
                    const tabWatch = second.watchApi();
                    await second.loadingData(tabWatch, async () => {
                        await tab.goto('administrator/');
                        await expect(second.shell, 'the second tab is signed in').toBeVisible({ timeout: SHELL_VISIBLE_MS });
                    });
                    await second.assertNoLoginForm();
                    expect((await LoginPage.readSessionCookie(tab))?.value, 'the session cookie is the same in the second tab').toBe(first);
                    expect(tabWatch.dataAnswers().length, 'the second tab loaded authenticated API data').toBeGreaterThan(0);
                    expect(tabWatch.refusals(), 'no 401 / 403 in the second tab').toEqual([]);
                    tabWatch.stop();
                } finally {
                    await tab.close();
                }
            });

            await test.step('Not one /api response was a 401 or 403', async () => {
                expect(watch.dataAnswers().length, 'the walk loaded authenticated API data').toBeGreaterThan(0);
                expect(watch.refusals(), 'refusals during the walk').toEqual([]);
                watch.stop();
            });
        });

    test('a disabled user\'s live browser session is refused, re-enabling restores access',
        testMeta({
            id: 'REG-AUTH-07', prio: 'P2', issue: 'ilm#426', needs: 'second-identity',
            rule: [
                'a disabled user is refused for every method; disable deletes the user\'s sessions and evicts the caches (core#1132); ilm#426 step 9',
                'one core replica; the disabled user is a dedicated one: the target uuid differs from the admin\'s own (asserted by the helper)',
            ],
        }),
        async ({ api, own, browser, env }) => {
            test.setTimeout(SESSION_CHANGE_TEST_MS);
            test.skip(env.authMode !== 'local', `AUTH_MODE=${env.authMode}: no identity-provider sign-in`);
            const blocker = replicaBlocker();
            test.skip(!!blocker, blocker);
            const dedicatedUser = restrictedIdentity()!;
            const user = await test.step('The dedicated ILM user (created by this run)', async () => own.restrictedUser());

            const context = await browser.newContext({ baseURL: env.baseUrl, ignoreHTTPSErrors: true });
            try {
                const page = await context.newPage();
                const login = new LoginPage(page, env);
                const access = new AppShell(page);
                await test.step('The dedicated user signs in (its own browser context) → the dashboard', async () => {
                    await login.loginAs(dedicatedUser);
                    await expect(access.shell).toBeVisible();
                });
                try {
                    await test.step('Admin disables the dedicated user → its next navigation shows the sign-in, its cookie\'s profile is 401', async () => {
                        expect((await setRestrictedEnabled(api, user, false)).status).toBe(200);
                        await page.reload();
                        await login.assertLoggedOut();
                        const res = await page.request.get('/api/v1/auth/profile');
                        expect(res.status()).toBe(401);
                    });
                    await test.step('Admin enables the dedicated user → it signs in again to the dashboard', async () => {
                        expect((await setRestrictedEnabled(api, user, true)).status).toBe(200);
                        await login.loginAs(dedicatedUser);
                        await expect(access.shell).toBeVisible();
                    });
                } finally {
                    await setRestrictedEnabled(api, user, true); // state repair: the dedicated user is left enabled (the restricted user must not stay disabled)
                }
            } finally {
                await context.close();
            }
        });
});

test.describe('Header-mode sign-in, core restart and deleted user on a local stack', { tag: tags.regression }, () => {
    describeLocalOnly(test);

    test('a header-mode stack reaches the dashboard as the proxy\'s admin and the profile answers 200',
        testMeta({
            id: 'REG-AUTH-01', row: 'header', prio: 'P2', issue: 'ilm#426', local: true,
            rule: ['certificate header identification: the dev proxy sends the admin certificate on /api; ilm#426 step 1 (dashboard through the proxy that sends the admin certificate)'],
        }),
        async ({ page, api, env }, testInfo) => {
            test.setTimeout(SIGN_IN_TEST_MS);
            test.skip(env.authMode !== 'header', `AUTH_MODE=${env.authMode}: this variant is for a header-mode stack`);
            const me = await readProfile(api);
            await test.step('Open the app → the shell is shown (the proxy authenticates)', async () => {
                await new LoginPage(page, env).signIn();
                await expect(new AppShell(page).shell).toBeVisible();
            });
            await test.step('The page context\'s profile answers 200 for the same user as the API', async () => {
                const res = await page.request.get('/api/v1/auth/profile');
                expect(res.status(), (await res.text()).slice(0, 200)).toBe(200);
                expect(parseProfile(await res.json()).username).toBe(me.username);
            });
            const cookie = await LoginPage.readSessionCookie(page);
            testInfo.annotations.push({ type: 'local-stack', description: `session cookie ${cookie ? 'present' : 'absent'} (not asserted in header mode)` });
        });

    test('the session survives a core restart: same cookie, same profile, no login form',
        testMeta({
            id: 'REG-AUTH-05', prio: 'P2', issue: 'ilm#426', local: true, needs: ['keycloak-local', 'docker'],
            rule: [
                'spring_session table, `spring-boot-session` restored on Boot 4; ilm#426 step 3 ("docker compose restart core, then reload → signed in as on the baseline (the session lives in the database)")',
                'blocked until the local compose has a Keycloak (development-environment overlay): the skip names it, never a pass',
            ],
        }),
        async ({ signedIn: page, request, env }) => {
            test.setTimeout(CORE_RESTART_TEST_MS);
            // The row declares the need; the explicit call stays because the rule over the specs asks every Keycloak row to call its
            // preflight.
            const blocker = keycloakLocalBlocker(env.authMode);
            test.skip(!!blocker, blocker);
            const access = new AppShell(page);

            const before = await test.step('Profile 200; remember the cookie and the profile', async () => {
                const cookie = await LoginPage.readSessionCookie(page);
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
                    }, { timeout: CORE_READY_AFTER_RESTART_MS, intervals: [READINESS_POLL_INTERVAL_MS], message: 'core is ready again after the restart' })
                    .toBe('{"status":"UP"}');
            });

            await test.step('Reload: still signed in, no login form; the same cookie gives an identical profile', async () => {
                await access.reload();
                await access.assertNoLoginForm();
                expect((await LoginPage.readSessionCookie(page))?.value, 'the session cookie is unchanged').toBe(before.cookie);
                const res = await page.request.get('/api/v1/auth/profile');
                expect(res.status()).toBe(200);
                expect(parseProfile(await res.json())).toEqual(before.profile);
            });
        });

    test('a deleted user\'s live browser session is refused and the ILM user is re-created',
        testMeta({
            id: 'REG-AUTH-07', row: 'delete', prio: 'P2', issue: 'ilm#426', local: true, needs: ['second-identity', 'keycloak-local'],
            rule: ['delete ends sessions and clears the certificate link; the identity is the username: the IdP account stays, the ILM user is re-created — LOCAL only (deletes the dedicated ILM user)'],
        }),
        async ({ api, own, browser, env }) => {
            test.setTimeout(SESSION_CHANGE_TEST_MS);
            const blocker = keycloakLocalBlocker(env.authMode) ?? replicaBlocker();
            test.skip(!!blocker, blocker);
            const dedicatedUser = restrictedIdentity()!;
            const user = await own.restrictedUser();
            const context = await browser.newContext({ baseURL: env.baseUrl, ignoreHTTPSErrors: true });
            try {
                const page = await context.newPage();
                const login = new LoginPage(page, env);
                await login.loginAs(dedicatedUser);
                await expect(new AppShell(page).shell).toBeVisible();
                const status = await deleteOwnUserOrRole(api, 'users', user, own.spec, 'deleted as the behaviour under test; re-created below');
                expect(status, 'delete the dedicated ILM user').toBe(204);
                await page.reload();
                await login.assertLoggedOut();
                expect((await page.request.get('/api/v1/auth/profile')).status()).toBe(401);
            } finally {
                await context.close();
                await ensureRestrictedUser(api, own.spec, dedicatedUser); // the ILM user is re-created (ensureRestrictedUser)
            }
        });
});
