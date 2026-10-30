/**
 * REG-CFG-09 — Users in the admin UI (release checklist: Configuration 9; ilm#427).
 *
 * Creates a user with the run role (enabled, role shown on both sides), edits it with the username locked (.b) and deletes it
 * (.c). Signing in as the new user is a test.fixme: it needs an identity-provider account the suite cannot create.
 * Absence is read from the list (core#2511).
 *
 * Only users this run created are edited or deleted (created disabled through the API); the live check runs before the
 * browser changes one. The ledger line is written once the POST answered, whatever the roles PATCH does.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { RolePage } from '../../../pages/RolePage';
import { UserPage } from '../../../pages/UserPage';
import { apiJson } from '../../../utils/regression/apiReads';
import { ensureRunRole } from '../../../utils/regression/ownRoles';
import { setOwnUserRoles } from '../../../utils/regression/ownUsers';
import { findByName } from '../../../utils/regression/listReads';
import { ownName } from '../../../utils/regression/ledger/runState';
import { lookupInList, submitRecordingByNameOnFailure } from '../../../utils/regression/ledger/uiCreates';
import { testMeta, tags } from '../../../utils/regression/tags';
import { LIST_STATE_MS } from '../../../utils/regression/timeouts';

test.describe('User with a role', { tag: tags.regression }, () => {
    test('a user created in the UI with the run role is enabled, has the role and is listed on it',
        testMeta({
            id: 'REG-CFG-09', row: 'created with the run role', prio: 'P1', issue: 'ilm#427',
            rule: ['create a user and assign the role (POST user, then PATCH its roles); user and role detail show each other'],
        }),
        async ({ signedIn: page, api, own }) => {
            const role = await test.step('Prerequisite: the run role', async () => ensureRunRole(api, own.spec));
            const name = ownName('user');
            const users = new UserPage(page);

            const { created, uuid } = await test.step(`Users → "+" → Create User → fields → tick ${role.name} → Create`, async () => {
                await users.goToList();
                const answer = await submitRecordingByNameOnFailure(
                    { type: 'users', name, spec: own.spec, note: `role ${role.name}`, lookup: lookupInList(api, '/api/v1/users', 'username') },
                    () => users.createUser({ username: name, roleNames: [role.name] }));
                // Ledger before anything else: the user exists once the POST answered (its uuid is in the answer), whatever the PATCH does.
                const ref = own.record('users', answer, { name, note: `role ${role.name}` });
                return { created: answer, uuid: ref.uuid };
            });

            await test.step('POST user and PATCH roles both succeeded', async () => {
                const rolesStatus = await created.rolesStatus();
                const listed = await findByName(api, '/api/v1/users', name, 'username');
                expect(listed?.username, 'user exists').toBe(name);
                expect(rolesStatus, 'PATCH /users/{uuid}/roles').toBeLessThan(300);
                await expect(users.createDialog.dialog).toBeHidden();
                expect(listed!.enabled).toBe(true);
            });

            await test.step('API: the user has the role', async () => {
                const roles = await apiJson<Array<{ uuid: string }>>(api, 'GET', `/api/v1/users/${uuid}/roles`);
                expect(roles.map((r) => r.uuid)).toContain(role.uuid);
            });

            await test.step('UI: user detail and role detail show each other', async () => {
                await users.goToDetail(uuid);
                await expect(users.detailsWidget).toContainText(name);
                await users.assertRoles([role.name]);
                const roles = new RolePage(page);
                await roles.goToDetail(role.uuid);
                await expect(roles.main, 'the role page lists the user').toContainText(name);
            });
        });

    // The reason is the `parked` annotation of the declaration: it reaches the report (a fixme body never runs).
    test.fixme('the new user can sign in when an identity-provider account exists for it',
        testMeta({
            id: 'REG-CFG-09', row: 'sign in as the new user', prio: 'P1', issue: 'ilm#427',
            rule: ['sign in as the new user (the username must match an identity-provider account)'],
            parked: 'needs an identity-provider account whose username is the new user; the suite cannot create one',
        }),
        async () => {});

    test('editing a user keeps its locked username, and first name, last name and e-mail persist',
        testMeta({
            id: 'REG-CFG-09.b', prio: 'P1', issue: 'ilm#427',
            rule: ['update user: names and e-mail; the username is the identity, not editable; UserForm: username disabled in edit mode'],
        }),
        async ({ signedIn: page, api, own, live }) => {
            const user = await test.step('Prerequisite: a new user of this run (API, disabled)', async () => own.user('user-edit'));
            const before = await apiJson(api, 'GET', `/api/v1/users/${user.uuid}`);
            const edited = { firstName: 'QA-edited', lastName: 'Regression-edited', email: `${user.name}-edited@example.test` };
            const users = new UserPage(page);

            const liveUser = await test.step('Guard: the user is this run\'s own object (live check) before the UI changes it', async () => live('users', user));

            await test.step('Detail → Edit: the username field is disabled and shows the username', async () => {
                await users.goToDetail(liveUser.uuid);
                await users.openEditDialog();
                await users.assertUsernameLockedInEdit(liveUser.name);
                await users.editDialog.cancel();
            });

            await test.step('Edit first name, last name, e-mail → Save', async () => {
                const { status, sent } = await users.editUser(edited);
                expect(status, 'PUT /api/v1/users/{uuid}').toBeLessThan(300);
                expect(sent, 'the Save request carries the new names and e-mail').toMatchObject(edited);
                await expect(users.editDialog.dialog).toBeHidden();
            });

            await test.step('Reopen after a reload: the new values, the same username', async () => {
                await page.reload();
                await expect(users.detailsWidget).toBeVisible();
                await users.assertDetailRows({ username: user.name, email: edited.email });
                await users.openEditDialog();
                await users.assertEditFormValues({ username: user.name, ...edited });
                await users.editDialog.cancel();
            });

            await test.step('API: the stored user agrees; `enabled` is unchanged', async () => {
                const stored = await apiJson(api, 'GET', `/api/v1/users/${user.uuid}`);
                expect(stored, 'the stored user agrees with the form and keeps `enabled`').toMatchObject({ username: user.name, ...edited, enabled: before.enabled });
            });
        });

    test('a user deleted in the UI is gone from the users list and the API list and from its role',
        testMeta({
            id: 'REG-CFG-09.c', prio: 'P1', issue: 'ilm#427',
            rule: ['delete user: its role memberships go with it; absence read from the list (core#2511)'],
        }),
        async ({ signedIn: page, api, own, live }) => {
            const role = await test.step('Prerequisite: a new role of this run (API)', async () => own.role('role-of-deleted-user'));
            const user = await test.step('Prerequisite: a new user of this run (API, disabled) with that role', async () => {
                const created = await own.user('user-delete');
                await setOwnUserRoles(api, created, [role]);
                return created;
            });
            const users = new UserPage(page);

            await test.step('Precondition: the role lists the user', async () => {
                const members = await apiJson<Array<{ uuid: string }>>(api, 'GET', `/api/v1/roles/${role.uuid}/users`);
                expect(members.map((m) => m.uuid)).toContain(user.uuid);
            });

            const liveUser = await test.step('Guard: the user is this run\'s own object (live check) before the UI deletes it', async () => live('users', user));

            await test.step('Detail → Delete → "Delete User" → Delete', async () => {
                await users.goToDetail(liveUser.uuid);
                const { status } = await users.deleteFromDetail();
                expect(status, 'DELETE /api/v1/users/{uuid}').toBeLessThan(300);
                await expect(users.deleteDialog.dialog).toBeHidden();
            });

            await test.step('API: the users list no longer names it (the list itself is not empty)', async () => {
                await expect.poll(async () => {
                    const all = await apiJson<Array<{ uuid: string }>>(api, 'GET', '/api/v1/users');
                    return all.length > 0 && !all.some((u) => u.uuid === user.uuid);
                }, { timeout: LIST_STATE_MS }).toBe(true);
                own.deleted('users', user, 'deleted through the UI (the behaviour under test)');
            });

            await test.step('UI: the users list has no row of that username', async () => {
                await users.reloadList();
                await users.assertNotListed(user.name);
            });

            await test.step('API: the role no longer lists the user', async () => {
                const members = await apiJson<Array<{ uuid: string }>>(api, 'GET', `/api/v1/roles/${role.uuid}/users`);
                expect(members.map((m) => m.uuid)).not.toContain(user.uuid);
            });
        });
});
