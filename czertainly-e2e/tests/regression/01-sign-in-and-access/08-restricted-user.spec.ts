/**
 * REG-AUTH-08, REG-AUTH-10 — a restricted user in the admin UI: a refused page shows the lock widget with the 403 message,
 * a group-scoped user sees only its group (ilm#427). The dedicated second identity signs in in its own browser context.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { AccessDeniedWidget } from '../../../pages/AccessDeniedWidget';
import { AppShell } from '../../../pages/AppShell';
import { expectRolesAfterSignIn, replicaBlocker, restrictedIdentity } from '../../../utils/regression/rbac/identities';
import { LoginPage } from '../../../pages/LoginPage';
import { accessDeniedProblems } from '../../../utils/regression/rbac/permissionMatrix';
import { applyFixtureWithRole, ensureRbacObjects, restrictedRoleSwitch } from '../../../utils/regression/rbac/permissionObjects';
import { testMeta, tags } from '../../../utils/regression/tags';
import { actAndWaitForApi } from '../../../pages/ui/waitForResponse';
import { RESTRICTED_USER_TEST_MS, GROUP_SCOPED_USER_TEST_MS } from '../../../utils/regression/timeouts';

/** The three refused pages of REG-AUTH-08: hash route and the list call behind it. */
const REFUSED_PAGES: ReadonlyArray<{ route: string; api: RegExp }> = [
    { route: 'roles', api: /^\/api\/v1\/roles$/ },
    { route: 'users', api: /^\/api\/v1\/users$/ },
    { route: 'credentials', api: /^\/api\/v1\/credentials$/ },
];

/** The two roles the refused pages are shown for: the permission fixture code, the row and the user in the title. */
const ROLES = [
    { fixture: 'F0', row: 'no permissions', who: 'a user with no permissions' },
    { fixture: 'F1', row: 'certificate read access', who: 'a user with certificate read access' },
] as const;

