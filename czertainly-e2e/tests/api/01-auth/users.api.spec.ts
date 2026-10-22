/**
 * API-AUTH-07, API-AUTH-14 — User state model and role membership through the API. ilm#427.
 *
 * WHAT: 1. A user is created disabled; enable and disable (each twice, idempotent) are shown by the answer and by GET; PUT keeps username
 *          and enabled; delete → 204 and the users list no longer names it.
 *       2. Roles and users link from both sides: PATCH replaces the whole list, [] clears it, PUT / DELETE add or remove one role
 *          (repeats are idempotent), PATCH on a role replaces its members, a role listed twice is never a 5xx.
 * WHY: the state model and the membership rules of users and roles; an empty list used to be a 500 (core#1370, core#1371, closed).
 *      A deleted user's detail answers 500 (known bug core#2511), so presence is decided by the list.
 * HOW: own objects only (disabled users, own roles, no permissions, the user cannot sign in); the ledger line is written before any
 *      assertion and the run-end teardown removes them. The hard 200 on a repeated PUT stays: a red there is a suspected defect to
 *      confirm, not a reason to change the oracle.
 */
import { ACCOUNT_STEPS_TEST_MS, MANY_STEPS_TEST_MS } from '../../../utils/regression/timeouts';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { addOwnUserRole, getRole, getUser, removeOwnUserRole, replaceOwnRoleUsers, replaceOwnUserRoles, roleUserUuids, setOwnUserEnabled, updateOwnUser, userRoleUuids, deleteOwnUserOrRole } from '../../../utils/regression/rbac/authApi';
import { testMeta, tags } from '../../../utils/regression/tags';

test.describe('User state model and role membership', { tag: tags.api }, () => {
    test('a user\'s enabled state follows the state model, PUT keeps it and delete removes it from the list',
        testMeta({
            id: 'API-AUTH-07', prio: 'P1', issue: 'ilm#427',
            rule: [
                'PATCH enable / disable: USER:ENABLE, idempotent; disable also ends sessions; delete removes the user, 204',
                'PUT replaces first name, last name, e-mail, description, groups, certificate; username, enabled, systemUser are not touched',
                'ilm#427 step 12 (delete a user); core#2511 (a deleted user\'s detail answers 500: absence is read from the list)',
            ],
        }),
        async ({ api, own }) => {
            test.setTimeout(ACCOUNT_STEPS_TEST_MS);
            const user = await test.step('TMP user created with enabled:false (the API default is disabled too, API-AUTH-08)', async () => own.user('state', { enabled: false }));

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
                const status = await deleteOwnUserOrRole(api, 'users', user, own.spec, 'deleted by API-AUTH-07 (the behaviour under test)');
                expect(status).toBe(204);
            });
        });

    test('roles and users link from both sides: replace, clear, add, remove, repeats idempotent',
        testMeta({
            id: 'API-AUTH-14', prio: 'P1', issue: 'ilm#427',
            rule: [
                'PATCH /v1/users/{u}/roles replaces the whole list; PUT / DELETE /v1/users/{u}/roles/{r} add or remove one; membership is editable from both sides (PATCH /v1/roles/{r}/users replaces, [] clears)',
                'core#1370 / core#1371 (an empty role list answered 500; closed: 200); ilm#427 step 10',
            ],
        }),
        async ({ api, own }) => {
            test.setTimeout(MANY_STEPS_TEST_MS);
            const [r1, r2] = await test.step('Two own roles and one TMP user (no permissions, the user cannot sign in)', async () => [
                await own.role('member-a'),
                await own.role('member-b'),
            ]);
            const user = await own.user('member', { enabled: false });
            const sorted = (...refs: Array<{ uuid: string }>) => refs.map((r) => r.uuid).sort();

            await test.step('PATCH user roles [role 1, role 2] → 200; GET user roles = both; user detail and both role details agree', async () => {
                const r = await replaceOwnUserRoles(api, user, [r1, r2]);
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                expect(await userRoleUuids(api, user.uuid), 'the user lists both roles').toEqual(sorted(r1, r2));
                expect(((await getUser(api, user.uuid)).roles as Array<{ uuid: string }>).map((x) => x.uuid).sort(), 'the user detail names both roles').toEqual(sorted(r1, r2));
                for (const role of [r1, r2]) {
                    expect(((await getRole(api, role.uuid)).users as Array<{ uuid: string }>).map((x) => x.uuid), `the detail of ${role.name} names the user`).toContain(user.uuid);
                    expect(await roleUserUuids(api, role.uuid), `the members of ${role.name} include the user`).toContain(user.uuid);
                }
            });

            await test.step('PATCH user roles [] clears them: 200, not 500 (core#1370 / #1371); the roles no longer list the user', async () => {
                const r = await replaceOwnUserRoles(api, user, []);
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                expect(await userRoleUuids(api, user.uuid)).toEqual([]);
                for (const role of [r1, r2]) expect(await roleUserUuids(api, role.uuid)).not.toContain(user.uuid);
            });

            await test.step('PUT adds one role (repeat → 200, one membership); DELETE removes it (repeat → 200, none)', async () => {
                // The hard 200 on the REPEAT stays (repeated calls are idempotent). A red here is a suspected defect to confirm, not an
                // oracle change: the auth service's `AssignRoleAsync` does `user.Roles.Add(role)` on the loaded collection, so a repeated
                // PUT may insert a duplicate join row and answer 500.
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
                expect(held.every((u) => u === r1.uuid), `only the first role may be held, got ${held.length} role(s)`).toBe(true);
                expect(held.length).toBeLessThanOrEqual(1);
            });
        });
});
