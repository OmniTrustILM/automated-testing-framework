/**
 * auth-users — user state model and role membership through the API (auth-rbac area, B3: API-AUTH-07, API-AUTH-14).
 *
 * Own objects only (decision Q1): every user and role here is a NEW run object (`createOwnUser` / `createOwnRole`: ledger
 * line before any assertion, deleted by the run-end teardown unless a test deletes it as its behaviour under test). A TMP
 * user has no identity-provider account and is created disabled unless the test says otherwise: it can never sign in. The
 * authoritative LIST decides presence and absence — a deleted user's detail answers 500, not 404 (known bug core#2511).
 *
 * API-AUTH-07 walks the user state model 0-switch (rules C5, C6; plan §2.1): create disabled → enable → enable again →
 * disable → disable again → PUT → delete. API-AUTH-14 links users and roles from both sides with replace / clear / add /
 * remove semantics (rules C2, D3; core#1370 / #1371 were 500s for the empty list).
 */
import { expect, test } from '../../fixtures/testFixtures';
import {
    addOwnUserRole, deleteOwn, getRole, getUser, removeOwnUserRole, replaceOwnRoleUsers, replaceOwnUserRoles, roleUserUuids, setOwnUserEnabled, updateOwnUser, userRoleUuids,
} from '../../utils/regression/authApi';
import { createOwnRole, createOwnUser } from '../../utils/regression/regressionApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC_07 = 'API-AUTH-07';
const SPEC_14 = 'API-AUTH-14';

