/**
 * auth-roles — role update and delete through the API (auth-rbac area, B3: API-AUTH-19, API-AUTH-20).
 *
 * Own objects only (decision Q1): every role and user here is a NEW run object. A role's NAME cannot change: the contract
 * accepts `name` on `PUT /v1/roles/{uuid}` and ignores it (the auth service's update DTO carries description and e-mail
 * only; core#2297 note, rules D1 / C4 of the "Conflicts" list). Absence of a deleted role is read from the roles LIST (the
 * detail of a deleted role answers 500, known bug core#2511); what happens to a role deleted twice is API-AUTH-12.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { deleteOwn, getRole, listAll, replaceOwnUserRoles, updateOwnRole, userRoleUuids } from '../../utils/regression/authApi';
import { createOwnRole, createOwnUser } from '../../utils/regression/regressionApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC_19 = 'API-AUTH-19';
const SPEC_20 = 'API-AUTH-20';

test.describe('API-AUTH roles: update and delete', { tag: tags.api }, () => {
    test('API-AUTH-19: PUT /v1/roles/{id} changes description and e-mail; the name does not change (also when it names another role)',
        meta({
            id: 'API-AUTH-19', prio: 'P1', issue: 'ilm#427',
            rule: [
                'auth-rbac D1 (the name cannot change: RoleUpdateRequestDto carries description and e-mail only); ilm#427 step 8 ("Role names are not changed by an update, which is the auth service\'s behaviour"); AR-303',
                'developer question A2 (PUT with a different name answers 200 and keeps the old name: intended or should it refuse?) — pinned as today',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(60_000);
            const role = await test.step('Own role R and a second own role S (its name is "taken")', async () => createOwnRole(api, 'update', SPEC_19));
            const taken = await createOwnRole(api, 'taken', SPEC_19);

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

    test('API-AUTH-20: DELETE of an own role answers 204, the roles list no longer names it, a user that held it no longer lists it',
        meta({
            id: 'API-AUTH-20', prio: 'P1', issue: 'ilm#427',
            rule: [
                'auth-rbac D4 (delete role: removes it, clears the authentication and authorization caches; its users lose it); ilm#427 step 9; AR-311',
                'core#2511 (GET by uuid of a deleted role answers 500, not 404): absence is read from GET /v1/roles',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const role = await test.step('Own role and a TMP user that holds it', async () => createOwnRole(api, 'delete', SPEC_20));
            const user = await createOwnUser(api, 'role-holder', SPEC_20, { enabled: false });

            await test.step('Precondition: the user holds the role', async () => {
                expect((await replaceOwnUserRoles(api, user, [role])).status).toBe(200);
                expect(await userRoleUuids(api, user.uuid)).toEqual([role.uuid]);
            });

            await test.step('DELETE → 204; the roles list (not empty) no longer names the role', async () => {
                const status = await deleteOwn(api, 'roles', role, SPEC_20, 'deleted by API-AUTH-20 (the behaviour under test)');
                expect(status).toBe(204);
            });

            await test.step('The user no longer lists the deleted role (and the call is no 5xx)', async () => {
                const res = await api.get(`/api/v1/users/${user.uuid}/roles`);
                expect(res.status(), (await res.text()).slice(0, 300)).toBe(200);
                expect(((await res.json()) as Array<{ uuid: string }>).map((r) => r.uuid)).not.toContain(role.uuid);
            });
        });
});
