/**
 * API-GEN-01 … 08 — the error contract of the core REST API (inventory-api area, ilm#428 T4, ilm#442 QA#8 / #11 / #12).
 *
 *   API-GEN-01  shape over a battery of refused requests: a 422 is a JSON array of non-empty strings, every other error
 *               an object with exactly one string member `message`; no stack trace, class / package name, SQL or file path;
 *               a 401 does not echo the credential. One test, one step per §1.3 matrix row, each request names its row.
 *   API-GEN-02  the same refusal text on every listing that uses the shared search engine (certificates, keys,
 *               discoveries, audit logs, OIDs): one test per resource and case.
 *   API-GEN-03  the 5 MiB upload limit on /v1/inspections and /v1/certificates/import, never 413 / 5xx — every row a
 *               fixme (guard request: both routes are off the guard's allow-lists), full bodies written.
 *   API-GEN-05  the JSON parsing battery on POST /v1/certificates (a read) and POST /v1/groups (refused, creates nothing).
 *   API-GEN-06  Content-Type / Accept: 415 expected, 500 today (core#2140); the Accept row is a pin.
 *   API-GEN-07  refused methods: TRACE 400 on main, 401 on the migrated build (core#2502); a defined path with a method it
 *               does not define: a 4xx, never a 5xx.
 *   API-GEN-08  the security chain over ≥ 20 protected endpoints and the anonymous health endpoints.
 *
 * Data and oracles: utils/regression/inventoryErrorBattery.ts (the tables, the judge, the leak scanner, the forged JWT).
 * Oracles come from inventory-api rules §1 (ExceptionHandlingAdvice, ErrorMessageDto, the status matrix §1.3); the texts
 * were read in core (integration/spring-boot-4.1) and, where observed, match the ilm#442 probes of both builds.
 *
 * Shared-tier safety: every request is a read (GET, TRACE, the five search POSTs) or a REFUSED create the core rejects
 * before any write (blank name, malformed body). A refused create that is answered 2xx is recorded in the ledger before the
 * test fails (decision Q1). Requests go through the guarded `api` fixture; anonymous reads use the `request` fixture (GET
 * only). A credential row needs a bearer token: skipped, with the reason, on a header-auth (local dev) stack. A request the
 * guard refuses today is a `test.fixme` with its complete body and a guard request (listed in the area's guard-request notes).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { isMigratedBuild } from '../../utils/regression/build';
import { INGRESS_SKIP_REASON, judgeRefusedMethod } from '../../utils/regression/errorContract';
import { ACCEPT_JSON, PROBE_PATHS } from '../../utils/regression/connectorApi';
import type { GuardedApi } from '../../utils/regression/guardedApi';
import type { Probe } from '../../utils/regression/inventoryApi';
import {
    acceptProblems, ACCEPT_XML, ANONYMOUS_HEALTH, answerOf, authorizationOf, BatteryRow, CONTENT_TYPE_ROWS, contentTypeReq, Ctx, gen01AuthRows, gen01Battery,
    identityReq, Identity, jsonBattery, jsonReq, JsonRow, judge, listingCases, makeCtx, MATRIX, MatrixRow, METHOD_FIXME_ROWS, nameInBody, PROTECTED,
    secretsOf, sendReq, sizeProblems, SIZE_ROWS, TRACE_ROWS, UPLOAD_ROUTES, UploadRoute, uploadBody, WRONG_METHOD_GETS,
    wrongMethodExpectation,
} from '../../utils/regression/inventoryErrorBattery';
import { tamperSignature } from '../../utils/regression/jwtTools';
import { recordCreated, regName } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-GEN-01';
const ISSUES = ['ilm#428', 'ilm#442'];

/** A context per test execution: `--repeat-each` safe names and markers, probe uuids from the guard. */
const ctxFor = (api: GuardedApi, tag: string): Ctx => makeCtx(tag, { regName, probe: () => api.probeUuid() });
/** A context for listing the rows at load time (titles only; the rows are rebuilt inside each test). */
const listCtx: Ctx = makeCtx('list', { regName: (s) => `qa-reg-list-${s}`, probe: () => '00000000-0000-4000-8000-000000000000' });

