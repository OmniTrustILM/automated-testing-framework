/**
 * REG-AUTH-03 — sign-out ends the browser and the identity-provider session; the old cookie is dead (ilm#426).
 * Sorts last: a Keycloak sign-out ends the shared admin's single-sign-on session.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { AppShell } from '../../../pages/AppShell';
import { LoginPage } from '../../../pages/LoginPage';
import { testMeta, tags } from '../../../utils/regression/tags';
import { SESSION_CHANGE_TEST_MS } from '../../../utils/regression/timeouts';

test.describe('Sign-out', { tag: tags.regression }, () => {
    test('sign-out ends both sessions, the old cookie is dead, signing in again works',
        testMeta({
            id: 'REG-AUTH-03', prio: 'P2', issue: 'ilm#426',
            rule: [
                '/logout invalidates the session, clears the authentication, deletes cookie `session-id` and runs the OIDC end-session at the provider',
                'ilm#426 step 6 ("the Keycloak session ends too, so the next sign-in asks for credentials")',
            ],
        }),
        async ({ page, request, env }) => {
            test.setTimeout(SESSION_CHANGE_TEST_MS);
            test.skip(env.authMode !== 'local', `AUTH_MODE=${env.authMode}: no identity-provider session to end (a header-mode stack has no sign-out)`);
            const login = new LoginPage(page, env);
            const access = new AppShell(page);

            const signedIn = await test.step('Sign in; the profile answers 200; remember the session cookie', async () => {
                await login.goto();
                await login.login();
                const cookie = await LoginPage.readSessionCookie(page);
                expect(cookie, 'a session-id cookie after sign-in').toBeDefined();
                return { cookie: cookie!.value, username: (await access.profile()).username };
            });

            await test.step('User menu → Log out → the sign-in screen is shown', async () => {
                await login.logOut(signedIn.username);
            });

            await test.step('The same context\'s profile is 401; the session cookie is removed or changed', async () => {
                expect((await page.request.get('/api/v1/auth/profile')).status(), 'profile after the sign-out').toBe(401);
                const after = await LoginPage.readSessionCookie(page);
                expect(after === undefined || after.value !== signedIn.cookie, 'the old session-id is gone').toBe(true);
            });

            await test.step('The old cookie replayed from a clean request context is 401', async () => {
                const res = await request.get('/api/v1/auth/profile', { headers: { Cookie: `session-id=${signedIn.cookie}` } });
                expect(res.status(), 'a dead session id').toBe(401);
            });

            await test.step('Browser Back shows the sign-in again and no authenticated data', async () => {
                const watch = access.watchApi();
                await page.goBack().catch(() => undefined);
                // Seen on a live tier: after Back the page can sit on a spinner without redirecting to the sign-in until it is reloaded
                // (a possible frontend improvement, not a defect of the rule). The rule is "no data, then the sign-in": assert no shell
                // and no data after Back, then reload and assert the sign-in page.
                await expect(access.shell, 'no authenticated shell after Back').toHaveCount(0);
                expect(watch.dataAnswers(), 'no authenticated API data after Back').toEqual([]);
                await page.reload();
                await login.assertLoggedOut();
                expect(watch.dataAnswers(), 'no authenticated API data after the reload').toEqual([]);
                watch.stop();
            });

            await test.step('Opening the app again asks for credentials (no silent single sign-on), and signing in works', async () => {
                await login.goToAppForCredentials();
                await login.assertCredentialPrompt();
                await login.login();
                await expect(access.shell, 'signed in again').toBeVisible();
                expect((await access.profile()).username).toBe(signedIn.username);
            });
        });
});
