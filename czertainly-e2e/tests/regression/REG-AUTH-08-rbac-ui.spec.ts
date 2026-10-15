/**
 * REG-AUTH-08 — what a restricted user sees in the admin UI (auth-rbac area, ilm#427 steps 1–3; rows REG-AUTH-08 and
 * REG-AUTH-10; the P2 / P3 rows of this plan file are B5).
 *
 * Both rows need the dedicated second identity (DED, DevOps request 2) signed in through the browser, (guard request GR-3, the
 * DED ILM user is the suite's own but not run-prefixed, was accepted by the guard pass and merged 2026-10-15): plain tests whose
 * body starts with the `@needs:second-identity` preflight and skips with the named request until the account exists. Fixture roles are built through the API (never the editor: fe-administrator#2283).
 *
 * The admin UI has no route guards (rules H1): a refused page still loads its shell, the data call answers 403, and the page
 * shows the lock widget — title "Access Denied", the server's message as text, the hint in a tooltip (H2). The assertions read
 * the message from the captured 403 response, never from a literal.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { AccessPage } from '../../pages/AccessPage';
import { LoginPage } from '../../pages/LoginPage';
import { replicaBlocker, restrictedIdentity, secondIdentityBlocker } from '../../utils/regression/identities';
import { applyFixtureWithRole, ensureRbacObjects, ensureRestrictedUserOrSkip, restrictedRoleSwitch } from '../../utils/regression/rbacData';
import { accessDeniedProblems } from '../../utils/regression/rbacFixtures';
import { RaProfileSourceMissing } from '../../utils/regression/regressionApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-AUTH-08';

/** The three refused pages of REG-AUTH-08: hash route and the list call behind it. */
const REFUSED_PAGES: ReadonlyArray<{ route: string; api: RegExp }> = [
    { route: 'roles', api: /^\/api\/v1\/roles$/ },
    { route: 'users', api: /^\/api\/v1\/users$/ },
    { route: 'credentials', api: /^\/api\/v1\/credentials$/ },
];