/**
 * A refused method (TRACE, the QAPROBE sentinel): whose answer is it (merge review L3, as API-AUTH-02[method])? An ingress that
 * refuses it before core (405, a proxy `Server` header, a non-JSON body) skips with the named reason (`skip` true); core's answer
 * must be 400 with an empty body, 401 on the migrated build (core#2502). The calling test does the `test.fail(migrated)` itself
 * (the `@bug` lint wants it in the test body). The response body is never printed.
 */
async function refusedMethodAnswer(api: GuardedApi, testInfo: Parameters<typeof isMigratedBuild>[1], method: string, url: string): Promise<{ migrated: boolean; skip: boolean; problems: string[] }> {
    const migrated = await isMigratedBuild(api, testInfo);
    const res = await api.fetch(url, { method });
    const verdict = judgeRefusedMethod({ status: res.status(), headers: res.headers(), bodyText: await res.text() });
    if (verdict.outcome === 'skip') {
        testInfo.annotations.push({ type: 'ingress-answer', description: verdict.why });
        return { migrated, skip: true, problems: [] };
    }
    return { migrated, skip: false, problems: verdict.problems };
}

/**
 * A refused create answered 2xx: the object is recorded in the ledger FIRST (the run-end teardown removes it), then the
 * caller fails the assertion. Returns the problem text.
 */
async function recordAcceptedGroup(api: GuardedApi, p: Probe, name: string | undefined, id: string): Promise<string> {
    let uuid = typeof (p.json as { uuid?: unknown } | undefined)?.uuid === 'string' ? (p.json as { uuid: string }).uuid : undefined;
    if (!uuid && name) {
        const res = await api.get('/api/v1/groups');
        const rows = res.ok() ? ((await res.json()) as Array<{ uuid: string; name: string }>) : [];
        uuid = rows.find((g) => g.name === name)?.uuid;
    }
    if (!uuid) return `${id}: answered ${p.status} — a group may have been created and could not be identified; look for it by hand`;
    recordCreated('groups', { uuid, name: name ?? '(unnamed)' }, SPEC, `${id}: a refused create was accepted (${p.status})`);
    return `${id}: the refused create was ACCEPTED (${p.status}); the group is recorded in the ledger`;
}

