/**
 * REG-CFG-07 — roles in the UI (release checklist: Configuration 7, and the role rows of the authorization area): create,
 * a duplicate name refused (known bug: the message does not name the collision), edit with the name locked, delete.
 * Edited and deleted roles are NEW roles of the run, never the shared run role or a role from before the run; the browser
 * is not behind the API guard, so `assertOwnLive` runs first. A deleted role's absence is read from the list.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { RolePage } from '../../pages/RolePage';
import { assertOwnLive, checkOwnership } from '../../utils/regression/ledger/ownership';
import { apiJson } from '../../utils/regression/apiReads';
import { createOwnRole, ensureRunRole } from '../../utils/regression/ownRoles';
import { findByName, rowsNamed } from '../../utils/regression/listReads';
import { nameFor, runName, updateRunState } from '../../utils/regression/ledger/runState';
import { recordCreated, recordDeleted } from '../../utils/regression/ledger/ledger';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-CFG-07';

test.describe('Role configuration', { tag: tags.regression }, () => {
    test('a role created in the UI is listed, is not a system role and has no permissions yet',
        testMeta({
            id: 'REG-CFG-07', prio: 'P1', issue: 'ilm#427',
            rule: ['release checklist Configuration 7: create a role with a name, description and e-mail; a new role has no users and no permissions'],
        }),
        async ({ page, api, env }) => {
            const { name, becomesRunObject } = nameFor('role', 'role');
            const rolePage = new RolePage(page);

            await test.step('Roles → "+" → Create Role', async () => {
                await loginAsSmokeUser(page, env);
                await rolePage.goToList();
                await rolePage.openCreateDialog();
                await rolePage.fillCreateForm({ name, description: 'Main-functionality regression operator', email: `${name}@example.test` });
            });

            const uuid = await test.step('Create → the role exists (not a system role)', async () => {
                const { status } = await rolePage.submitCreateForm();
                const created = status < 300 ? await findByName(api, '/api/v1/roles', name) : undefined;
                // Ledger before assertion: the role exists once the POST answered.
                if (created) {
                    const own = recordCreated('roles', { uuid: created.uuid, name }, SPEC);
                    if (becomesRunObject) updateRunState({ role: own });
                }
                expect(status, 'POST /api/v1/roles').toBeLessThan(300);
                expect(created?.name, 'the role is listed').toBe(name);
                await expect(rolePage.createDialog.dialog).toBeHidden();
                expect(created!.systemRole).toBe(false);
                return created!.uuid as string;
            });

            await test.step('Detail page: Role Details, no assigned users, no permissions yet', async () => {
                await rolePage.goToDetail(uuid);
                await expect(rolePage.detailsWidget).toContainText(name);
                const perms = await apiJson(api, 'GET', `/api/v1/roles/${uuid}/permissions`);
                expect(perms.allowAllResources).toBe(false);
                expect(perms.resources ?? []).toHaveLength(0);
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
        async ({ page, api, env }) => {
            const role = await test.step('Prerequisite: the run role', async () => ensureRunRole(api, SPEC));
            const rolePage = new RolePage(page);

            const status = await test.step('Roles → "+" → Create Role with the run role\'s name → Create', async () => {
                await loginAsSmokeUser(page, env);
                await rolePage.goToList();
                await rolePage.openCreateDialog();
                await rolePage.fillCreateForm({ name: role.name, description: 'REG-CFG-07.a duplicate probe', email: `${runName('dup')}@example.test` });
                return (await rolePage.submitCreateForm()).status;
            });

            const rows = await test.step('Ledger before assertion: a duplicate the platform accepted is this run\'s object', async () => {
                const named = await rowsNamed(api, '/api/v1/roles', role.name);
                for (const r of named) {
                    if (!checkOwnership({ uuid: String(r.uuid) }).own) recordCreated('roles', { uuid: String(r.uuid), name: role.name }, SPEC, 'duplicate role the platform accepted (REG-CFG-07.a)');
                }
                return named;
            });

            await test.step('The duplicate is refused and exactly one role carries the name', async () => {
                // Hard assertions, never masked by the known bug: a duplicate that was accepted fails the test.
                expect(status, 'the duplicate create is refused').toBeGreaterThanOrEqual(400);
                expect(rows.length, 'exactly one role with that name').toBe(1);
            });

            // The known bug covers only the message (500 "Internal server error." instead of naming the collision).
            test.fail(true, 'core#2297: a duplicate role name answers 500 "Internal server error." instead of naming the collision');
            await test.step('The refusal names the collision (known bug)', async () => {
                await rolePage.assertDuplicateRefused(role.name);
                await rolePage.createDialog.cancel();
            });
        });

    test('editing a role keeps its locked name, and description and e-mail persist after reopen',
        testMeta({
            id: 'REG-CFG-07.b', prio: 'P1', issue: 'ilm#427',
            rule: ['"a role name cannot change (PUT 200, old name kept)"; RoleForm: name disabled in edit mode'],
        }),
        async ({ page, api, env }) => {
            const role = await test.step('Prerequisite: a new role of this run (API)', async () => createOwnRole(api, SPEC, 'role-edit'));
            const description = 'REG-CFG-07.b edited description';
            const email = `${role.name}-edited@example.test`;
            const rolePage = new RolePage(page);

            await test.step('Guard: the role is this run\'s own object (live check) before the UI changes it', async () => {
                await assertOwnLive(api, 'roles', role, 'REG-CFG-07.b UI edit');
            });

            await test.step('Detail → Edit: the name field is disabled and shows the name', async () => {
                await loginAsSmokeUser(page, env);
                await rolePage.goToDetail(role.uuid);
                await rolePage.openEditDialog();
                await rolePage.assertNameLockedInEdit(role.name);
                await rolePage.editDialog.cancel();
            });

            await test.step('Edit description and e-mail → Save', async () => {
                const { status } = await rolePage.editRole({ description, email });
                expect(status, 'PUT /api/v1/roles/{uuid}').toBeLessThan(300);
                await expect(rolePage.editDialog.dialog).toBeHidden();
            });

            await test.step('Reopen after a reload: new description and e-mail, the same name', async () => {
                await page.reload();
                await expect(rolePage.detailsWidget).toBeVisible();
                await rolePage.assertDetailRows({ name: role.name, description });
                await rolePage.openEditDialog();
                await rolePage.assertEditFormValues({ name: role.name, description, email });
                await rolePage.editDialog.cancel();
            });

            await test.step('API: the stored role agrees', async () => {
                const stored = await apiJson(api, 'GET', `/api/v1/roles/${role.uuid}`);
                expect(stored.name).toBe(role.name);
                expect(stored.description).toBe(description);
                expect(stored.email).toBe(email);
            });
        });

    test('a role deleted in the UI is gone from the roles list and from the API list',
        testMeta({
            id: 'REG-CFG-07.c', prio: 'P1', issue: 'ilm#427',
            rule: ['delete role; absence read from the list: GET by uuid of a deleted role answers 500 (core#2511)'],
        }),
        async ({ page, api, env }) => {
            const role = await test.step('Prerequisite: a new role of this run (API)', async () => createOwnRole(api, SPEC, 'role-delete'));
            const rolePage = new RolePage(page);

            await test.step('Guard: the role is this run\'s own object (live check) before the UI deletes it', async () => {
                await assertOwnLive(api, 'roles', role, 'REG-CFG-07.c UI delete');
            });

            await test.step('Detail → Delete → "Delete Role" → Delete', async () => {
                await loginAsSmokeUser(page, env);
                await rolePage.goToDetail(role.uuid);
                const { status } = await rolePage.deleteRoleFromDetail();
                expect(status, 'DELETE /api/v1/roles/{uuid}').toBeLessThan(300);
                await expect(rolePage.deleteDialog.dialog).toBeHidden();
            });

            await test.step('API: the roles list no longer names it (the list itself is not empty)', async () => {
                await expect.poll(async () => {
                    const all = await apiJson<Array<{ uuid: string }>>(api, 'GET', '/api/v1/roles');
                    return all.length > 0 && !all.some((r) => r.uuid === role.uuid);
                }, { timeout: 30_000 }).toBe(true);
                recordDeleted('roles', role, SPEC, 'deleted through the UI (REG-CFG-07.c, the behaviour under test)');
            });

            await test.step('UI: the roles list has no row of that name', async () => {
                await rolePage.reloadList();
                await rolePage.assertNotListed(role.name);
            });
        });
});
