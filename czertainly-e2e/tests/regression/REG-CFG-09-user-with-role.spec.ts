/**
 * REG-CFG-09 — users in the UI (release checklist: Configuration 9, and the user rows of the authorization area): a
 * user created with the run role has it and the role lists the user; edit keeps the username locked; delete removes the
 * user and its role membership. Edited and deleted users are NEW users of the run (created disabled through the API);
 * `assertOwnLive` runs before the browser changes one. Signing in as the new user needs an identity-provider account.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { RolePage } from '../../pages/RolePage';
import { UserPage } from '../../pages/UserPage';
import { assertOwnLive } from '../../utils/regression/ledger/ownership';
import { apiJson } from '../../utils/regression/apiReads';
import { createOwnRole, ensureRunRole } from '../../utils/regression/ownRoles';
import { createOwnUser, setOwnUserRoles } from '../../utils/regression/ownUsers';
import { findByName } from '../../utils/regression/listReads';
import { nameFor, updateRunState } from '../../utils/regression/ledger/runState';
import { recordCreated, recordDeleted } from '../../utils/regression/ledger/ledger';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-CFG-09';

test.describe('User with a role', { tag: tags.regression }, () => {
    test('a user created in the UI with the run role is enabled, has the role and is listed on it',
        testMeta({
            id: 'REG-CFG-09', prio: 'P1', issue: 'ilm#427',
            rule: ['release checklist Configuration 9: create a user and assign the role (POST user, then PATCH its roles); user and role detail show each other'],
        }),
        async ({ page, api, env }) => {
            const role = await test.step('Prerequisite: the run role', async () => ensureRunRole(api, SPEC));
            const { name, becomesRunObject } = nameFor('user', 'user');
            const userPage = new UserPage(page);

            const statuses = await test.step(`Users → "+" → Create User → fields → tick ${role.name} → Create`, async () => {
                await loginAsSmokeUser(page, env);
                await userPage.goToList();
                return userPage.createUser({ username: name, roleNames: [role.name] });
            });

            const uuid = await test.step('POST user and PATCH roles both succeeded', async () => {
                const created = await findByName(api, '/api/v1/users', name, 'username');
                // Ledger before assertion: the user exists once the POST answered, whatever the PATCH did.
                if (created) {
                    const own = recordCreated('users', { uuid: created.uuid, name }, SPEC, `role ${role.name}`);
                    if (becomesRunObject) updateRunState({ user: own });
                }
                expect(statuses.createStatus, 'POST /users').toBeLessThan(300);
                expect(created?.username, 'user exists').toBe(name);
                expect(statuses.rolesStatus, 'PATCH /users/{uuid}/roles').toBeLessThan(300);
                await expect(userPage.createDialog.dialog).toBeHidden();
                expect(created!.enabled).toBe(true);
                return created!.uuid as string;
            });

            await test.step('API: the user has the role', async () => {
                const roles = await apiJson<Array<{ uuid: string }>>(api, 'GET', `/api/v1/users/${uuid}/roles`);
                expect(roles.map((r) => r.uuid)).toContain(role.uuid);
            });

            await test.step('UI: user detail and role detail show each other', async () => {
                await userPage.goToDetail(uuid);
                await expect(userPage.detailsWidget).toContainText(name);
                await userPage.assertRoles([role.name]);
                const rolePage = new RolePage(page);
                await rolePage.goToDetail(role.uuid);
                await expect(page.locator('main')).toContainText(name);
            });
        });

    test('the new user can sign in when an identity-provider account exists for it',
        testMeta({
            id: 'REG-CFG-09', prio: 'P2', issue: 'ilm#427',
            rule: ['release checklist Configuration 9: sign in as the new user (the username must match an identity-provider account)'],
        }),
        async () => {
            test.skip(!process.env.REG_USER_PASSWORD, 'No IdP account for the new user: create one with the same username in Keycloak and set REG_USER_PASSWORD.');
        });

    test('editing a user keeps its locked username, and first name, last name and e-mail persist',
        testMeta({
            id: 'REG-CFG-09.b', prio: 'P1', issue: 'ilm#427',
            rule: ['update user: names and e-mail; the username is the identity, not editable; UserForm: username disabled in edit mode'],
        }),
        async ({ page, api, env }) => {
            const user = await test.step('Prerequisite: a new user of this run (API, disabled)', async () => createOwnUser(api, SPEC, 'user-edit'));
            const before = await apiJson(api, 'GET', `/api/v1/users/${user.uuid}`);
            const edited = { firstName: 'QA-edited', lastName: 'Regression-edited', email: `${user.name}-edited@example.test` };
            const userPage = new UserPage(page);

            await test.step('Guard: the user is this run\'s own object (live check) before the UI changes it', async () => {
                await assertOwnLive(api, 'users', user, 'REG-CFG-09.b UI edit');
            });

            await test.step('Detail → Edit: the username field is disabled and shows the username', async () => {
                await loginAsSmokeUser(page, env);
                await userPage.goToDetail(user.uuid);
                await userPage.openEditDialog();
                await userPage.assertUsernameLockedInEdit(user.name);
                await userPage.editDialog.cancel();
            });

            await test.step('Edit first name, last name, e-mail → Save', async () => {
                const { status } = await userPage.editUser(edited);
                expect(status, 'PUT /api/v1/users/{uuid}').toBeLessThan(300);
                await expect(userPage.editDialog.dialog).toBeHidden();
            });

            await test.step('Reopen after a reload: the new values, the same username', async () => {
                await page.reload();
                await expect(userPage.detailsWidget).toBeVisible();
                await userPage.assertDetailRows({ username: user.name, email: edited.email });
                await userPage.openEditDialog();
                await userPage.assertEditFormValues({ username: user.name, ...edited });
                await userPage.editDialog.cancel();
            });

            await test.step('API: the stored user agrees; `enabled` is unchanged', async () => {
                const stored = await apiJson(api, 'GET', `/api/v1/users/${user.uuid}`);
                expect(stored.username).toBe(user.name);
                expect(stored.firstName).toBe(edited.firstName);
                expect(stored.lastName).toBe(edited.lastName);
                expect(stored.email).toBe(edited.email);
                expect(stored.enabled).toBe(before.enabled);
            });
        });

    test('a user deleted in the UI is gone from the users list and the API list and from its role',
        testMeta({
            id: 'REG-CFG-09.c', prio: 'P1', issue: 'ilm#427',
            rule: ['delete user: its role memberships go with it; absence read from the list (core#2511)'],
        }),
        async ({ page, api, env }) => {
            const role = await test.step('Prerequisite: a new role of this run (API)', async () => createOwnRole(api, SPEC, 'role-of-deleted-user'));
            const user = await test.step('Prerequisite: a new user of this run (API, disabled) with that role', async () => {
                const u = await createOwnUser(api, SPEC, 'user-delete');
                await setOwnUserRoles(api, u, [role]);
                return u;
            });
            const userPage = new UserPage(page);

            await test.step('Precondition: the role lists the user', async () => {
                const members = await apiJson<Array<{ uuid: string }>>(api, 'GET', `/api/v1/roles/${role.uuid}/users`);
                expect(members.map((m) => m.uuid)).toContain(user.uuid);
            });

            await test.step('Guard: the user is this run\'s own object (live check) before the UI deletes it', async () => {
                await assertOwnLive(api, 'users', user, 'REG-CFG-09.c UI delete');
            });

            await test.step('Detail → Delete → "Delete User" → Delete', async () => {
                await loginAsSmokeUser(page, env);
                await userPage.goToDetail(user.uuid);
                const { status } = await userPage.deleteUserFromDetail();
                expect(status, 'DELETE /api/v1/users/{uuid}').toBeLessThan(300);
                await expect(userPage.deleteDialog.dialog).toBeHidden();
            });

            await test.step('API: the users list no longer names it (the list itself is not empty)', async () => {
                await expect.poll(async () => {
                    const all = await apiJson<Array<{ uuid: string }>>(api, 'GET', '/api/v1/users');
                    return all.length > 0 && !all.some((u) => u.uuid === user.uuid);
                }, { timeout: 30_000 }).toBe(true);
                recordDeleted('users', user, SPEC, 'deleted through the UI (REG-CFG-09.c, the behaviour under test)');
            });

            await test.step('UI: the users list has no row of that username', async () => {
                await userPage.reloadList();
                await userPage.assertNotListed(user.name);
            });

            await test.step('API: the role no longer lists the user', async () => {
                const members = await apiJson<Array<{ uuid: string }>>(api, 'GET', `/api/v1/roles/${role.uuid}/users`);
                expect(members.map((m) => m.uuid)).not.toContain(user.uuid);
            });
        });
});
