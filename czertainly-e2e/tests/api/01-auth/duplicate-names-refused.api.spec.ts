/**
 * API-AUTH-11, API-AUTH-18 — Duplicate user and role names are refused with a conflict (ilm#427).
 *
 * Both answers should be a 409 naming the user or role; today they are a 500 (core#2297, open). `test.fail()` covers only
 * the status and message step, so the test turns red once the bug is fixed.
 * Uses own run objects; `admin` and `auditor` are only read, and a system role the build lacks is skipped, never created.
 * An accepted duplicate is ledgered before the assertion.
 */
import { ACCOUNT_STEPS_TEST_MS, SEVERAL_STEPS_TEST_MS } from '../../../utils/regression/timeouts';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { listAll, probeRole, probeUser } from '../../../utils/regression/rbac/authApi';
import { usersOrRolesNamed } from '../../../utils/regression/listReads';
import { expectMessageObject } from '../../../utils/regression/errorContract';
import { testMeta, tags } from '../../../utils/regression/tags';

test.describe('Duplicate user and role names', { tag: tags.api }, () => {
    test('a duplicate username is refused with a conflict naming the username, not a 500',
        testMeta({
            id: 'API-AUTH-11', prio: 'P1', issue: 'ilm#427', bug: 'core#2297',
            rule: [
                'duplicate username: auth 400 ENTITY_NOT_UNIQUE "User with username \'%s\' already exists"; auth 4xx are not translated (core#2297, open)',
                'the release checklist expects "User with username ... already exists" in a 409 {message}',
            ],
        }),
        async ({ api, own }) => {
            test.setTimeout(SEVERAL_STEPS_TEST_MS);
            const user = await test.step('Own user (disabled TMP user)', async () => own.user('dup', { enabled: false }));

            const second = await test.step('POST the same username again (an accepted duplicate is recorded first)', async () => probeUser(api, own.spec, user.name));

            await test.step('Hard assertions (never masked by the known bug): refused, exactly one user with that username', async () => {
                expect(second.status, 'the duplicate create is refused').toBeGreaterThanOrEqual(400);
                const named = await usersOrRolesNamed(api, 'users', user.name);
                expect(named.map((u) => u.uuid), 'exactly one user carries the username').toEqual([user.uuid]);
            });

            // The known bug covers only the answer (500 "Internal server error." instead of a conflict naming the username).
            test.fail(true, 'core#2297: a duplicate username answers 500 "Internal server error." instead of a 409 naming the username');
            await test.step('A 409 {message} names the username and says it already exists (known bug core#2297)', async () => {
                expect(second.status).toBe(409);
                const message = expectMessageObject(second.text);
                expect(message).toContain(user.name);
                expect(message).toMatch(/already exists/i);
            });
        });

    test('a duplicate role name (own role, admin, auditor) is refused with a conflict, not a 500',
        testMeta({
            id: 'API-AUTH-18', prio: 'P1', issue: 'ilm#427', bug: 'core#2297',
            rule: [
                'the role name is unique, also against system role names: auth 400 ENTITY_NOT_UNIQUE "Role with name \'%s\' already exists" (core#2297, open)',
                'the release checklist expects "Role with name ... already exists" in a 409 {message}',
            ],
        }),
        async ({ api, own }, testInfo) => {
            test.setTimeout(ACCOUNT_STEPS_TEST_MS);
            const role = await test.step('Own role', async () => own.role('dup'));
            // Only a name that exists RIGHT NOW is a duplicate: a build without the `auditor` system role (before core#1911) would
            // CREATE a role named `auditor` here, which carries no run prefix and could not be cleaned up.
            const candidates = [role.name, 'admin', 'auditor'];
            const before = await test.step('Before: which of the names exist (the system ones are read, never touched)', async () => {
                const all = await listAll(api, 'roles');
                return new Map(candidates.map((n) => [n, all.filter((r) => r.name === n).map((r) => String(r.uuid))]));
            });
            expect(before.get(role.name), 'the own role exists once').toEqual([role.uuid]);
            const names = candidates.filter((n) => before.get(n)!.length === 1);
            testInfo.annotations.push({ type: 'probed-names', description: `${names.length} of ${candidates.length} names exist and are probed (a system role the build lacks is skipped, not created)` });
            expect(names).toContain('admin');

            const answers = await test.step('POST each name again (an accepted duplicate is recorded first)', async () => {
                const out: Array<{ name: string; status: number; text: string; uuid?: string }> = [];
                for (const name of names) {
                    const r = await probeRole(api, own.spec, name);
                    out.push({ name, status: r.status, text: r.text, uuid: r.status < 300 ? String(r.json?.uuid ?? '') : undefined });
                }
                return out;
            });

            await test.step('Hard assertions (never masked by the known bug): refused, the role list unchanged, system roles untouched', async () => {
                for (const a of answers) expect(a.status, `${a.name === role.name ? 'the own role name' : a.name}: the duplicate create is refused`).toBeGreaterThanOrEqual(400);
                const after = await listAll(api, 'roles');
                for (const n of names) {
                    expect(after.filter((r) => r.name === n).map((r) => String(r.uuid)), `still exactly the roles that carried "${n === role.name ? 'the own role name' : n}" before`).toEqual(before.get(n));
                }
            });

            test.fail(true, 'core#2297: a duplicate role name answers 500 "Internal server error." instead of a 409 naming the role');
            await test.step('Each refusal is a 409 {message} that names the role and says it already exists (known bug core#2297)', async () => {
                for (const a of answers) {
                    expect(a.status, `${a.name}`).toBe(409);
                    const message = expectMessageObject(a.text);
                    expect(message, `${a.name}: the message names the role`).toContain(a.name);
                    expect(message, `${a.name}: the message says it already exists`).toMatch(/already exists/i);
                }
            });
        });
});
