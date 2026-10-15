/**
 * REG-CFG-09 — Create user and assign the user to the role (release checklist: Configuration 9).
 *
 * Flow: Users → "+" → Create User → username, names, e-mail, Enabled (+ any required custom attribute) →
 * tick the run's role in "Assigned User Roles" → Create (POST user, then PATCH roles) → the user exists, is
 * enabled and has the role; the role lists the user.
 * Logging in as the new user needs an identity-provider account with the same username (Keycloak); without one
 * that step is skipped.
 *
 * B1 (auth-rbac rows, ilm#427): REG-CFG-09.b edit (the username is locked) and .c delete in the UI, each on a NEW user of
 * the run created through the API (`createOwnUser`, disabled: it cannot sign in), never a user that existed before the
 * run; `assertOwnLive` proves ownership before the browser changes it (decision Q1). A user the UI deleted gets its
 * `deleted` ledger line once the authoritative LIST no longer names it (core#2511). Page actions: pages/UserPage.ts (m4).
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { RolePage } from '../../pages/RolePage';
import { UserPage } from '../../pages/UserPage';
import { assertOwnLive } from '../../utils/regression/ownObjects';
import { apiJson, createOwnRole, createOwnUser, ensureRole, findByName, setOwnUserRoles } from '../../utils/regression/regressionApi';
import { nameFor, recordCreated, recordDeleted, updateState } from '../../utils/regression/regressionRun';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-CFG-09';

test.describe('@regression REG-CFG-09 user with role', () => {
    test('create a user with the run role through the UI', async ({ page, api, env }) => {
        const role = await test.step('Prerequisite: the run role', async () => ensureRole(api, SPEC));
        const { name, becomesRunObject } = nameFor('user', 'user');
        const userPage = new UserPage(page);

        const statuses = await test.step(`Users → "+" → Create User → fields → tick ${role.name} → Create`, async () => {
            await loginAsSmokeUser(page, env);
            await userPage.goToList();
            return userPage.create({ username: name, roleNames: [role.name] });
        });

        const uuid = await test.step('POST user and PATCH roles both succeeded', async () => {
            const created = await findByName(api, '/api/v1/users', name, 'username');
            // Ledger before assertion: the user exists once the POST answered, whatever the PATCH did.
            if (created) {
                const own = recordCreated('users', { uuid: created.uuid, name }, SPEC, `role ${role.name}`);
                if (becomesRunObject) updateState({ user: own });
            }
            expect(statuses.createStatus, 'POST /users').toBeLessThan(300);
            expect(created, 'user exists').toBeTruthy();
            expect(statuses.rolesStatus, 'PATCH /users/{uuid}/roles').toBeLessThan(300);
            await expect(userPage.createDialog).toBeHidden();
            expect(created!.enabled).toBe(true);
            return created!.uuid as string;
        });

        await test.step('API: the user has the role', async () => {
            const roles = await apiJson<Array<{ uuid: string }>>(api, 'GET', `/api/v1/users/${uuid}/roles`);
            expect(roles.map((r) => r.uuid)).toContain(role.uuid);
        });

        await test.step('UI: user detail and role detail show each other', async () => {
            await userPage.openDetail(uuid);
            await expect(userPage.detailsWidget).toContainText(name);
            await userPage.assertRoles([role.name]);
            const rolePage = new RolePage(page);
            await rolePage.openDetail(role.uuid);
            await expect(page.locator('main')).toContainText(name);
        });
    });

    test('log in as the new user (needs an identity-provider account)', async () => {
        test.skip(!process.env.REG_USER_PASSWORD, 'No IdP account for the new user: create one with the same username in Keycloak and set REG_USER_PASSWORD.');
    });

    test('REG-CFG-09.b: editing an own user keeps the username (field disabled); first name, last name and e-mail persist after reopen',
        meta({
            id: 'REG-CFG-09.b', prio: 'P1', issue: 'ilm#427',
            rule: ['ilm#427 step 11; auth-rbac C3 (update user: names, e-mail), A8 (the username is the identity, not editable); UserForm: username disabled in edit mode'],
        }),
        async ({ page, api, env }) => {
            const user = await test.step('Prerequisite: a new user of this run (API, disabled)', async () => createOwnUser(api, 'user-edit', SPEC));
            const before = await apiJson(api, 'GET', `/api/v1/users/${user.uuid}`);
            const edited = { firstName: 'QA-edited', lastName: 'Regression-edited', email: `${user.name}-edited@example.test` };
            const userPage = new UserPage(page);

            await test.step('Guard: the user is this run\'s own object (live check) before the UI changes it', async () => {
                await assertOwnLive(api, 'users', user, 'REG-CFG-09.b UI edit');
            });

            await test.step('Detail → Edit: the username field is disabled and shows the username', async () => {
                await loginAsSmokeUser(page, env);
                await userPage.openDetail(user.uuid);
                await userPage.openEditDialog();
                await userPage.assertUsernameLockedInEdit(user.name);
                await userPage.cancelDialog(userPage.editDialog);
            });

            await test.step('Edit first name, last name, e-mail → Save', async () => {
                await userPage.edit(edited);
            });

            await test.step('Reopen after a reload: the new values, the same username', async () => {
                await userPage.assertEdited({ username: user.name, ...edited });
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

    test('REG-CFG-09.c: deleting an own user in the UI removes it from the users list and the API list; its role no longer lists it',
        meta({
            id: 'REG-CFG-09.c', prio: 'P1', issue: 'ilm#427',
            rule: ['ilm#427 step 12; auth-rbac C6 (delete user; its role memberships go with it); absence read from the list (core#2511)'],
        }),
        async ({ page, api, env }) => {
            const role = await test.step('Prerequisite: a new role of this run (API)', async () => createOwnRole(api, 'role-of-deleted-user', SPEC));
            const user = await test.step('Prerequisite: a new user of this run (API, disabled) with that role', async () => {
                const u = await createOwnUser(api, 'user-delete', SPEC);
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
                await userPage.openDetail(user.uuid);
                await userPage.deleteFromDetail();
            });

            await test.step('API: the users list no longer names it (the list itself is not empty)', async () => {
                await expect.poll(async () => {
                    const all = await apiJson<Array<{ uuid: string }>>(api, 'GET', '/api/v1/users');
                    return all.length > 0 && !all.some((u) => u.uuid === user.uuid);
                }, { timeout: 30_000 }).toBe(true);
                recordDeleted('users', user, SPEC, 'deleted through the UI (REG-CFG-09.c, the behaviour under test)');
            });

            await test.step('UI: the users list has no row of that username', async () => {
                await userPage.assertGone(user.name);
            });

            await test.step('API: the role no longer lists the user', async () => {
                const members = await apiJson<Array<{ uuid: string }>>(api, 'GET', `/api/v1/roles/${role.uuid}/users`);
                expect(members.map((m) => m.uuid)).not.toContain(user.uuid);
            });
        });
});
