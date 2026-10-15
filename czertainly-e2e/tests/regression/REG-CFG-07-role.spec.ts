/**
 * REG-CFG-07 — Create role (release checklist: Configuration 7).
 *
 * Flow: Roles → "+" → Create Role → name, description, e-mail → Create → the role exists, is not a system role,
 * has no users and no permissions yet.
 *
 * B1 (auth-rbac rows, ilm#427): REG-CFG-07.a duplicate name (known bug core#2297: `test.fail()`), .b edit (the name is
 * locked), .c delete in the UI. The edited / deleted roles are NEW roles of the run (`createOwnRole`, recorded right
 * after the create), never the run's shared role and never a role that existed before the run; before the browser
 * changes one, `assertOwnLive` proves it is this run's (the UI is not behind the API guard; decision Q1). A role the UI
 * deleted gets its `deleted` ledger line once the authoritative LIST no longer names it (a deleted role's detail answers
 * 500, core#2511). Every other run role is removed by the run-end teardown. Page actions: pages/RolePage.ts (m4).
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { RolePage } from '../../pages/RolePage';
import { assertOwnLive, ownership } from '../../utils/regression/ownObjects';
import { apiJson, createOwnRole, ensureRole, findByName, listRowsNamed } from '../../utils/regression/regressionApi';
import { nameFor, recordCreated, recordDeleted, regName, updateState } from '../../utils/regression/regressionRun';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-CFG-07';

test.describe('@regression REG-CFG-07 role', () => {
    test('create a role through the UI', async ({ page, api, env }) => {
        const { name, becomesRunObject } = nameFor('role', 'role');
        const rolePage = new RolePage(page);

        await test.step('Roles → "+" → Create Role', async () => {
            await loginAsSmokeUser(page, env);
            await rolePage.goToList();
            await rolePage.openCreateDialog();
            await rolePage.fillCreate({ name, description: 'Main-functionality regression operator', email: `${name}@example.test` });
        });

        const uuid = await test.step('Create → the role exists (not a system role)', async () => {
            const { status } = await rolePage.submitCreate();
            const created = status < 300 ? await findByName(api, '/api/v1/roles', name) : undefined;
            // Ledger before assertion: the role exists once the POST answered.
            if (created) {
                const own = recordCreated('roles', { uuid: created.uuid, name }, SPEC);
                if (becomesRunObject) updateState({ role: own });
            }
            expect(status, 'POST /api/v1/roles').toBeLessThan(300);
            expect(created, 'the role is listed').toBeTruthy();
            await expect(rolePage.createDialog).toBeHidden();
            expect(created!.systemRole).toBe(false);
            return created!.uuid as string;
        });

        await test.step('Detail page: Role Details, no assigned users, no permissions yet', async () => {
            await rolePage.openDetail(uuid);
            await expect(rolePage.detailsWidget).toContainText(name);
            const perms = await apiJson(api, 'GET', `/api/v1/roles/${uuid}/permissions`);
            expect(perms.allowAllResources).toBe(false);
            expect(perms.resources ?? []).toHaveLength(0);
        });
    });

    test('REG-CFG-07.a: a second role with the run role\'s name is refused with a message that names the collision',
        meta({
            id: 'REG-CFG-07.a', prio: 'P1', issue: 'ilm#427', bug: 'core#2297',
            rule: [
                'release plan CFG-07 N1 (duplicate role name: "already exists"); auth-rbac D1 (role name unique), G4 (4xx from auth carries the reason)',
                'core#2297 (open): the auth ENTITY_NOT_UNIQUE surfaces as 500 "Internal server error." on role create',
            ],
        }),
        async ({ page, api, env }) => {
            const role = await test.step('Prerequisite: the run role', async () => ensureRole(api, SPEC));
            const rolePage = new RolePage(page);

            const status = await test.step('Roles → "+" → Create Role with the run role\'s name → Create', async () => {
                await loginAsSmokeUser(page, env);
                await rolePage.goToList();
                await rolePage.openCreateDialog();
                await rolePage.fillCreate({ name: role.name, description: 'REG-CFG-07.a duplicate probe', email: `${regName('dup')}@example.test` });
                return (await rolePage.submitCreate()).status;
            });

            const rows = await test.step('Ledger before assertion: a duplicate the platform accepted is this run\'s object', async () => {
                const named = await listRowsNamed(api, '/api/v1/roles', role.name);
                for (const r of named) {
                    if (!ownership({ uuid: String(r.uuid) }).own) recordCreated('roles', { uuid: String(r.uuid), name: role.name }, SPEC, 'duplicate role the platform accepted (REG-CFG-07.a)');
                }
                return named;
            });

            await test.step('The duplicate is refused and exactly one role carries the name', async () => {
                // Hard assertions, never masked by the known bug: a duplicate that was accepted fails the test.
                expect(status, 'the duplicate create is refused').toBeGreaterThanOrEqual(400);
                expect(rows.length, 'exactly one role with that name').toBe(1);
            });

            // Sonnet F6: the known bug covers only the message (500 "Internal server error." instead of naming the collision).
            test.fail(true, 'core#2297: a duplicate role name answers 500 "Internal server error." instead of naming the collision');
            await test.step('The refusal names the collision (known bug core#2297)', async () => {
                await rolePage.assertDuplicateRefused(role.name);
                await rolePage.cancelDialog(rolePage.createDialog);
            });
        });

    test('REG-CFG-07.b: editing a role keeps its name (field disabled); description and e-mail persist after reopen',
        meta({
            id: 'REG-CFG-07.b', prio: 'P1', issue: 'ilm#427',
            rule: ['ilm#427 step 8; auth-rbac D1 ("a role name cannot change (PUT 200, old name kept)"); RoleForm: name disabled in edit mode'],
        }),
        async ({ page, api, env }) => {
            const role = await test.step('Prerequisite: a new role of this run (API)', async () => createOwnRole(api, 'role-edit', SPEC));
            const description = 'REG-CFG-07.b edited description';
            const email = `${role.name}-edited@example.test`;
            const rolePage = new RolePage(page);

            await test.step('Guard: the role is this run\'s own object (live check) before the UI changes it', async () => {
                await assertOwnLive(api, 'roles', role, 'REG-CFG-07.b UI edit');
            });

            await test.step('Detail → Edit: the name field is disabled and shows the name', async () => {
                await loginAsSmokeUser(page, env);
                await rolePage.openDetail(role.uuid);
                await rolePage.openEditDialog();
                await rolePage.assertNameLockedInEdit(role.name);
                await rolePage.cancelDialog(rolePage.editDialog);
            });

            await test.step('Edit description and e-mail → Save', async () => {
                await rolePage.edit({ description, email });
            });

            await test.step('Reopen after a reload: new description and e-mail, the same name', async () => {
                await rolePage.assertEdited({ name: role.name, description, email });
            });

            await test.step('API: the stored role agrees', async () => {
                const stored = await apiJson(api, 'GET', `/api/v1/roles/${role.uuid}`);
                expect(stored.name).toBe(role.name);
                expect(stored.description).toBe(description);
                expect(stored.email).toBe(email);
            });
        });

    test('REG-CFG-07.c: deleting an own role in the UI removes it from the roles list and from the API list',
        meta({
            id: 'REG-CFG-07.c', prio: 'P1', issue: 'ilm#427',
            rule: ['ilm#427 step 9; auth-rbac D4 (delete role); absence read from the list: GET by uuid of a deleted role answers 500 (core#2511)'],
        }),
        async ({ page, api, env }) => {
            const role = await test.step('Prerequisite: a new role of this run (API)', async () => createOwnRole(api, 'role-delete', SPEC));
            const rolePage = new RolePage(page);

            await test.step('Guard: the role is this run\'s own object (live check) before the UI deletes it', async () => {
                await assertOwnLive(api, 'roles', role, 'REG-CFG-07.c UI delete');
            });

            await test.step('Detail → Delete → "Delete Role" → Delete', async () => {
                await loginAsSmokeUser(page, env);
                await rolePage.openDetail(role.uuid);
                await rolePage.deleteFromDetail();
            });

            await test.step('API: the roles list no longer names it (the list itself is not empty)', async () => {
                await expect.poll(async () => {
                    const all = await apiJson<Array<{ uuid: string }>>(api, 'GET', '/api/v1/roles');
                    return all.length > 0 && !all.some((r) => r.uuid === role.uuid);
                }, { timeout: 30_000 }).toBe(true);
                recordDeleted('roles', role, SPEC, 'deleted through the UI (REG-CFG-07.c, the behaviour under test)');
            });

            await test.step('UI: the roles list has no row of that name', async () => {
                await rolePage.assertGone(role.name);
            });
        });
});