test.describe('Restricted user in the UI', { tag: tags.regression }, () => {
    for (const { fixture, row, who } of ROLES) {
        test(`a refused page shows the lock widget with the server message for ${who}`,
            testMeta({
                id: 'REG-AUTH-08', row, prio: 'P2', issue: 'ilm#427', needs: 'second-identity',
                rule: [
                    'the menu comes from the allowed listings and routes are not guarded; a 403 renders as a lock widget (title "Access Denied", text = the server message, hint "Please contact your admin to get access"); the 403 body carries the problem fields; ilm#427 step 3',
                    'the two roles: no permissions at all, and certificates [list, detail] only',
                    'the shell of a refused page still loads',
                ],
            }),
            async ({ api, own, browser, env, restrictedToken }) => {
                test.setTimeout(RESTRICTED_USER_TEST_MS);
                test.skip(env.authMode !== 'local', `AUTH_MODE=${env.authMode}: no identity-provider sign-in for the dedicated user`);
                const blocker = replicaBlocker();
                test.skip(!!blocker, blocker);
                test.skip(restrictedToken === undefined, 'no bearer token for the second identity');
                const dedicatedUser = restrictedIdentity()!;
                const user = await test.step('The dedicated ILM user (created by this run)', async () => own.restrictedUser());
                const sw = restrictedRoleSwitch(api, user, restrictedToken!.bearer());
                const { role } = await test.step(`The ${row} role is the dedicated user's only role and is in force`, async () => applyFixtureWithRole(api, sw, fixture, {}, own.spec));

                const context = await browser.newContext({ baseURL: env.baseUrl, ignoreHTTPSErrors: true });
                try {
                    const page = await context.newPage();
                    const access = new AppShell(page);
                    await test.step('The dedicated user signs in (its own browser context); the sign-in kept the fixture role (else: the sync policy, not RBAC)', async () => {
                        const login = new LoginPage(page, env);
                        await login.goto();
                        await login.login(dedicatedUser);
                        await expect(access.shell).toBeVisible();
                        await expectRolesAfterSignIn(page, [role.uuid]);
                    });
                    for (const target of REFUSED_PAGES) {
                        await test.step(`#/${target.route}: the list call is 403 (never 500) and the page shows the lock widget`, async () => {
                            const res = await actAndWaitForApi(page, { method: 'GET', path: target.api }, () => access.goTo(target.route));
                            expect(res.status(), `GET ${new URL(res.url()).pathname}`).toBe(403);
                            const json = await res.json();
                            expect(accessDeniedProblems(res.headers()['content-type'] ?? '', json, undefined)).toEqual([]);
                            await expect(access.shell, 'the shell still loads (no route guards)').toBeVisible();
                            const denied = new AccessDeniedWidget(page);
                            await denied.assertShown(String(json.message));
                            await denied.openDetails();
                            await denied.assertHintShown();
                            await expect(access.detailLinks, 'no data rows next to the lock').toHaveCount(0);
                        });
                    }
                } finally {
                    await context.close();
                }
            });
    }

    test('a group-scoped user sees only group-A certificates and is refused another group\'s certificate by URL',
        testMeta({
            id: 'REG-AUTH-10', prio: 'P2', issue: 'ilm#427', needs: ['second-identity', 'ca'],
            rule: [
                'group fallback: `groups` / `members` on a group of the certificate; certificate visibility = list-resource AND RA-profile members, OR group members, OR owner; ilm#427 steps 1–3',
                'ilm#427 step 1 says "list and detail on certificates, limited to one group": certificates have no object-level permissions, the only group knob is `groups` / `members` on that group',
                'needs the second identity and a healthy CA for the fixture RA profiles',
            ],
        }),
        async ({ api, own, browser, env, restrictedToken }) => {
            test.setTimeout(GROUP_SCOPED_USER_TEST_MS);
            test.skip(env.authMode !== 'local', `AUTH_MODE=${env.authMode}: no identity-provider sign-in for the dedicated user`);
            const blocker = replicaBlocker();
            test.skip(!!blocker, blocker);
            test.skip(restrictedToken === undefined, 'no bearer token for the second identity');
            const dedicatedUser = restrictedIdentity()!;
            const refs = await test.step('The data table (own RA profiles, groups, six uploaded certificates)', async () => ensureRbacObjects(api, own.spec));
            const user = await own.restrictedUser();
            const sw = restrictedRoleSwitch(api, user, restrictedToken!.bearer());
            const { role } = await test.step('The group-scoped role (groups: one group, members) is the dedicated user\'s only role and is in force', async () => applyFixtureWithRole(api, sw, 'F3', refs, own.spec));

            const context = await browser.newContext({ baseURL: env.baseUrl, ignoreHTTPSErrors: true });
            try {
                const page = await context.newPage();
                const access = new AppShell(page);
                const login = new LoginPage(page, env);
                await login.goto();
                await login.login(dedicatedUser);
                // After the UI sign-in the dedicated user must still hold the group-scoped role: SYNC_POLICY=sync-data would have rewritten
                // the roles (the sign-in sync policy of the dedicated stack, core#2226) and every assertion below would fail as an
                // access finding it is not.
                await expectRolesAfterSignIn(page, [role.uuid]);

                await test.step('Certificates list: exactly the two certificates of its group', async () => {
                    const listed = await actAndWaitForApi(page, { method: 'POST', path: /^\/api\/v1\/certificates$/ }, () => access.goTo('certificates'));
                    expect(listed.status(), 'the certificate list call').toBe(200);
                    expect(((await listed.json()) as { totalItems?: number }).totalItems, 'the list call counts exactly the two group certificates').toBe(2);
                    const wanted = [refs.certs.cg1.name, refs.certs.cg12.name].sort();
                    await expect.poll(async () => (await access.listedNames()).sort(), { message: 'the rows shown' }).toEqual(wanted);
                });

                await test.step('A certificate of its group → the detail renders', async () => {
                    await access.goTo(`certificates/detail/${refs.certs.cg1.uuid}`);
                    await expect(access.main).toContainText(refs.certs.cg1.name);
                    await expect(new AccessDeniedWidget(page).lock).toHaveCount(0);
                });

                const refused = [
                    { key: 'cg2', what: 'a certificate of another group' },
                    { key: 'c1', what: 'a certificate without a group' },
                ] as const;
                for (const { key, what } of refused) {
                    await test.step(`${what} by URL → the lock widget "Access Denied" with the Detail / Certificate message, a 403 on the detail call`, async () => {
                        const { uuid } = refs.certs[key];
                        const res = await actAndWaitForApi(page, { method: 'GET', path: new RegExp(`^/api/v1/certificates/${uuid}$`) }, () => access.goTo(`certificates/detail/${uuid}`));
                        expect(res.status()).toBe(403);
                        const json = await res.json();
                        expect(accessDeniedProblems(res.headers()['content-type'] ?? '', json, { action: 'Detail', resource: 'Certificate' })).toEqual([]);
                        const denied = new AccessDeniedWidget(page);
                        await denied.assertShown(String(json.message));
                        await denied.openDetails();
                        await denied.assertHintShown();
                    });
                }
            } finally {
                await context.close();
            }
        });
});
