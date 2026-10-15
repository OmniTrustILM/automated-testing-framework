/**
 * auth-known-bugs — duplicate user and role names (auth-rbac area, B2: API-AUTH-11, API-AUTH-18; known bug core#2297).
 *
 * The rule the tests assert comes from the platform convention and the tickets that built the feature, not from what the
 * API does today: a name that already exists is refused with a conflict that NAMES the collision — 409 `{message}`
 * ("already exists", `AlreadyExistException` → 409, also used by groups and credentials; REG-CFG-07 N1 / REG-CFG-09 N1;
 * developer question A1). Today the auth service's 400 `ENTITY_NOT_UNIQUE` surfaces as 500 "Internal server error."
 * (core#2297, open; rules C1, D1, G4).
 *
 * Each test keeps its HARD assertions (the duplicate is refused, exactly one object carries the name, nothing was created
 * behind the refusal) outside the known bug, and puts `test.fail()` right before the one step the bug breaks (the status and
 * message), so a regression in the refusal itself is never masked and the test turns red when core#2297 is fixed.
 *
 * Shared tier: the duplicates are of the run's OWN objects (run-prefixed names) and of the system roles `admin` /
 * `auditor` (a POST whose body names no uuid). If a platform ever ACCEPTED a duplicate, the object is recorded in the
 * ledger before any assertion (a duplicate of a system role name cannot carry the run prefix and is reported by name).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { listAll, postRole, postUser, rowsNamed } from '../../utils/regression/authApi';
import { expectMessageObject } from '../../utils/regression/errorContract';
import { createOwnRole, createOwnUser } from '../../utils/regression/regressionApi';
import { recordCreated } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';

const SPEC_11 = 'API-AUTH-11';
const SPEC_18 = 'API-AUTH-18';

test.describe('API-AUTH known bugs: duplicate names', { tag: tags.api }, () => {
    test('API-AUTH-11: a second user with an existing username is refused with a conflict naming the username, not a 500',
        meta({
            id: 'API-AUTH-11', prio: 'P1', issue: 'ilm#427', bug: 'core#2297',
            rule: [
                'auth-rbac C1 (duplicate username: auth 400 ENTITY_NOT_UNIQUE "User with username \'%s\' already exists"), G4 (auth 4xx are not translated: core#2297, open)',
                'release plan REG-CFG-09 N1 ("User with username ... already exists"); developer question A1 (409 {message}); AR-201',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(60_000);
            const user = await test.step('Own user (disabled TMP user)', async () => createOwnUser(api, 'dup', SPEC_11, { enabled: false }));

            const second = await test.step('POST the same username again', async () => postUser(api, user.name));

            await test.step('Ledger before assertion: a duplicate the platform accepted is this run\'s object', async () => {
                if (second.status < 300 && second.json?.uuid && second.json.uuid !== user.uuid) {
                    recordCreated('users', { uuid: String(second.json.uuid), name: user.name }, SPEC_11, 'duplicate user the platform accepted (API-AUTH-11)');
                }
            });

            await test.step('Hard assertions (never masked by the known bug): refused, exactly one user with that username', async () => {
                expect(second.status, 'the duplicate create is refused').toBeGreaterThanOrEqual(400);
                const named = await rowsNamed(api, 'users', user.name);
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

    test('API-AUTH-18: a role name equal to an own role, to admin or to auditor is refused with a conflict naming the role, not a 500',
        meta({
            id: 'API-AUTH-18', prio: 'P1', issue: 'ilm#427', bug: 'core#2297',
            rule: [
                'auth-rbac D1 (the role name is unique, also against system role names: auth 400 ENTITY_NOT_UNIQUE "Role with name \'%s\' already exists"), G4 (core#2297, open)',
                'release plan REG-CFG-07 N1 ("Role with name ... already exists"); developer question A1 (409 {message}); AR-301',
            ],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(90_000);
            const role = await test.step('Own role', async () => createOwnRole(api, 'dup', SPEC_18));
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

            const answers = await test.step('POST each name again', async () => {
                const out: Array<{ name: string; status: number; text: string; uuid?: string }> = [];
                for (const name of names) {
                    const r = await postRole(api, name);
                    out.push({ name, status: r.status, text: r.text, uuid: r.status < 300 ? String(r.json?.uuid ?? '') : undefined });
                }
                return out;
            });

            await test.step('Ledger before assertion: a duplicate the platform accepted (own-name duplicates carry the run prefix)', async () => {
                for (const a of answers) {
                    if (a.uuid && a.name === role.name) recordCreated('roles', { uuid: a.uuid, name: a.name }, SPEC_18, 'duplicate role the platform accepted (API-AUTH-18)');
                }
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
                    expect(message).toContain(a.name);
                    expect(message).toMatch(/already exists/i);
                }
            });
        });
});
