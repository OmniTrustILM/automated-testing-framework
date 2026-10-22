/**
 * API-GEN-32 — The migration gate: six checks of behaviour a framework migration must keep. ilm#425, ilm#426, ilm#428, ilm#436.
 *
 * WHAT: 1. Anonymous liveness and readiness bodies are exactly {"status":"UP"}.
 *       2. A 422 answers a JSON array of strings (sort on an unknown field) and a 404 answers {message} (an unknown certificate).
 *       3. A refused HTTP method (TRACE) answers 400 with an empty body (core#2502: 401 on the migrated build, test.fail there).
 *       4. A signed-in browser session survives a reload (same user, same session cookie, an API read as that user).
 *       5. One attribute round trip through a healthy connector: its live health by version, then its attribute definitions load.
 *       6. Rows without a value sort last in both directions, by OWNER and by a custom attribute column (core#2394, core#2033).
 * WHY: these are the behaviours a platform migration is most likely to change silently: health bodies, error body shapes and status codes,
 *      the session, the connector wire and the null sort order. A pipeline runs `--project=gate` first and stops on red.
 * HOW: tagged `@gate`. Read-only except the sort row's seed subset (three certificates, an own attribute, an own user, own uploads), which
 *      is recorded in the ledger before any assertion and deleted by the run-end teardown. The connector row reads attribute definitions
 *      only (a callback would be a write, because core stores what some callbacks answer) and skips when the connector is not registered.
 *      The session row needs an identity-provider login and skips otherwise; the TRACE row skips with a named reason when the ingress
 *      answers before core.
 */
import { FEW_CALLS_TEST_MS, SEED_SORT_TEST_MS, SEVERAL_STEPS_TEST_MS, SINGLE_PROBE_TEST_MS } from '../../../utils/regression/timeouts';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { LoginPage } from '../../../pages/LoginPage';
import { getBuildInfo, isMigratedBuild } from '../../../utils/regression/coreBuild';
import { ACCEPT_JSON, describeHealth, expectHealthGroupUp, findConnector, healthByVersion, PROBE_PATHS, probeAttributes, requiredConnectors } from '../../../utils/regression/platform/connectorApi';
import { expectRefused, INGRESS_SKIP_MESSAGE, checkRefusedMethod } from '../../../utils/regression/errorContract';
import { expectSorted } from '../../../utils/regression/inventory/listInvariants';
import { fieldsOf, readCatalogue, rowsOf, searchRaw, send } from '../../../utils/regression/inventory/searchApi';
import {
    buildSeedSubset,
    manifestProblems,
    manifestValue,
    nullRows,
    SeedField,
    SeedSubsetManifest,
    seedFilter,
} from '../../../utils/regression/inventory/seedMinimal';
import { apiJson, answerOf } from '../../../utils/regression/apiReads';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import { settings } from '../../../utils/regression/run/settings';

type Json = Record<string, any>;

/** One page of the seed subset sorted by `sort`; the exact row set is the manifest's (isolation filter). */
async function seedPage(api: GuardedApi, m: SeedSubsetManifest, sort: Json): Promise<Json[]> {
    const answer = await searchRaw(api, { itemsPerPage: 10, pageNumber: 1, filters: seedFilter(m), sort });
    expect(answer.status, answer.text.slice(0, 300)).toBe(200);
    return rowsOf(answer.json, 'certificates');
}

