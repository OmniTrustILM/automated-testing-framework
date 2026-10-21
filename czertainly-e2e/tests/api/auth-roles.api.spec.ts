/**
 * Role update and delete through the API. A role's name cannot change: `PUT /v1/roles/{uuid}` accepts `name` and ignores it
 * (the update carries description and e-mail only). A deleted role is read as absent from the roles list, because its detail
 * answers 500 (known bug core#2511). Own objects only: every role and user here is a new run object.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { getRole, listAll, replaceOwnUserRoles, updateOwnRole, userRoleUuids, deleteOwnUserOrRole } from '../../utils/regression/rbac/authApi';
import { createOwnRole } from '../../utils/regression/ownRoles';
import { createOwnUser } from '../../utils/regression/ownUsers';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC_19 = 'API-AUTH-19';
const SPEC_20 = 'API-AUTH-20';

test.describe('Role update and delete', { tag: tags.api }, () => {
    test('a role update changes description and e-mail but never the name',
        testMeta({
            id: 'API-AUTH-19', prio: 'P1', issue: 'ilm#427',
            rule: [
                'the name cannot change: RoleUpdateRequestDto carries description and e-mail only; ilm#427 step 8 ("Role names are not changed by an update, which is the auth service\'s behaviour")',
                'developer question A2 (PUT with a different name answers 200 and keeps the old name: intended or should it refuse?) — pinned as today',
                'PUT /v1/roles/{id}; the name stays also when the body names another role',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(60_000);
            const role = await test.step('Own role R and a second own role S (its name is "taken")', async () => createOwnRole(api, SPEC_19, 'update'));
            const taken = await createOwnRole(api, SPEC_19, 'taken');

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
        async ({ api }) => {
            test.setTimeout(90_000);
            const role = await test.step('Own role and a TMP user that holds it', async () => createOwnRole(api, SPEC_20, 'delete'));
            const user = await createOwnUser(api, SPEC_20, 'role-holder', { enabled: false });

            await test.step('Precondition: the user holds the role', async () => {
                expect((await replaceOwnUserRoles(api, user, [role])).status).toBe(200);
                expect(await userRoleUuids(api, user.uuid)).toEqual([role.uuid]);
            });

            await test.step('DELETE → 204; the roles list (not empty) no longer names the role', async () => {
                const status = await deleteOwnUserOrRole(api, 'roles', role, SPEC_20, 'deleted by API-AUTH-20 (the behaviour under test)');
                expect(status).toBe(204);
            });

            await test.step('The user no longer lists the deleted role (and the call is no 5xx)', async () => {
                const res = await api.get(`/api/v1/users/${user.uuid}/roles`);
                expect(res.status(), (await res.text()).slice(0, 300)).toBe(200);
                expect(((await res.json()) as Array<{ uuid: string }>).map((r) => r.uuid)).not.toContain(role.uuid);
            });
        });
});
