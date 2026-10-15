/**
 * API-GEN-32 — the migration sentinel gate (`@gate`, the `gate` project of the API config; review 2026-10-13
 * suggestion 3). On the target stack it reads the build marker (`/v1/info`), then runs the six Phase 2 §A sentinels, each
 * asserting its Phase 1 §9 rule. A pipeline runs `--project=gate` first: a red gate stops the P2 / P3 batches and the
 * nightly. The whole spec stays under 5 minutes: the per-test budgets add up to 290 s (30 + 30 + 20 + 60 + 60 + 90).
 *
 *   [health]    anonymous liveness / readiness bodies exactly {"status":"UP"}            (core bb20aaba: health restored)
 *   [errors]    a 422 is a JSON string array, a 404 is {message}                        (core 8337eb8b: Spring 7 422 split)
 *   [method]    a refused method answers 400 on main; @bug core#2502 on the migrated build (Tomcat 11 error forward)
 *   [session]   a signed-in session survives a reload (the one browser step)              (core bb20aaba: session filter)
 *   [connector] one attribute round trip through a healthy connector                     (Jackson 2 wire to connectors)
 *   [sort]      rows without a value sort last in both directions on the run's own seeds (Hibernate 7 null ordering)
 *
 * B1 fix pass (author decisions 1 + 2): the guard sends TRACE as a bodyless read held to the GET rules (no body, no
 * identity header, same origin, plain path, no side-effect-GET path, never a redirect follow), so [method] runs.
 * [method] judges only core's answer (`judgeRefusedMethod`): a 405, a `Server` header naming a proxy or a non-JSON body means
 * the ingress refused TRACE before core, so the test skips ("refused by the ingress before core (DevOps Q-10)") — no red
 * gate on main, no masked core#2502 on a migrated build; the response body is never printed.
 * The connector attribute CALLBACK (POST /v1/connectors/{uuid}/{functionGroup}/{kind}/callback, POST
 * /v2/connectors/{uuid}/callback, POST /v1/{resource}/{parentObjectUuid}/callback) stays out of the guard's read list:
 * core's handler is a write. `CallbackServiceImpl` is `@Transactional` (CallbackServiceImpl.java:72-73) and STORES what a
 * GROUP attribute's callback answers (:274-275 → processGroupAttributes :620 → :633
 * `attributeEngine.updateDataAttributeDefinitions`); an NG callback's `attributes` arm is ingested and committed
 * (service/callback/NgCallbackDispatcher.java:145 → handleResponseArms :184-193). Whether a call persists depends on the
 * attribute's type and on the connector's answer, neither of which the guard can see in the request, so [connector] makes
 * its round trip with the live attribute-DEFINITION reads (`probeAttributes`).
 *
 * Shared-tier safety: read-only except the [sort] seed subset (own custom attribute, own disabled user, three own
 * self-signed certificates: utils/regression/inventorySeed.ts), recorded in the ledger before any assertion and deleted
 * by the run-end teardown. Requests go through the guarded `api` fixture; the anonymous probes take the `request` fixture
 * (GET only).
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { LoginPage } from '../../pages/LoginPage';
import { getBuildInfo, isMigratedBuild } from '../../utils/regression/build';
import { ACCEPT_JSON, describeHealth, findConnector, healthByVersion, PROBE_PATHS, probeAttributes, readProbe, requiredConnectors } from '../../utils/regression/connectorApi';
import { expect422Messages, expectMessageObject, INGRESS_SKIP_REASON, judgeRefusedMethod } from '../../utils/regression/errorContract';
import { expectSorted } from '../../utils/regression/invariants';
import { buildSeedSubset, manifestProblems, manifestValue, nullRows, SeedField, SeedSubsetManifest, seedFilter } from '../../utils/regression/inventorySeed';
import { apiJson } from '../../utils/regression/regressionApi';
import { meta, tags } from '../../utils/regression/tags';
import type { GuardedApi } from '../../utils/regression/guardedApi';

const SPEC = 'API-GEN-32';
type Json = Record<string, any>;

/** One page of the seed subset sorted by `sort`; the exact row set is the manifest's (isolation filter). */
async function seedPage(api: GuardedApi, m: SeedSubsetManifest, sort: Json): Promise<Json[]> {
    const res = await api.post('/api/v1/certificates', { data: { itemsPerPage: 10, pageNumber: 1, filters: seedFilter(m), sort } });
    const text = await res.text();
    expect(res.status(), text.slice(0, 300)).toBe(200);
    return (JSON.parse(text).certificates ?? []) as Json[];
}