test.describe('API-GEN-01 … 08 error contract', { tag: tags.api }, () => {
    // ================================================================== API-GEN-01
    const batterySize = gen01Battery(listCtx).length;

    test(`API-GEN-01: error-contract shape over a battery of ${batterySize} refused requests, each naming its §1.3 row`,
        meta({
            id: 'API-GEN-01', prio: 'P1', issue: ISSUES,
            rule: [
                'inventory-api §1.2 r2–r3 (422 = JSON array of non-empty strings; 400 / 404 / 409 / 500 = {message}), §1.3 status matrix, §1.4 shape case',
                'core ExceptionHandlingAdvice.java:179-191, :240-248, :387-400, ErrorMessageDto; no stack trace, class / package name, SQL or file path in an error body',
            ],
        }),
        async ({ api, request, env }, testInfo) => {
            test.setTimeout(240_000);
            const ctx = ctxFor(api, 'gen01');
            const headerAuth = env.authMode === 'header';
            const all: BatteryRow[] = [...gen01Battery(ctx), ...gen01AuthRows(ctx)];
            const rows = all.filter((r) => !(headerAuth && (r.needsToken || r.anonymous)));
            if (headerAuth) {
                testInfo.annotations.push({ type: 'skipped-rows', description: 'credential rows (anonymous / garbage Bearer / garbage Basic) skipped: AUTH_MODE=header, the dev proxy adds the identity and no bearer token exists' });
            }
            const problems: string[] = [];
            const answers: string[] = [];
            for (const matrix of Object.keys(MATRIX) as MatrixRow[]) {
                const group = rows.filter((r) => r.matrix === matrix);
                if (!group.length) continue;
                await test.step(`${matrix}: ${MATRIX[matrix]} (${group.length} request${group.length === 1 ? '' : 's'})`, async () => {
                    for (const row of group) {
                        const p = row.anonymous
                            ? await answerOf(await request.get(row.req.url, { headers: ACCEPT_JSON }))
                            : await sendReq(api, row.req);
                        answers.push(`${row.id}: ${row.req.method} ${row.req.url.split('?')[0]} → ${p.status}`);
                        const issues = judge(row.expect, p, row.echo ?? []);
                        if (p.status >= 200 && p.status < 300 && row.creates === 'groups') issues.push(await recordAcceptedGroup(api, p, nameInBody(row.req.data), row.id));
                        if (issues.length) problems.push(`${row.id} [${row.rule}]: ${issues.join('; ')}`);
                    }
                });
            }
            testInfo.annotations.push({ type: 'battery', description: `${rows.length} refused requests; ${answers.slice(0, 6).join(' | ')} …` });
            expect(rows.length, 'the battery is at least 40 refused requests').toBeGreaterThanOrEqual(40);
            expect(problems.join('\n'), 'requests of the battery that break the error contract').toBe('');
        });

    // Suspected product defect (nothing is filed): the 400 for an enum query parameter names the application class of the
    // enum (and the annotations of the parameter): a class / package name in an error body, against the contract asserted above and
    // the plan row API-GEN-01 ("no stack trace, class or package name, SQL or file path in any error body"). The intended behaviour is
    // asserted as written: this test is RED today and carries no test.fail and no @bug tag. It takes the @bug tag (and test.fail before
    // the failing step) the day the defect is confirmed and filed, or turns green when the messages are cleaned up.
    test('API-GEN-01[leak.enum-query]: a 400 for an unknown enum value in a query names no application class or package',
        meta({
            id: 'API-GEN-01', prio: 'P2', issue: ISSUES,
            rule: [
                'inventory-api §1.4 shape case (no class or package name in any error body); §1.3 row "path / query type error" shows the JDK types only',
                'observed 2026-10-09 (ilm#442 pt.enum.query.oid-category, pt.enum.query.attr-content-type, pt.enum.query.stats-period): the message names com.otilm.api.model… and annotation types — suspected product defect, not filed; asserted as written (red today, no test.fail)',
            ],
        }),
        async ({ api }, testInfo) => {
            const problems: string[] = [];
            for (const url of ['/api/v1/oids/system?category=bogus', '/api/v1/attributes/custom?attributeContentType=bogus', '/api/v1/statistics/signingRecords?period=bogus']) {
                const p = await sendReq(api, { method: 'GET', url });
                problems.push(...judge({ status: 400 }, p).map((m) => `${url}: ${m}`));
            }
            testInfo.annotations.push({ type: 'suspected-defect', description: 'application package names in a 400 body for an enum query parameter; red until the defect is filed or fixed' });
            expect(problems.join('\n'), 'no application class or package name in the 400 body of an enum query parameter').toBe('');
        });

    // ================================================================== API-GEN-02
    for (const c of listingCases()) {
        test(`API-GEN-02[${c.id}]: ${c.rule}`,
            meta({
                id: 'API-GEN-02', prio: 'P1', issue: ISSUES,
                rule: [
                    `inventory-api ${MATRIX[c.matrix]}`,
                    'one table, five resources sharing the search engine: core RequestValidatorHelper, FilterPredicatesBuilder, SortOrderBuilder, ExceptionHandlingAdvice',
                ],
            }),
            async ({ api }) => {
                const p = await sendReq(api, c.req);
                expect(judge(c.expect, p), `${c.req.method} ${c.req.url}: ${JSON.stringify(c.req.data instanceof Buffer ? c.req.data.toString('utf8') : c.req.data)}`).toEqual([]);
            });
    }

    // ================================================================== API-GEN-03 (guard pass GD-08 / GD-09: both upload routes are body-judged creates)
    for (const route of ['inspections', 'import'] as UploadRoute[]) {
        for (const row of SIZE_ROWS) {
            test(`API-GEN-03[${route}.${row.id}]: ${row.rule}`,
                meta({
                    id: 'API-GEN-03', prio: 'P1', issue: ISSUES,
                    rule: ['inventory-api §1.2 r5 (no Core path answers 413), §6.2 r4 (5 MiB decoded → 422 fileWithinLimit; UploadedFile.MAXIMUM_LENGTH)', 'ilm#424 §3 "422 and 413 split"; ilm#442 probes v422.inspect.oversized / v422.import.oversized'],
                }),
                async ({ api }) => {
                    // At most one request per row; refused before any read (bean validation) or before any write (the container reader).
                    test.setTimeout(180_000);
                    const p = await sendReq(api, { method: 'POST', url: UPLOAD_ROUTES[route], data: uploadBody(route, row.bytes) }, 150_000);
                    expect(p.status, 'a refused upload is never a 413 (that would be a proxy in front of Core)').not.toBe(413);
                    expect(p.status, `a refused upload is never a server error: ${p.text.slice(0, 160)}`).toBeLessThan(500);
                    expect(sizeProblems(row, p), `${row.bytes} decoded bytes on ${UPLOAD_ROUTES[route]}`).toEqual([]);
                    // Nothing was stored: a 422 refusal is answered before the import's first write.
                    expect(Array.isArray(p.json), 'the answer is the 422 message list, not an import result').toBe(true);
                });
        }
    }

    // ================================================================== API-GEN-05
    const jsonRows: JsonRow[] = jsonBattery(listCtx);
    const jsonTitle = (r: JsonRow): string => `API-GEN-05[${r.id}]: ${r.rule}`;
    const rule05 = ['inventory-api §1.3 (body not JSON / wrong type → 400 "Unable to read HTTP message"), §1.4; ilm#424 §6 (the wire stays Jackson 2)', 'core ExceptionHandlingAdvice.java:387-400 (no token of the body is echoed); ilm#442 probes js.*'];

    async function runJsonRow(api: GuardedApi, id: string): Promise<void> {
        const row = jsonBattery(ctxFor(api, 'gen05')).find((r) => r.id === id);
        if (!row) throw new Error(`no JSON row ${id}`);
        const p = await sendReq(api, jsonReq(row));
        const problems = judge(row.expect, p, row.echo ?? []);
        if (row.target === 'groups' && p.status >= 200 && p.status < 300) problems.push(await recordAcceptedGroup(api, p, nameInBody(row.data), `API-GEN-05[${id}]`));
        expect(problems, `${row.target}: ${row.rule}`).toEqual([]);
    }

    for (const r of jsonRows.filter((x) => x.kind !== 'pin')) {
        test(jsonTitle(r), meta({ id: 'API-GEN-05', prio: 'P1', issue: ISSUES, rule: [...rule05, r.rule] }), async ({ api }) => runJsonRow(api, r.id));
    }
    // Pins (never P1): today's behaviour where rules §1.4 and the ilm#442 probes disagree or are silent.
    for (const r of jsonRows.filter((x) => x.kind === 'pin' && !x.guardRefused)) {
        test(jsonTitle(r), meta({ id: 'API-GEN-05', prio: 'P2', issue: ISSUES, pin: r.pin, rule: [...rule05, r.rule] }), async ({ api }, testInfo) => {
            await runJsonRow(api, r.id);
            testInfo.annotations.push({ type: 'pin', description: `${r.pin}: ${r.rule}` });
        });
    }
    for (const r of jsonRows.filter((x) => x.guardRefused)) {
        test.fixme(`${jsonTitle(r)} — guard request: a duplicate key on an allow-listed create`,
            meta({ id: 'API-GEN-05', prio: 'P2', issue: ISSUES, pin: r.pin, rule: [...rule05, r.rule] }),
            async ({ api }) => runJsonRow(api, r.id));
    }

    // ================================================================== API-GEN-06
    const rule06 = ['inventory-api §1.4 "Unsupported Content-Type on a JSON endpoint answers 415"; core#2140 (open): 500 today on both builds', 'core ExceptionHandlingAdvice.java:734-739 (no HttpMediaTypeNotSupportedException handler: the generic 500)'];
    for (const r of CONTENT_TYPE_ROWS) {
        const title = `API-GEN-06[${r.id}]: ${r.contentType === 'none' ? 'a body with no content type' : r.contentType} on ${r.url} answers 415 with {message} (core#2140: 500 today)`;
        const details = meta({ id: 'API-GEN-06', prio: 'P1', issue: 'ilm#428', bug: 'core#2140', rule: rule06 });
        const body = async ({ api }: { api: GuardedApi }): Promise<void> => {
            const p = await sendReq(api, contentTypeReq(r));
            if (r.resource === 'groups' && p.status >= 200 && p.status < 300) throw new Error(await recordAcceptedGroup(api, p, nameInBody(r.data), `API-GEN-06[${r.id}]`));
            test.fail(true, 'core#2140: an unsupported Content-Type answers 500, expected 415');
            expect(p.status, `${r.contentType} on ${r.url}: ${p.text.slice(0, 160)}`).toBe(415);
            expect(judge({ status: 415 }, p), 'the 415 keeps the error-contract shape').toEqual([]);
        };
        if (r.guardRefused) test.fixme(`${title} — guard request: ${r.contentType === 'none' ? 'no content type' : r.contentType}`, details, body);
        else test(title, details, body);
    }

    test('API-GEN-06[accept-xml]: Accept: application/xml on a JSON endpoint answers a 4xx or a JSON 200, never a server error',
        meta({ id: 'API-GEN-06', prio: 'P2', issue: 'ilm#428', pin: 'Q-ACCEPT', rule: 'inventory-api §1.4 / ledger API-GEN-06: the Accept row is a pin, status pinned from the first probe (4xx, or 200 JSON)' }),
        async ({ api }, testInfo) => {
            const p = await sendReq(api, ACCEPT_XML);
            testInfo.annotations.push({ type: 'pin', description: `Q-ACCEPT: GET ${ACCEPT_XML.url} with Accept: application/xml answered ${p.status} (${p.contentType || 'no content type'})` });
            expect(acceptProblems(p), `${p.status}: ${p.text.slice(0, 160)}`).toEqual([]);
        });

    // ================================================================== API-GEN-07
    for (const r of TRACE_ROWS) {
        test(`API-GEN-07[${r.id}]: TRACE ${r.url} is refused with 400 and an empty body on main (core#2502: 401 on the migrated build)`,
            meta({
                id: 'API-GEN-07', prio: 'P1', issue: ISSUES, bug: 'core#2502',
                rule: ['inventory-api §1.3 row "TRACE or any method outside the firewall allow list: 400 baseline, 401 migrated" (core#2502, open); ilm#322 "status codes stay the same"', 'the same oracle as API-GEN-32[method]'],
            }),
            async ({ api }, testInfo) => {
                const a = await refusedMethodAnswer(api, testInfo, 'TRACE', r.url);
                test.skip(a.skip, INGRESS_SKIP_REASON);
                test.fail(a.migrated, 'core#2502: the migrated build answers 401 to a refused method');
                expect(a.problems, `TRACE ${r.url}: a refused method answers 400 with an empty body (core, not the ingress)`).toEqual([]);
            });
    }

    for (const path of WRONG_METHOD_GETS) {
        test(`API-GEN-07[wrong-method.GET ${path}]: a GET on a POST-only path is a 4xx with the error-contract body, never a 5xx`,
            meta({
                id: 'API-GEN-07', prio: 'P1', issue: ISSUES,
                rule: ['inventory-api §1.2 r3 (a refused HTTP method is an HttpRequestMethodNotSupportedException → ErrorMessageDto), ledger API-GEN-07 (405 vs 400 pinned: API-GEN-07[wrong-method.status])', 'core ExceptionHandlingAdvice.java:141-146'],
            }),
            async ({ api }) => {
                const p = await sendReq(api, { method: 'GET', url: path });
                expect(judge({ status: '4xx' }, p), `GET ${path}`).toEqual([]);
            });
    }

    test('API-GEN-07[wrong-method.status]: the status of a method the path does not define, pinned to what core answers today',
        meta({ id: 'API-GEN-07', prio: 'P2', issue: ISSUES, pin: 'Q-M', rule: 'inventory-api §1.2 r3 says 400, §8.4 says 405 (open question Q-M); ExceptionHandlingAdvice.java:141-146 maps the exception to 400; ilm#442 probe pt.authority.subpath.bad-uuid answered 400 on both builds' }),
        async ({ api }, testInfo) => {
            const problems: string[] = [];
            for (const path of WRONG_METHOD_GETS) {
                const p = await sendReq(api, { method: 'GET', url: path });
                testInfo.annotations.push({ type: 'pin', description: `Q-M: GET ${path} → ${p.status}` });
                problems.push(...judge(wrongMethodExpectation('GET'), p).map((m) => `${path}: ${m}`));
            }
            expect(problems.join('\n')).toBe('');
        });

    for (const r of METHOD_FIXME_ROWS) {
        const firewall = r.id.startsWith('unknown-method');
        test(`API-GEN-07[${r.id}]: ${r.method} ${r.url} is refused`,
            meta({
                id: 'API-GEN-07', prio: 'P1', issue: ISSUES, ...(firewall ? { bug: 'core#2502' } : {}),
                rule: firewall
                    ? ['inventory-api §1.3 row "TRACE or any method outside the firewall allow list: 400 baseline, 401 migrated" (core#2502)', 'the same oracle as API-GEN-32[method]']
                    : ['inventory-api §1.2 r3, ledger API-GEN-07 ("POST /v1/statistics", "DELETE /v1/info": a 4xx, never 5xx, body shape per API-GEN-01)', 'core StatisticsController / InfoController define GET only (interfaces StatisticsController.java:23, InfoController.java:30)'],
            }),
            async ({ api }, testInfo) => {
                if (firewall) {
                    const a = await refusedMethodAnswer(api, testInfo, r.method, r.url);
                    test.skip(a.skip, INGRESS_SKIP_REASON);
                    test.fail(a.migrated, 'core#2502: the migrated build answers 401 to a refused method');
                    expect(a.problems, `${r.method} ${r.url}: a refused method answers 400 with an empty body (core, not the ingress)`).toEqual([]);
                    return;
                }
                const res = r.method === 'POST' ? await api.post(r.url) : await api.delete(r.url);
                const p = await answerOf(res);
                expect(judge({ status: '4xx' }, p), `${r.method} ${r.url}`).toEqual([]);
            });
    }

    // ================================================================== API-GEN-08
    const rule08 = ['ledger API-GEN-08 / P1 §9.6: missing or failed credentials → 401, never 200 / 403 / 5xx, no data in a 401 body', 'core SecurityConfig.java:100-113 (authenticationEntryPoint → sendError(401)); AuthHelper.java:88 (only /v?/health/** and /v?/connector/register are public)'];

    async function protectedSweep(label: string, perform: (p: (typeof PROTECTED)[number], marker: string) => Promise<Probe>, marker: string, echoOf: (p: Probe) => string[]): Promise<string> {
        const problems: string[] = [];
        for (const p of PROTECTED) {
            const answer = await perform(p, marker);
            const issues = judge({ status: 401 }, answer, echoOf(answer));
            if (issues.length) problems.push(`${label} ${p.resource} (${p.url}): ${issues.join('; ')}`);
        }
        return problems.join('\n');
    }

    test(`API-GEN-08[none]: no credentials → 401 on ${PROTECTED.length} protected endpoints (including /v1/info)`,
        meta({ id: 'API-GEN-08', prio: 'P1', issue: ISSUES, rule: rule08 }),
        async ({ request, env }) => {
            test.skip(env.authMode === 'header', 'AUTH_MODE=header: the dev proxy adds the identity to every call, so a call without credentials is not anonymous there');
            test.setTimeout(120_000);
            const problems: string[] = [];
            for (const p of PROTECTED) {
                const answer = await answerOf(await request.get(p.url, { headers: ACCEPT_JSON }));
                const issues = judge({ status: 401 }, answer);
                if (issues.length) problems.push(`none ${p.resource} (${p.url}): ${issues.join('; ')}`);
            }
            expect(problems.join('\n'), 'protected endpoints that answered an anonymous request').toBe('');
        });

    const identityTest = (identity: Exclude<Identity, 'none' | 'tampered-bearer'>, what: string): void => {
        test(`API-GEN-08[${identity}]: ${what} → 401 on ${PROTECTED.length} protected endpoints, the answer never echoes it`,
            meta({ id: 'API-GEN-08', prio: 'P1', issue: ISSUES, rule: rule08 }),
            async ({ api, env }) => {
                test.skip(env.authMode === 'header', 'AUTH_MODE=header: no bearer token on the local dev stack (the identity is the certificate header)');
                test.setTimeout(120_000);
                const marker = ctxFor(api, 'gen08').marker;
                const authorization = authorizationOf(identity, marker)!;
                const out = await protectedSweep(identity, (p) => sendReq(api, identityReq(p.url, authorization)), marker, () => secretsOf(authorization, marker));
                expect(out, `protected endpoints that accepted or mis-answered ${what}`).toBe('');
            });
    };
    identityTest('garbage-bearer', 'a garbage Bearer token');
    identityTest('garbage-jwt', 'a JWT-shaped token with a garbage signature');
    identityTest('alg-none', 'a forged alg:none token');
    identityTest('garbage-basic', 'a garbage Basic header');

    test(`API-GEN-08[tampered-bearer]: a valid token with one character changed → 401 on ${PROTECTED.length} protected endpoints`,
        meta({ id: 'API-GEN-08', prio: 'P1', issue: ISSUES, rule: [...rule08, 'the admin token fixture (guard pass GD-02, merged GR-I5) is opaque; jwtTools.tamperSignature changes one character of its signature'] }),
        async ({ api, env, adminToken }) => {
            test.skip(env.authMode === 'header' || adminToken === undefined, 'AUTH_MODE=header: no bearer token on the local dev stack');
            test.setTimeout(120_000);
            const token = tamperSignature(adminToken!.bearer());
            const authorization = `Bearer ${token}`;
            const out = await protectedSweep('tampered-bearer', (p) => sendReq(api, identityReq(p.url, authorization)), '', () => [token]);
            expect(out, 'protected endpoints that accepted a token with one changed character').toBe('');
        });

    test('API-GEN-08[anonymous-health]: /health, /health/liveness and /health/readiness answer 200 without credentials (liveness and readiness exactly {"status":"UP"})',
        meta({ id: 'API-GEN-08', prio: 'P1', issue: ISSUES, rule: ['ledger API-GEN-08; AuthHelper.java:88 (public: /v?/health/**); the bodies are owned by REG-DEP-01.a / .b (liveness / readiness here only for the exact body)'] }),
        async ({ request }) => {
            for (const h of ANONYMOUS_HEALTH) {
                const path = h.id === 'health' ? PROBE_PATHS.health : h.id === 'liveness' ? PROBE_PATHS.liveness : PROBE_PATHS.readiness;
                const p = await answerOf(await request.get(path, { headers: ACCEPT_JSON }));
                expect(p.status, `${path}: ${p.text.slice(0, 160)}`).toBe(200);
                if (h.exactBody) expect(p.json, path).toEqual({ status: 'UP' });
            }
        });

});