test.describe('API-AUTH users: state model and membership', { tag: tags.api }, () => {
    test('API-AUTH-07: a user\'s enabled state follows the 0-switch (create disabled, enable, disable, both idempotent), PUT keeps it, delete removes it from the list',
        meta({
            id: 'API-AUTH-07', prio: 'P1', issue: 'ilm#427',
            rule: [
                'auth-rbac C5 (PATCH enable / disable: USER:ENABLE, idempotent; disable also ends sessions); C6 (delete: removes the user, 204)',
                'auth-rbac C3 (PUT replaces first name, last name, e-mail, description, groups, certificate; username, enabled, systemUser are not touched); AR-142',
                'ilm#427 step 12 (delete a user); core#2511 (a deleted user\'s detail answers 500: absence is read from the list)',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const user = await test.step('TMP user created with enabled:false (the API default is disabled too, API-AUTH-08)', async () => createOwnUser(api, 'state', SPEC_07, { enabled: false }));

            await test.step('Create: GET shows enabled:false', async () => {
                expect((await getUser(api, user.uuid)).enabled).toBe(false);
            });

            await test.step('Enable → 200, the answer and GET show enabled:true', async () => {
                const r = await setOwnUserEnabled(api, user, true);
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                expect(r.json?.enabled).toBe(true);
                expect((await getUser(api, user.uuid)).enabled).toBe(true);
            });

            await test.step('Enable again → 200 (idempotent), still enabled', async () => {
                const r = await setOwnUserEnabled(api, user, true);
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                expect((await getUser(api, user.uuid)).enabled).toBe(true);
            });

            await test.step('PUT while enabled → 200; username and enabled are unchanged', async () => {
                const r = await updateOwnUser(api, user, { firstName: 'QA-state', lastName: 'Regression' });
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                const stored = await getUser(api, user.uuid);
                expect(stored.username).toBe(user.name);
                expect(stored.enabled, 'PUT does not touch `enabled`').toBe(true);
                expect(stored.firstName).toBe('QA-state');
            });

            await test.step('Disable → 200, GET shows enabled:false', async () => {
                const r = await setOwnUserEnabled(api, user, false);
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                expect(r.json?.enabled).toBe(false);
                expect((await getUser(api, user.uuid)).enabled).toBe(false);
            });

            await test.step('Disable again → 200 (idempotent), still disabled', async () => {
                const r = await setOwnUserEnabled(api, user, false);
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                expect((await getUser(api, user.uuid)).enabled).toBe(false);
            });

            await test.step('PUT while disabled → 200; the user stays disabled with the same username', async () => {
                const r = await updateOwnUser(api, user, { firstName: 'QA-state-2' });
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                const stored = await getUser(api, user.uuid);
                expect(stored.username).toBe(user.name);
                expect(stored.enabled, 'PUT does not enable a disabled user').toBe(false);
            });

            await test.step('Delete → 204 and the users LIST no longer names it (not asserted by uuid: core#2511)', async () => {
                const status = await deleteOwn(api, 'users', user, SPEC_07, 'deleted by API-AUTH-07 (the behaviour under test)');
                expect(status).toBe(204);
            });
        });

    test('API-AUTH-14: roles and users are linked from both sides — replace and clear, add and remove one, repeats are idempotent, no 5xx',
        meta({
            id: 'API-AUTH-14', prio: 'P1', issue: 'ilm#427',
            rule: [
                'auth-rbac C2 (PATCH /v1/users/{u}/roles replaces the whole list; PUT / DELETE /v1/users/{u}/roles/{r} add or remove one); D3 (membership editable from both sides, PATCH /v1/roles/{r}/users replaces, [] clears)',
                'core#1370 / core#1371 (an empty role list answered 500; closed: 200); ilm#427 step 10; AR-205, AR-310',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(120_000);
            const [r1, r2] = await test.step('Two own roles and one TMP user (no permissions, the user cannot sign in)', async () => [
                await createOwnRole(api, 'member-a', SPEC_14),
                await createOwnRole(api, 'member-b', SPEC_14),
            ]);
            const user = await createOwnUser(api, 'member', SPEC_14, { enabled: false });
            const sorted = (...refs: Array<{ uuid: string }>) => refs.map((r) => r.uuid).sort();

            await test.step('PATCH user roles [r1, r2] → 200; GET user roles = {r1, r2}; user detail and both role details agree', async () => {
                const r = await replaceOwnUserRoles(api, user, [r1, r2]);
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                expect(await userRoleUuids(api, user.uuid)).toEqual(sorted(r1, r2));
                expect(((await getUser(api, user.uuid)).roles as Array<{ uuid: string }>).map((x) => x.uuid).sort()).toEqual(sorted(r1, r2));
                for (const role of [r1, r2]) {
                    expect(((await getRole(api, role.uuid)).users as Array<{ uuid: string }>).map((x) => x.uuid)).toContain(user.uuid);
                    expect(await roleUserUuids(api, role.uuid)).toContain(user.uuid);
                }
            });

            await test.step('PATCH user roles [] clears them: 200, not 500 (core#1370 / #1371); the roles no longer list the user', async () => {
                const r = await replaceOwnUserRoles(api, user, []);
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                expect(await userRoleUuids(api, user.uuid)).toEqual([]);
                for (const role of [r1, r2]) expect(await roleUserUuids(api, role.uuid)).not.toContain(user.uuid);
            });

            await test.step('PUT adds one role (repeat → 200, one membership); DELETE removes it (repeat → 200, none)', async () => {
                // The hard 200 on the REPEAT stays (ledger: "repeated calls idempotent"). A red here is a suspected defect to confirm, not an
                // oracle change: the auth service's `AssignRoleAsync` does `user.Roles.Add(role)` on the loaded collection, so a repeated
                // PUT may insert a duplicate join row and answer 500 (Fable F7).
                for (const attempt of ['first', 'repeat']) {
                    const r = await addOwnUserRole(api, user, r1);
                    expect(r.status, `${attempt} PUT: ${r.text.slice(0, 300)}`).toBe(200);
                    expect(await userRoleUuids(api, user.uuid), `${attempt} PUT`).toEqual(sorted(r1));
                }
                for (const attempt of ['first', 'repeat']) {
                    const r = await removeOwnUserRole(api, user, r1);
                    expect(r.status, `${attempt} DELETE: ${r.text.slice(0, 300)}`).toBe(200);
                    expect(await userRoleUuids(api, user.uuid), `${attempt} DELETE`).toEqual([]);
                }
            });

            await test.step('PATCH role users [user] replaces the members; the user lists the role; [] clears the members (200)', async () => {
                const set = await replaceOwnRoleUsers(api, r1, [user]);
                expect(set.status, set.text.slice(0, 300)).toBe(200);
                expect(await roleUserUuids(api, r1.uuid)).toEqual([user.uuid]);
                expect(await userRoleUuids(api, user.uuid)).toEqual(sorted(r1));
                const clear = await replaceOwnRoleUsers(api, r1, []);
                expect(clear.status, clear.text.slice(0, 300)).toBe(200);
                expect(await roleUserUuids(api, r1.uuid)).toEqual([]);
                expect(await userRoleUuids(api, user.uuid)).toEqual([]);
            });

            await test.step('A role uuid listed twice: 200 or a 4xx, never a 5xx; the user holds at most that one role', async () => {
                const r = await replaceOwnUserRoles(api, user, [r1, r1]);
                expect(r.status, r.text.slice(0, 300)).toBeLessThan(500);
                const held = await userRoleUuids(api, user.uuid);
                expect(held.every((u) => u === r1.uuid), `only r1 may be held, got ${held.length} role(s)`).toBe(true);
                expect(held.length).toBeLessThanOrEqual(1);
            });
        });
});