test.describe('API-GEN-32 migration sentinel gate', { tag: tags.api }, () => {
    test('API-GEN-32[health]: anonymous liveness and readiness bodies are exactly {"status":"UP"}',
        meta({ id: 'API-GEN-32', prio: 'P1', issue: 'ilm#425', gate: true, rule: 'platform-keys-connectors A1 r9 / r10 (anonymous health groups, body exactly {"status":"UP"}); Phase 2 §A core bb20aaba' }),
        async ({ request }) => {
            test.setTimeout(30_000);
            for (const which of ['liveness', 'readiness'] as const) {
                const started = Date.now();
                const p = await readProbe(await request.get(PROBE_PATHS[which], { headers: ACCEPT_JSON }), Date.now() - started);
                expect(p.status, `${which}: ${p.text.slice(0, 200)}`).toBe(200);
                expect(p.json, which).toEqual({ status: 'UP' });
            }
        });

    test('API-GEN-32[errors]: a 422 answers a JSON array of strings and a 404 answers {message}',
        meta({ id: 'API-GEN-32', prio: 'P1', issue: 'ilm#428', gate: true, rule: 'inventory-api §1.2 r2–r3 (422 = JSON string array; 400 / 404 / 409 / 500 = {message}); §1.3 rows "sort on unknown field" and "unknown object UUID"; Phase 2 §A core 8337eb8b' }),
        async ({ api }, testInfo) => {
            test.setTimeout(30_000);
            const build = await getBuildInfo(api);
            testInfo.annotations.push({ type: 'build', description: `core ${build.version ?? '?'} branch ${build.branch ?? '?'}` });

            await test.step('422: a certificate search sorted by an unknown field', async () => {
                const res = await api.post('/api/v1/certificates', {
                    data: { itemsPerPage: 1, pageNumber: 1, filters: [], sort: { fieldSource: 'property', fieldIdentifier: 'QA_NO_SUCH_FIELD', direction: 'asc' } },
                });
                const text = await res.text();
                expect(res.status(), text.slice(0, 300)).toBe(422);
                expect(res.headers()['content-type'] ?? '').toMatch(/application\/json/);
                expect(expect422Messages(text)).toContain('Unknown sort field identifier QA_NO_SUCH_FIELD.');
            });

            await test.step('404: the detail of a certificate that does not exist', async () => {
                const probe = api.probeUuid();
                const res = await api.get(`/api/v1/certificates/${probe}`);
                const text = await res.text();
                expect(res.status(), text.slice(0, 300)).toBe(404);
                expect(expectMessageObject(text)).toBe(`Object of type 'Certificate' identified by ${probe} is not found.`);
            });
        });

    test('API-GEN-32[method]: a refused HTTP method (TRACE) answers 400 with an empty body on main (core#2502: 401 on the migrated build)',
        meta({
            id: 'API-GEN-32', prio: 'P1', issue: 'ilm#428', gate: true, bug: 'core#2502',
            rule: 'inventory-api §1.3 row "TRACE or any method outside the firewall allow list: 400 baseline, 401 migrated" (core#2502, open); ilm#424 §6 "status codes stay the same"',
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(20_000);
            const migrated = await isMigratedBuild(api, testInfo);
            const res = await api.fetch('/api/v1/info', { method: 'TRACE' });
            // Whose answer is it (Fable F1)? An ingress that refuses TRACE before core (405, a proxy `Server` header, a non-JSON
            // body) says nothing about core: skip with the named reason. The body is never printed (a proxy could echo the
            // bearer); the verdict's problems and the skip detail are status codes, byte counts and a proxy name only.
            const verdict = judgeRefusedMethod({ status: res.status(), headers: res.headers(), bodyText: await res.text() });
            if (verdict.outcome === 'skip') {
                testInfo.annotations.push({ type: 'ingress-answer', description: verdict.why });
                test.skip(true, INGRESS_SKIP_REASON);
                return;
            }
            // The known bug only on the migrated build (the build marker from /v1/info, REG_BUILD overrides it): core answers 401 there.
            test.fail(migrated, 'core#2502: the migrated build answers 401 to a refused method');
            expect(verdict.problems, 'a refused method answers 400 with an empty body (core, not the ingress)').toEqual([]);
        });

    test('API-GEN-32[session]: a signed-in session survives a reload (same session cookie, same user)',
        meta({ id: 'API-GEN-32', prio: 'P1', issue: 'ilm#426', gate: true, rule: 'auth-rbac B1–B2 (session in spring_session, revalidated per request; survives reloads); Phase 2 §A core bb20aaba ("sign-in lost on the next request")' }),
        async ({ page, env, api }) => {
            // One IdP login + one reload.
            test.setTimeout(60_000);
            test.skip(env.authMode !== 'local', `the target has no identity-provider login for the suite (AUTH_MODE=${env.authMode}): no session to keep`);
            const profile = await apiJson<{ username: string }>(api, 'GET', '/api/v1/auth/profile');
            const login = new LoginPage(page, env);

            const before = await test.step('Sign in: the header names the user, a session cookie is set', async () => {
                await loginAsSmokeUser(page, env);
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

    // Author decision 2: the callback POST persists attribute definitions (see the header), so the round trip reads the
    // attribute DEFINITIONS through the connector instead.
    test('API-GEN-32[connector]: one attribute round trip through a healthy connector (definitions read live through core)',
        meta({ id: 'API-GEN-32', prio: 'P1', issue: 'ilm#436', gate: true, rule: 'platform-keys-connectors A4 r14 / r15 (live health by version; attribute definitions load through the connector); Phase 2 §A connector branches (Jackson 2 wire)' }),
        async ({ api }) => {
            test.setTimeout(60_000);
            const name = process.env.REG_GATE_CONNECTOR || requiredConnectors()[0];
            const connector = await findConnector(api, name);
            test.skip(!connector, `connector ${name} is not registered on this tier (REG_GATE_CONNECTOR names another one)`);
            const health = await healthByVersion(api, connector!);
            expect(health.healthy, describeHealth(health)).toBe(true);
            const probe = await probeAttributes(api, connector!, health.version!);
            expect(probe.ok, `${name}: ${probe.what}: ${probe.why}`).toBe(true);
        });

    test('API-GEN-32[sort]: rows without a value sort last in both directions on the run\'s 3-certificate seed subset',
        meta({ id: 'API-GEN-32', prio: 'P1', issue: 'ilm#428', gate: true, rule: 'inventory-api §2.2 r22 (objects without a value sort last in both directions; core#2394), r23 (custom attribute columns sort; core#2033); Phase 2 §A Hibernate 7 null ordering' }),
        async ({ api }) => {
            // Seed build (6 creates + 2 owner updates) + four sorted reads.
            test.setTimeout(90_000);
            const m = await test.step('Seed: the run\'s 3-certificate subset (own attribute, own user, own uploads)', async () => buildSeedSubset(api, SPEC));
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
                const groups = await apiJson<Array<{ filterFieldSource: string; searchFieldData: Json[] }>>(api, 'GET', '/api/v1/certificates/search');
                const field = groups
                    .filter((g) => g.filterFieldSource === 'custom')
                    .flatMap((g) => g.searchFieldData)
                    .find((f) => f.fieldLabel === m.attribute.label || String(f.fieldIdentifier).startsWith(`${m.attribute.name}|`));
                expect(field, 'the seed attribute is in the searchable-fields catalogue').toBeTruthy();
                expect(field!.sortable, 'a custom attribute column is sortable (core#2033)').toBe(true);
                await check('rank', (dir) => ({ fieldSource: 'custom', fieldIdentifier: field!.fieldIdentifier, direction: dir }));
            });
        });
});
