/**
 * REG-CFG-07 — Roles in the admin UI (release checklist: Configuration 7; ilm#427).
 *
 * Creates a role, refuses a duplicate name (.a), edits it with the name locked (.b) and deletes it (.c).
 * core#2297: a duplicate name answers 500 instead of a message (test.fail on the message only).
 * A deleted role's detail answers 500 (core#2511), so absence is read from the list.
 *
 * Only roles this run created are edited or deleted; the live check runs before the browser acts. The ledger line is
 * written before the first assertion.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { RolePage } from '../../../pages/RolePage';
import { apiJson } from '../../../utils/regression/apiReads';
import { ensureRunRole } from '../../../utils/regression/ownRoles';
import { findByName, rowsNamed } from '../../../utils/regression/listReads';
import { ownName, runName } from '../../../utils/regression/ledger/runState';
import { lookupInList, submitRecordingByNameOnFailure } from '../../../utils/regression/ledger/uiCreates';
import { testMeta, tags } from '../../../utils/regression/tags';
import { LIST_STATE_MS } from '../../../utils/regression/timeouts';

test.describe('Role configuration', { tag: tags.regression }, () => {
    test('a role created in the UI is listed, is not a system role and has no permissions yet',
        testMeta({
            id: 'REG-CFG-07', prio: 'P1', issue: 'ilm#427',
            rule: ['create a role with a name, description and e-mail; a new role has no users and no permissions'],
        }),
        async ({ signedIn: page, api, own }) => {
            const name = ownName('role');
            const roles = new RolePage(page);

            await test.step('Roles → "+" → Create Role', async () => {
                await roles.goToList();
                await roles.openCreateDialog();
                await roles.fillCreateForm({ name, description: 'Main-functionality regression operator', email: `${name}@example.test` });
            });

            const uuid = await test.step('Create → the role exists (not a system role)', async () => {
                const answer = await submitRecordingByNameOnFailure({ type: 'roles', name, spec: own.spec, lookup: lookupInList(api, '/api/v1/roles') }, () => roles.submitCreateForm());
                // Ledger before assertion: the role exists once the POST answered, and its uuid is in the answer.
                own.record('roles', answer, { name });
                const created = await findByName(api, '/api/v1/roles', name);
                expect(created?.name, 'the role is listed').toBe(name);
                await expect(roles.createDialog.dialog).toBeHidden();
                expect(created!.systemRole).toBe(false);
                return created!.uuid as string;
            });

            await test.step('Detail page: Role Details, no assigned users, no permissions yet', async () => {
                await roles.goToDetail(uuid);
                await expect(roles.detailsWidget).toContainText(name);
                const permissions = await apiJson(api, 'GET', `/api/v1/roles/${uuid}/permissions`);
                expect(permissions.allowAllResources).toBe(false);
                expect(permissions.resources ?? []).toHaveLength(0);
            });
        });

    test('a second role with an existing role name is refused with a message naming the collision',
        testMeta({
            id: 'REG-CFG-07.a', prio: 'P1', issue: 'ilm#427', bug: 'core#2297',
            rule: [
                'duplicate role name: "already exists" (role name unique; a 4xx from auth carries the reason)',
                'core#2297 (open): the auth ENTITY_NOT_UNIQUE surfaces as 500 "Internal server error." on role create',
            ],
        }),
        async ({ signedIn: page, api, own }) => {
            const role = await test.step('Prerequisite: the run role', async () => ensureRunRole(api, own.spec));
            const roles = new RolePage(page);
            const note = 'duplicate role the platform accepted';

            const answer = await test.step('Roles → "+" → Create Role with the run role\'s name → Create', async () => {
                await roles.goToList();
                await roles.openCreateDialog();
                await roles.fillCreateForm({ name: role.name, description: 'duplicate probe', email: `${runName('dup')}@example.test` });
                return submitRecordingByNameOnFailure(
                    { type: 'roles', name: role.name, spec: own.spec, note, lookup: lookupInList(api, '/api/v1/roles') },
                    () => roles.submitCreateForm());
            });
            // Ledger first: a duplicate the platform accepted is this run's object, whatever the status says. The answer may carry no id:
            // the rows of the name are adopted from the list as well.
            own.probe('roles', answer, { name: role.name, note });
            await own.adoptNamed('roles', role.name, { note });

            const rows = await test.step('Exactly one role carries the name (read from the full list)', async () => rowsNamed(api, '/api/v1/roles', role.name));

            await test.step('The duplicate is refused and exactly one role carries the name', async () => {
                // Hard assertions, never masked by the known bug: a duplicate that was accepted fails the test.
                expect(answer.status, 'the duplicate create is refused').toBeGreaterThanOrEqual(400);
                expect(rows.length, 'exactly one role with that name').toBe(1);
            });

            // The known bug covers only the message (500 "Internal server error." instead of naming the collision).
            test.fail(true, 'core#2297: a duplicate role name answers 500 "Internal server error." instead of naming the collision');
            await test.step('The refusal names the collision (known bug)', async () => {
                await roles.assertDuplicateRefused(role.name);
                await roles.createDialog.cancel();
            });
        });

    test('editing a role keeps its locked name, and description and e-mail persist after reopen',
        testMeta({
            id: 'REG-CFG-07.b', prio: 'P1', issue: 'ilm#427',
            rule: ['"a role name cannot change (PUT 200, old name kept)"; RoleForm: name disabled in edit mode'],
        }),
        async ({ signedIn: page, api, own, live }) => {
            const role = await test.step('Prerequisite: a new role of this run (API)', async () => own.role('role-edit'));
            const description = 'edited description';
            const email = `${role.name}-edited@example.test`;
            const roles = new RolePage(page);

            const liveRole = await test.step('Guard: the role is this run\'s own object (live check) before the UI changes it', async () => live('roles', role));

            await test.step('Detail → Edit: the name field is disabled and shows the name', async () => {
                await roles.goToDetail(liveRole.uuid);
                await roles.openEditDialog();
                await roles.assertNameLockedInEdit(liveRole.name);
                await roles.editDialog.cancel();
            });

            await test.step('Edit description and e-mail → Save', async () => {
                const { status } = await roles.editRole({ description, email });
                expect(status, 'PUT /api/v1/roles/{uuid}').toBeLessThan(300);
                await expect(roles.editDialog.dialog).toBeHidden();
            });

            await test.step('Reopen after a reload: new description and e-mail, the same name', async () => {
                await page.reload();
                await expect(roles.detailsWidget).toBeVisible();
                await roles.assertDetailRows({ name: role.name, description });
                await roles.openEditDialog();
                await roles.assertEditFormValues({ name: role.name, description, email });
                await roles.editDialog.cancel();
            });

            await test.step('API: the stored role agrees', async () => {
                const stored = await apiJson(api, 'GET', `/api/v1/roles/${role.uuid}`);
                expect(stored, 'the stored role agrees with the form').toMatchObject({ name: role.name, description, email });
            });
        });

    test('a role deleted in the UI is gone from the roles list and from the API list',
        testMeta({
            id: 'REG-CFG-07.c', prio: 'P1', issue: 'ilm#427',
            rule: ['delete role; absence read from the list: GET by uuid of a deleted role answers 500 (core#2511)'],
        }),
        async ({ signedIn: page, api, own, live }) => {
            const role = await test.step('Prerequisite: a new role of this run (API)', async () => own.role('role-delete'));
            const roles = new RolePage(page);

            const liveRole = await test.step('Guard: the role is this run\'s own object (live check) before the UI deletes it', async () => live('roles', role));

            await test.step('Detail → Delete → "Delete Role" → Delete', async () => {
                await roles.goToDetail(liveRole.uuid);
                const { status } = await roles.deleteFromDetail();
                expect(status, 'DELETE /api/v1/roles/{uuid}').toBeLessThan(300);
                await expect(roles.deleteDialog.dialog).toBeHidden();
            });

            await test.step('API: the roles list no longer names it (the list itself is not empty)', async () => {
                await expect.poll(async () => {
                    const all = await apiJson<Array<{ uuid: string }>>(api, 'GET', '/api/v1/roles');
                    return all.length > 0 && !all.some((r) => r.uuid === role.uuid);
                }, { timeout: LIST_STATE_MS }).toBe(true);
                own.deleted('roles', role, 'deleted through the UI (the behaviour under test)');
            });

            await test.step('UI: the roles list has no row of that name', async () => {
                await roles.reloadList();
                await roles.assertNotListed(role.name);
            });
        });
});
