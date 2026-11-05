/**
 * API-AUTH-19, API-AUTH-20 — Role update and delete through the API (ilm#427).
 *
 * `PUT /v1/roles/{uuid}` accepts `name` and ignores it. A deleted role's detail answers 500 (core#2511), so absence is
 * read from the list. Every role and user is a new run object; deletes go through the own-object helper.
 */
import { ACCOUNT_STEPS_TEST_MS, SEVERAL_STEPS_TEST_MS } from '../../../utils/regression/timeouts';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { getRole, listAll, replaceOwnUserRoles, updateOwnRole, userRoleUuids, deleteOwnUserOrRole } from '../../../utils/regression/rbac/authApi';
import { testMeta, tags } from '../../../utils/regression/tags';

test.describe('Role update and delete', { tag: tags.api }, () => {
    test('a role update changes description and e-mail but never the name',
        testMeta({
            id: 'API-AUTH-19', prio: 'P1', issue: 'ilm#427',
            rule: [
                'the name cannot change: RoleUpdateRequestDto carries description and e-mail only; ilm#427 step 8 ("Role names are not changed by an update, which is the auth service\'s behaviour")',
                'a PUT with a different name answers 200 and keeps the old name; whether it should refuse is an open product question, so today\'s behaviour is asserted',
                'PUT /v1/roles/{id}; the name stays also when the body names another role',
            ],
        }),
        async ({ api, own }) => {
            test.setTimeout(SEVERAL_STEPS_TEST_MS);
            const role = await test.step('Own role R and a second own role S (its name is "taken")', async () => own.role('update'));
            const taken = await own.role('taken');

            await test.step('PUT R with another name, a new description and e-mail → 200; description and e-mail are new, the name is unchanged', async () => {
                const r = await updateOwnRole(api, role, { name: `${role.name}-renamed`, description: 'API-AUTH-19 new description', email: `${role.name}@example.test` });
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                const stored = await getRole(api, role.uuid);
                expect(stored.description).toBe('API-AUTH-19 new description');
                expect(stored.email).toBe(`${role.name}@example.test`);
                expect(stored.name, 'the name is immutable').toBe(role.name);
            });

            await test.step('PUT R with the name of S → 200, no rename of R, S untouched, no 500', async () => {
                const r = await updateOwnRole(api, role, { name: taken.name, description: 'API-AUTH-19 second description' });
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                expect((await getRole(api, role.uuid)).name, 'R keeps its own name').toBe(role.name);
                expect((await getRole(api, taken.uuid)).name, 'S keeps its name').toBe(taken.name);
                const named = (await listAll(api, 'roles')).filter((x) => x.name === taken.name);
                expect(named.map((x) => x.uuid), 'exactly one role carries the taken name').toEqual([taken.uuid]);
            });
        });

    test('deleting an own role answers 204 and removes it from the roles list and from its users',
        testMeta({
            id: 'API-AUTH-20', prio: 'P1', issue: 'ilm#427',
            rule: [
                'delete role: removes it, clears the authentication and authorization caches; its users lose it; ilm#427 step 9',
                'core#2511 (GET by uuid of a deleted role answers 500, not 404): absence is read from GET /v1/roles',
            ],
        }),
        async ({ api, own }) => {
            test.setTimeout(ACCOUNT_STEPS_TEST_MS);
            const role = await test.step('Own role and a TMP user that holds it', async () => own.role('delete'));
            const user = await own.user('role-holder', { enabled: false });

            await test.step('Precondition: the user holds the role', async () => {
                expect((await replaceOwnUserRoles(api, user, [role])).status).toBe(200);
                expect(await userRoleUuids(api, user.uuid)).toEqual([role.uuid]);
            });

            await test.step('DELETE → 204; the roles list (not empty) no longer names the role', async () => {
                const status = await deleteOwnUserOrRole(api, 'roles', role, own.spec, 'deleted by API-AUTH-20 (the behaviour under test)');
                expect(status).toBe(204);
            });

            await test.step('The user no longer lists the deleted role (and the call is no 5xx)', async () => {
                expect(await userRoleUuids(api, user.uuid), 'the user no longer lists the deleted role').not.toContain(role.uuid);
            });
        });
});