test.describe('migration sentinel gate', { tag: tags.api }, () => {
    test('anonymous liveness and readiness bodies are exactly {"status":"UP"}',
        testMeta({ id: 'API-GEN-32', row: 'health', prio: 'P1', issue: 'ilm#425', gate: true, rule: 'anonymous health groups answer with the body exactly {"status":"UP"}' }),
        async ({ request }) => {
            test.setTimeout(FEW_CALLS_TEST_MS);
            for (const which of ['liveness', 'readiness'] as const) {
                const started = Date.now();
                const p = await answerOf(await request.get(PROBE_PATHS[which], { headers: ACCEPT_JSON }), started);
                expectHealthGroupUp(p, which);
            }
        });

    test('a 422 answers a JSON array of strings and a 404 answers {message}',
        testMeta({ id: 'API-GEN-32', row: 'errors', prio: 'P1', issue: 'ilm#428', gate: true, rule: '422 = JSON string array; 400 / 404 / 409 / 500 = {message}; "sort on unknown field" and "unknown object UUID" keep their status codes' }),
        async ({ api }, testInfo) => {
            test.setTimeout(FEW_CALLS_TEST_MS);
            const build = await getBuildInfo(api);
            testInfo.annotations.push({ type: 'build', description: `core ${build.version ?? '?'} branch ${build.branch ?? '?'}` });

            await test.step('422: a certificate search sorted by an unknown field', async () => {
                const refused = await searchRaw(api, { itemsPerPage: 1, pageNumber: 1, filters: [], sort: { fieldSource: 'property', fieldIdentifier: 'QA_NO_SUCH_FIELD', direction: 'asc' } });
                expectRefused(refused, { status: 422, text: 'Unknown sort field identifier QA_NO_SUCH_FIELD.', among: true });
            });

            await test.step('404: the detail of a certificate that does not exist', async () => {
                const probe = api.probeUuid();
                const missing = await send(api, 'GET', `/api/v1/certificates/${probe}`);
                expectRefused(missing, { status: 404, text: `Object of type 'Certificate' identified by ${probe} is not found.` });
            });
        });

    test('a refused HTTP method (TRACE) answers 400 with an empty body',
        testMeta({
            id: 'API-GEN-32', row: 'method', prio: 'P1', issue: 'ilm#428', gate: true, bug: 'core#2502',
            rule: 'TRACE or any method outside the firewall allow list: 400 baseline, 401 migrated (core#2502, open); ilm#424 "status codes stay the same"',
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(SINGLE_PROBE_TEST_MS);
            const migrated = await isMigratedBuild(api, testInfo);
            const res = await api.fetch('/api/v1/info', { method: 'TRACE' });
            // Whose answer is it? An ingress that refuses TRACE before core (405, a proxy `Server` header, a non-JSON
            // body) says nothing about core: skip with the named reason. The body is never printed (a proxy could echo the
            // bearer); the verdict's problems and the skip detail are status codes, byte counts and a proxy name only.
            const verdict = checkRefusedMethod({ status: res.status(), headers: res.headers(), bodyText: await res.text() });
            if (verdict.outcome === 'skip') {
                testInfo.annotations.push({ type: 'ingress-answer', description: verdict.why });
                test.skip(true, INGRESS_SKIP_MESSAGE);
                return;
            }
            // The known bug only on the migrated build (the build marker from /v1/info, REG_BUILD overrides it): core answers 401 there.
            test.fail(migrated, 'core#2502: the migrated build answers 401 to a refused method');
            expect(verdict.problems, 'a refused method answers 400 with an empty body (core, not the ingress)').toEqual([]);
        });

    test('a signed-in session survives a reload',
        testMeta({ id: 'API-GEN-32', row: 'session', prio: 'P1', issue: 'ilm#426', gate: true, rule: 'session in spring_session, revalidated per request; survives reloads ("sign-in lost on the next request")' }),
        async ({ page, env, api }) => {
            // One IdP login + one reload.
            test.setTimeout(SEVERAL_STEPS_TEST_MS);
            test.skip(env.authMode !== 'local', `the target has no identity-provider login for the suite (AUTH_MODE=${env.authMode}): no session to keep`);
            const profile = await apiJson<{ username: string }>(api, 'GET', '/api/v1/auth/profile');
            const login = new LoginPage(page, env);

            const before = await test.step('Sign in: the header names the user, a session cookie is set', async () => {
                await login.goto();
                await login.login();
                await login.assertSignedInAs(profile.username);
                const cookie = await login.sessionCookie();
                expect(cookie, `the ${LoginPage.SESSION_COOKIE} cookie is set`).toBeTruthy();
                return cookie;
            });

            await test.step('Reload: still signed in as the same user, with the same session', async () => {
                await login.reloadKeepingSession();
                await login.assertSignedInAs(profile.username);
                expect(await login.sessionCookie(), 'the session cookie survived the reload').toBe(before);
            });

            await test.step('The session answers an API read as that user', async () => {
                const res = await page.request.get('/api/v1/auth/profile');
                expect(res.status()).toBe(200);
                expect(((await res.json()) as { username?: string }).username).toBe(profile.username);
            });
        });

    // A connector callback POST persists attribute definitions, so the round trip reads the
    // attribute DEFINITIONS through the connector instead.
    test('one attribute round trip through a healthy connector',
        testMeta({ id: 'API-GEN-32', row: 'connector', prio: 'P1', issue: 'ilm#436', gate: true, rule: 'live health by version; attribute definitions load through the connector (Jackson 2 wire)' }),
        async ({ api }) => {
            test.setTimeout(SEVERAL_STEPS_TEST_MS);
            const name = settings().gateConnector || requiredConnectors()[0];
            const connector = await findConnector(api, name);
            test.skip(!connector, `connector ${name} is not registered on this tier (REG_GATE_CONNECTOR names another one)`);
            const health = await healthByVersion(api, connector!);
            expect(health.healthy, describeHealth(health)).toBe(true);
            // The attribute DEFINITION reads, not a callback: core stores what some callbacks answer, so a callback is a write.
            const probe = await probeAttributes(api, connector!, health.version!);
            expect(probe.ok, `${name}: ${probe.what}: ${probe.why}`).toBe(true);
        });

    test('rows without a value sort last in both directions',
        testMeta({ id: 'API-GEN-32', row: 'sort', prio: 'P1', issue: 'ilm#428', gate: true, rule: 'objects without a value sort last in both directions (core#2394); custom attribute columns sort (core#2033); Hibernate 7 null ordering' }),
        async ({ api, own }) => {
            // Seed build (6 creates + 2 owner updates) + four sorted reads.
            test.setTimeout(SEED_SORT_TEST_MS);
            const m = await test.step('Seed: the run\'s 3-certificate subset (own attribute, own user, own uploads)', async () => buildSeedSubset(api, own.spec));
            expect(manifestProblems(m), 'the seed manifest is a usable subset').toEqual([]);
            const expected = m.certificates.map((c) => c.uuid).sort();

            const check = async (field: SeedField, sort: (dir: 'asc' | 'desc') => Json) => {
                for (const dir of ['asc', 'desc'] as const) {
                    const rows = await seedPage(api, m, sort(dir));
                    expect(rows.map((r) => String(r.uuid)).sort(), `${field} ${dir}: exactly the seed subset`).toEqual(expected);
                    expectSorted(rows, field, dir, { get: (r) => manifestValue(m, String(r.uuid), field) });
                    expect(String(rows[rows.length - 1].uuid), `${field} ${dir}: the row without a value is last`).toBe(nullRows(m, field)[0]);
                }
            };

            await test.step('Sorted by OWNER: the certificate without an owner is last, ascending and descending', async () => {
                await check('owner', (dir) => ({ fieldSource: 'property', fieldIdentifier: 'OWNER', direction: dir }));
            });

            await test.step('Sorted by the seed custom attribute: the certificate without a value is last; the others by value', async () => {
                const field = fieldsOf(await readCatalogue(api), 'custom')
                    .find((f) => f.fieldLabel === m.attribute.label || String(f.fieldIdentifier).startsWith(`${m.attribute.name}|`));
                expect(field, 'the seed attribute is in the searchable-fields catalogue').toBeTruthy();
                expect(field!.sortable, 'a custom attribute column is sortable (core#2033)').toBe(true);
                await check('rank', (dir) => ({ fieldSource: 'custom', fieldIdentifier: field!.fieldIdentifier, direction: dir }));
            });
        });
});