test.describe('REG-AUTH restricted user in the UI', { tag: tags.regression }, () => {
    for (const fixture of ['F0', 'F1'] as const) {
        test(`REG-AUTH-08[${fixture}]: a refused page renders the lock widget with the server message and the shell still loads (needs the second identity)`,
            meta({
                id: 'REG-AUTH-08', prio: 'P1', issue: 'ilm#427', needs: 'second-identity',
                rule: [
                    'auth-rbac H1 (the menu comes from allowedListings; routes are not guarded), H2 (a 403 renders as a lock widget: title "Access Denied", text = the server message, hint "Please contact your admin to get access"), G2 (the 403 body); AR-700, AR-704; ilm#427 step 3',
                    'F0 = no permissions, F1 = certificates [list, detail] (plan §3.2)',
                ],
            }),
            async ({ api, browser, env, restrictedToken }) => {
                test.setTimeout(300_000);
                test.skip(env.authMode !== 'local', `AUTH_MODE=${env.authMode}: no identity-provider sign-in for DED`);
                const blocker = secondIdentityBlocker(env.username) ?? replicaBlocker();
                test.skip(!!blocker, blocker);
                test.skip(restrictedToken === undefined, 'no bearer token for the second identity');
                const ded = restrictedIdentity()!;
                const user = await test.step('The dedicated ILM user (created by this run)', async () => ensureRestrictedUserOrSkip(api, SPEC, ded, (reason) => test.skip(true, reason)));
                const sw = restrictedRoleSwitch(api, user, restrictedToken!.bearer());
                const { role } = await test.step(`Fixture ${fixture} is DED's only role and is in force`, async () => applyFixtureWithRole(api, sw, fixture, {}, SPEC));

                const context = await browser.newContext({ baseURL: env.baseUrl, ignoreHTTPSErrors: true });
                try {
                    const page = await context.newPage();
                    const access = new AccessPage(page);
                    await test.step('DED signs in (its own browser context); the sign-in kept the fixture role (else: the sync policy, not RBAC)', async () => {
                        await new LoginPage(page, env).loginAs(ded);
                        await expect(access.shell).toBeVisible();
                        await access.assertRolesAfterSignIn([role.uuid]);
                    });
                    for (const target of REFUSED_PAGES) {
                        await test.step(`#/${target.route}: the list call is 403 (never 500) and the page shows the lock widget`, async () => {
                            const call = page.waitForResponse((r) => r.request().method() === 'GET' && target.api.test(new URL(r.url()).pathname));
                            await page.goto(`administrator/#/${target.route}`);
                            const res = await call;
                            expect(res.status(), `GET ${new URL(res.url()).pathname}`).toBe(403);
                            const json = await res.json();
                            expect(accessDeniedProblems(res.headers()['content-type'] ?? '', json, undefined)).toEqual([]);
                            await expect(access.shell, 'the shell still loads (no route guards)').toBeVisible();
                            await access.assertLocked(String(json.message));
                            await access.assertNoDataRows();
                        });
                    }
                } finally {
                    await context.close();
                }
            });
    }

    test('REG-AUTH-10: a group-scoped user sees only group-A certificates; a certificate in another group, by URL, is refused in the UI (needs the second identity and a healthy CA for the fixture RA profiles)',
        meta({
            id: 'REG-AUTH-10', prio: 'P1', issue: 'ilm#427', needs: 'second-identity',
            rule: [
                'auth-rbac E8 (group fallback: `groups` / `members` on a group of the certificate), E9 (certificate visibility = list-resource AND RA-profile members, OR group members, OR owner), H2; AR-400; ilm#427 steps 1–3',
                'ilm#427 step 1 says "list and detail on certificates, limited to group G1": certificates have no object-level permissions, the only group knob is `groups` / `members` on G1 (rules §6.1 C1) — fixture F3',
            ],
        }),
        async ({ api, browser, env, restrictedToken }) => {
            test.setTimeout(420_000);
            test.skip(env.authMode !== 'local', `AUTH_MODE=${env.authMode}: no identity-provider sign-in for DED`);
            const blocker = secondIdentityBlocker(env.username) ?? replicaBlocker();
            test.skip(!!blocker, blocker);
            test.skip(restrictedToken === undefined, 'no bearer token for the second identity');
            const ded = restrictedIdentity()!;
            const refs = await test.step('The data table (own RA profiles, groups, six uploaded certificates)', async () => {
                try {
                    return await ensureRbacObjects(api, SPEC);
                } catch (e) {
                    if (e instanceof RaProfileSourceMissing) test.skip(true, e.reason);
                    throw e;
                }
            });
            const user = await ensureRestrictedUserOrSkip(api, SPEC, ded, (reason) => test.skip(true, reason));
            const sw = restrictedRoleSwitch(api, user, restrictedToken!.bearer());
            const { role } = await test.step('Fixture F3 (groups: object G1, members) is DED\'s only role and is in force', async () => applyFixtureWithRole(api, sw, 'F3', refs, SPEC));

            const context = await browser.newContext({ baseURL: env.baseUrl, ignoreHTTPSErrors: true });
            try {
                const page = await context.newPage();
                const access = new AccessPage(page);
                await new LoginPage(page, env).loginAs(ded);
                // After the UI sign-in DED must still hold F3: SYNC_POLICY=sync-data would have rewritten the roles (DevOps request 4,
                // core#2226) and every assertion below would fail as an RBAC finding it is not.
                await access.assertRolesAfterSignIn([role.uuid]);

                await test.step('Certificates list: exactly {cg1, cg12}', async () => {
                    await access.visit('certificates');
                    await access.settle();
                    expect((await access.listedNames()).sort()).toEqual([refs.certs.cg1.name, refs.certs.cg12.name].sort());
                });

                await test.step('cg1 → the detail renders', async () => {
                    await page.goto(`administrator/#/certificates/detail/${refs.certs.cg1.uuid}`);
                    await expect(access.main).toContainText(refs.certs.cg1.name);
                    await expect(access.lock).toHaveCount(0);
                });

                for (const key of ['cg2', 'c1'] as const) {
                    await test.step(`${key} by URL → the lock widget "Access Denied" with the Detail / Certificate message, a 403 on the detail call`, async () => {
                        const call = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === `/api/v1/certificates/${refs.certs[key].uuid}`);
                        await page.goto(`administrator/#/certificates/detail/${refs.certs[key].uuid}`);
                        const res = await call;
                        expect(res.status()).toBe(403);
                        const json = await res.json();
                        expect(accessDeniedProblems(res.headers()['content-type'] ?? '', json, { action: 'Detail', resource: 'Certificate' })).toEqual([]);
                        await access.assertLocked(String(json.message));
                    });
                }
            } finally {
                await context.close();
            }
        });
});
