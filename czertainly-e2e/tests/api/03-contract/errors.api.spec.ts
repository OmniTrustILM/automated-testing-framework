/**
 * API-GEN-01, 02, 03, 05, 06, 07, 08 — The error contract of the core REST API on refused requests. ilm#428, ilm#442.
 *
 * WHAT: 1. A battery of at least 40 refused requests: a 422 is a JSON array of non-empty strings, 400 / 404 / 409 / 500 carry one
 *          `message`; the 400 for an unknown enum query value names an application enum class today.
 *       2. The shared search engine of five listings (certificates, keys, discoveries, audit log, OIDs): invalid paging, JSON, sort and
 *          filter inputs each get their fixed 400 or 422.
 *       3. An oversized upload (5 242 880, 5 242 881 and 6 MiB decoded) on the inspection and import routes → 422, never a 413 or a 5xx.
 *       4. Malformed JSON bodies (trailing comma, comments, NaN, deep nesting, wrong body types) → 400 "Unable to read HTTP message"
 *          without echoing the offending token; a refused create stores nothing.
 *       5. A wrong or missing content type answers 415 (core#2140: 500 today, test.fail); an Accept: application/xml answers a 4xx or JSON.
 *       6. TRACE and other undefined methods answer 400 with an empty body (core#2502: 401 on the migrated build, test.fail there); a GET
 *          on a POST-only path is a 4xx.
 *       7. No credentials, a garbage Bearer, a garbage JWT, an alg:none token, a garbage Basic header and a token with one changed
 *          character → 401 on every protected endpoint; the health endpoints answer 200 without credentials.
 * WHY: the error contract is the API's promise to clients: no stack trace, class name, SQL or file path in an error body, no echoed
 *      credential, and the same statuses before and after the platform migration (ilm#424). No core path answers 413 (a 413 would be a
 *      proxy in front of core).
 * HOW: every request is a read or a refused create; cases and checks live in utils/regression/inventory/errorCases/. A refused create that
 *      is accepted is recorded in the ledger first and then fails the test. Credential rows skip in header mode (the dev proxy adds the
 *      identity). Rows that need a request the guard does not allow yet are `test.fixme`. The refused-method rows skip with a named
 *      reason when the ingress answers before core.
 */
import { BATTERY_TEST_MS, MANY_STEPS_TEST_MS, OVERSIZED_UPLOAD_REQUEST_MS, WIDE_SWEEP_TEST_MS } from '../../../utils/regression/timeouts';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { isMigratedBuild } from '../../../utils/regression/coreBuild';
import { INGRESS_SKIP_MESSAGE, checkRefusedMethod } from '../../../utils/regression/errorContract';
import { ACCEPT_JSON, expectHealthGroupUp, PROBE_PATHS } from '../../../utils/regression/platform/connectorApi';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import type { OwnObjects } from '../../../utils/regression/ownObjects';
import { acceptProblems, ACCEPT_XML, CONTENT_TYPE_ROWS, contentTypeReq, jsonBattery, jsonReq, JsonRow, METHOD_FIXME_ROWS, TRACE_ROWS, WRONG_METHOD_GETS, wrongMethodExpectation } from '../../../utils/regression/inventory/errorCases/parsing';
import { ANONYMOUS_HEALTH, authorizationOf, identityReq, Identity, PROTECTED_ENDPOINTS, secretsOf } from '../../../utils/regression/inventory/errorCases/securityChain';
import { BatteryRow, Ctx, buildAnonymousAccessCases, buildErrorContractCases, createBatteryContext, nameInBody, sendCaseRequest } from '../../../utils/regression/inventory/errorCases/requests';
import { checkResponse } from '../../../utils/regression/inventory/errorCases/checks';
import { listingCases, ERROR_STATUS_MATRIX, MatrixRow } from '../../../utils/regression/inventory/errorCases/cases';
import { sizeProblems, SIZE_ROWS, UPLOAD_ROUTES, UploadRoute, uploadBody } from '../../../utils/regression/inventory/errorCases/uploads';
import { tamperSignature } from '../../../utils/regression/rbac/jwtTools';
import { runName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { ApiAnswer, answerOf } from '../../../utils/regression/apiReads';

const ISSUES = ['ilm#428', 'ilm#442'];

/** A context per test execution: `--repeat-each` safe names and markers, probe uuids from the guard. */
const ctxFor = (api: GuardedApi, tag: string): Ctx => createBatteryContext(tag, { runName, probe: () => api.probeUuid() });
/** A context for listing the rows at load time (titles only; the rows are rebuilt inside each test). */
const listCtx: Ctx = createBatteryContext('list', { runName: (s) => `qa-reg-list-${s}`, probe: () => '00000000-0000-4000-8000-000000000000' });

/**
 * A refused method (TRACE, the QAPROBE sentinel): whose answer is it (as in API-AUTH-02[method])? An ingress that
 * refuses it before core (405, a proxy `Server` header, a non-JSON body) skips with the named reason (`skip` true); core's answer
 * must be 400 with an empty body, 401 on the migrated build (core#2502). The calling test does the `test.fail(migrated)` itself
 * (the `@bug` lint wants it in the test body). The response body is never printed.
 */
async function refusedMethodAnswer(api: GuardedApi, testInfo: Parameters<typeof isMigratedBuild>[1], method: string, url: string): Promise<{ migrated: boolean; skip: boolean; problems: string[] }> {
    const migrated = await isMigratedBuild(api, testInfo);
    const res = await api.fetch(url, { method });
    const verdict = checkRefusedMethod({ status: res.status(), headers: res.headers(), bodyText: await res.text() });
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
async function recordAcceptedGroup(api: GuardedApi, own: OwnObjects, p: ApiAnswer, name: string | undefined, id: string): Promise<string> {
    let uuid = typeof (p.json as { uuid?: unknown } | undefined)?.uuid === 'string' ? (p.json as { uuid: string }).uuid : undefined;
    if (!uuid && name) {
        // Every failure of the lookup returns the hint: nothing may throw before the group is recorded.
        let rows: Array<{ uuid: string; name: string }>;
        try {
            const res = await api.get('/api/v1/groups');
            if (!res.ok()) return `${id}: answered ${p.status}; GET /api/v1/groups answered ${res.status()} — a group may have been created, look for it by hand`;
            rows = (await res.json()) as Array<{ uuid: string; name: string }>;
        } catch (e) {
            return `${id}: answered ${p.status}; reading the groups failed (${String(e).slice(0, 80)}) — a group may have been created, look for it by hand`;
        }
        uuid = Array.isArray(rows) ? rows.find((g) => g.name === name)?.uuid : undefined;
    }
    if (!uuid) return `${id}: answered ${p.status} — a group may have been created and could not be identified; look for it by hand`;
    // The record never throws: the loop of the battery goes on, and a record that failed is part of the problem text.
    try {
        const ref = own.probe('groups', { ...p, json: { uuid } }, { name: name ?? '(unnamed)', note: `${id}: a refused create was accepted (${p.status})` });
        if (!ref) return `${id}: answered ${p.status} and named group ${uuid}, but it could not be recorded (not a 2xx answer with a canonical uuid): look for it by hand`;
    } catch (e) {
        return `${id}: the refused create was ACCEPTED (${p.status}) and recording group ${uuid} failed (${String(e).slice(0, 80)}): remove it by hand`;
    }
    return `${id}: the refused create was ACCEPTED (${p.status}); the group is recorded in the ledger`;
}

test.describe('error contract', { tag: tags.api }, () => {
    // ================================================================== API-GEN-01
    const batterySize = buildErrorContractCases(listCtx).length;

    test(`error-contract shape over a battery of ${batterySize} refused requests`,
        testMeta({
            id: 'API-GEN-01', prio: 'P1', issue: ISSUES,
            rule: [
                '422 = JSON array of non-empty strings; 400 / 404 / 409 / 500 = {message}; status matrix and error body shape per status; each request names its status-matrix row',
                'core ExceptionHandlingAdvice, ErrorMessageDto; no stack trace, class / package name, SQL or file path in an error body',
            ],
        }),
        async ({ api, request, env, own }, testInfo) => {
            test.setTimeout(WIDE_SWEEP_TEST_MS);
            const ctx = ctxFor(api, 'gen01');
            const headerAuth = env.authMode === 'header';
            const all: BatteryRow[] = [...buildErrorContractCases(ctx), ...buildAnonymousAccessCases(ctx)];
            const rows = all.filter((r) => !(headerAuth && (r.needsToken || r.anonymous)));
            if (headerAuth) {
                testInfo.annotations.push({ type: 'skipped-rows', description: 'credential rows (anonymous / garbage Bearer / garbage Basic) skipped: AUTH_MODE=header, the dev proxy adds the identity and no bearer token exists' });
            }
            const problems: string[] = [];
            const answers: string[] = [];
            for (const matrix of Object.keys(ERROR_STATUS_MATRIX) as MatrixRow[]) {
                const group = rows.filter((r) => r.matrix === matrix);
                if (!group.length) continue;
                await test.step(`${matrix}: ${ERROR_STATUS_MATRIX[matrix]} (${group.length} request${group.length === 1 ? '' : 's'})`, async () => {
                    for (const row of group) {
                        const p = row.anonymous
                            ? await answerOf(await request.get(row.req.url, { headers: ACCEPT_JSON }), Date.now())
                            : await sendCaseRequest(api, row.req);
                        answers.push(`${row.id}: ${row.req.method} ${row.req.url.split('?')[0]} → ${p.status}`);
                        const issues = checkResponse(row.expect, p, row.echo ?? []);
                        if (p.status >= 200 && p.status < 300 && row.creates === 'groups') issues.push(await recordAcceptedGroup(api, own, p, nameInBody(row.req.data), row.id));
                        if (issues.length) problems.push(`${row.id} [${row.rule}]: ${issues.join('; ')}`);
                    }
                });
            }
            testInfo.annotations.push({ type: 'battery', description: `${rows.length} refused requests; ${answers.slice(0, 6).join(' | ')} …` });
            expect(rows.length, 'the battery is at least 40 refused requests').toBeGreaterThanOrEqual(40);
            expect(problems.join('\n'), 'requests of the battery that break the error contract').toBe('');
        });

    // Fixed as today's behaviour (unexpected product behaviour, not reported): the 400 for an enum query parameter names the application
    // class of the enum, a package name in an error body, against the contract asserted above ("no stack trace, class or package name, SQL
    // or file path in any error body"). The answer is the same on every run, so today's answer is asserted: the row turns red the day the
    // message is cleaned up, and then becomes the "names no application class" assertion. When the defect is filed it takes `bug` and
    // `test.fail()` instead of the pin.
    test('a 400 for an unknown enum query value names the application enum class today',
        testMeta({
            id: 'API-GEN-01', row: 'leak.enum-query', prio: 'P3', issue: ISSUES, pin: 'enum-query-names-application-class',
            rule: [
                'no class or package name in any error body is the rule (a path / query type error shows the JDK types only), but the 400 for an unknown enum query value names the enum class today',
                'observed on the OID category, attribute content type and statistics period query parameters (ilm#442): the message names com.otilm.api.model… and annotation types; a suspected product defect, not filed, so this row pins today\'s answer',
            ],
        }),
        async ({ api }, testInfo) => {
            const urls = ['/api/v1/oids/system?category=bogus', '/api/v1/attributes/custom?attributeContentType=bogus', '/api/v1/statistics/signingRecords?period=bogus'];
            const named: string[] = [];
            for (const url of urls) {
                const p = await sendCaseRequest(api, { method: 'GET', url });
                expect(p.status, `${url}: an unknown enum value is a 400`).toBe(400);
                if (/com\.otilm\.api\.model\./.test(p.text)) named.push(url.split('?')[0]);
            }
            testInfo.annotations.push({ type: 'pinned', description: `the 400 body names an application package on: ${named.join(', ') || 'no endpoint'}` });
            expect(named, 'the 400 body of every probed enum query parameter names the application enum class (this turns red when the message is cleaned up)').toEqual(urls.map((u) => u.split('?')[0]));
        });

    // ================================================================== API-GEN-02
    const LISTING_LABEL: Record<string, string> = { certificates: 'certificates', keys: 'keys', discoveries: 'discoveries', auditLogs: 'audit log', oids: 'OID' };
    const LISTING_CASE_TITLE: Record<string, string> = {
        'paging.itemsPerPage0': 'itemsPerPage 0 is refused with 422',
        'paging.pageNumber0': 'pageNumber 0 is refused with 422',
        'paging.itemsPerPageNegative': 'itemsPerPage -1 is refused with 422',
        'paging.pageNumberNegative': 'pageNumber -1 is refused with 422',
        'json.itemsPerPageOverflow': 'itemsPerPage 2147483648, past the int range, is refused with 400',
        'json.notJson': 'a body that is not JSON is refused with 400',
        'json.conditionCase': 'the condition "contains" in the wrong case is refused with 400',
        'json.fieldSourceCase': 'the fieldSource "PROPERTY" in the wrong case is refused with 400',
        'json.directionCase': 'the sort direction "ASC" in the wrong case is refused with 400',
        'sort.blankIdentifier': 'a blank sort field identifier is refused with 422',
        'sort.nullDirection': 'a null sort direction is refused with 422',
        'sort.unknownField': 'a sort on an unknown field is refused with 422',
        'sort.nonSortableField': 'a sort on a non-sortable field is refused with 422',
        'filter.conditionNotAdvertised.list': 'GREATER on a list field is refused with 422 listing the conditions',
        'filter.conditionNotAdvertised.string': 'GREATER on a string field is refused with 422 listing the conditions',
        'filter.valueMissing': 'CONTAINS without a value is refused with 422',
        'filter.valueEmptyList': 'CONTAINS with the value [] is refused with 422',
        'filter.regexInvalid': 'MATCHES "(", an invalid regex, is refused with 422',
        'filter.regexQuote': 'MATCHES "\\Qabc\\E", not POSIX regex, is refused with 422',
        'filter.durationInvalid': 'IN_NEXT "30 days" is refused with 422 as not a Duration',
        'filter.numberInvalid': 'EQUALS "abc" on a number field is refused with 422',
        'filter.attributeNoSuffix': 'a custom attribute identifier without a content type is refused with 422',
    };
    for (const c of listingCases()) {
        test(`${LISTING_CASE_TITLE[c.caseId]} on the ${LISTING_LABEL[c.resource]} listing`,
            testMeta({
                id: 'API-GEN-02', row: c.id, prio: 'P1', issue: ISSUES,
                rule: [
                    ERROR_STATUS_MATRIX[c.matrix],
                    'one table, five resources sharing the search engine: core RequestValidatorHelper, FilterPredicatesBuilder, SortOrderBuilder, ExceptionHandlingAdvice',
                ],
            }),
            async ({ api }) => {
                const p = await sendCaseRequest(api, c.req);
                expect(checkResponse(c.expect, p), `${c.req.method} ${c.req.url}: ${JSON.stringify(c.req.data instanceof Buffer ? c.req.data.toString('utf8') : c.req.data)}`).toEqual([]);
            });
    }

    // ================================================================== API-GEN-03 (both upload routes are creates the guard judges by
    // body)
    test.describe('robustness: an oversized upload is never a 413 or a 5xx', () => {
        const SIZE_ROW_TITLE: Record<string, string> = {
            '5242880': 'a 5 242 880-byte upload passes the size rule and gets the format refusal',
            '5242881': 'a 5 242 881-byte upload is refused with 422 fileWithinLimit',
            '6MiB': 'a 6 MiB upload is refused with 422 and never 413',
        };
        for (const route of ['inspections', 'import'] as UploadRoute[]) {
            for (const row of SIZE_ROWS) {
                test(`${SIZE_ROW_TITLE[row.id]} on the ${route} route`,
                    testMeta({
                        id: 'API-GEN-03', row: `${route}.${row.id}`, prio: 'P1', issue: ISSUES,
                        rule: ['no Core path answers 413; 5 MiB decoded → 422 fileWithinLimit (UploadedFile.MAXIMUM_LENGTH)', 'ilm#424 "422 and 413 split"; ilm#442 covers the oversized inspection and import'],
                    }),
                    async ({ api, own }) => {
                        // At most one request per row; refused before any read (bean validation) or before any write (the container
                        // reader).
                        test.setTimeout(BATTERY_TEST_MS);
                        const p = await sendCaseRequest(api, { method: 'POST', url: UPLOAD_ROUTES[route], data: uploadBody(route, row.bytes) }, OVERSIZED_UPLOAD_REQUEST_MS);
                        // Ledger before assertion: an import that was accepted anyway created certificates of this run.
                        for (const result of ((p.json as { results?: Array<{ certificateOutcome?: string; certificateUuid?: unknown }> } | undefined)?.results) ?? []) {
                            if (result.certificateOutcome === 'created' && typeof result.certificateUuid === 'string') {
                                own.record('certificates', { status: p.status, uuid: result.certificateUuid, text: p.text }, { name: '(oversized import)', note: 'an oversized import was accepted' });
                            }
                        }
                        expect(p.status, 'a refused upload is never a 413 (that would be a proxy in front of Core)').not.toBe(413);
                        expect(p.status, `a refused upload is never a server error: ${p.text.slice(0, 160)}`).toBeLessThan(500);
                        expect(sizeProblems(row, p), `${row.bytes} decoded bytes on ${UPLOAD_ROUTES[route]}`).toEqual([]);
                        // Nothing was stored: a 422 refusal is answered before the import's first write.
                        expect(Array.isArray(p.json), 'the answer is the 422 message list, not an import result').toBe(true);
                    });
            }
        }
    });

    // ================================================================== API-GEN-05
    const jsonRows: JsonRow[] = jsonBattery(listCtx);
    const JSON_ROW_TITLE: Record<string, string> = {
        'certificates.control': 'a well-formed search body on certificates is answered 200',
        'certificates.trailing-comma': 'a trailing comma in a certificates search body is refused with 400',
        'certificates.trailing-comma-marker': 'a certificates search error never echoes the token the parser stopped at',
        'certificates.comment-block': 'a block comment in a certificates search body is refused with 400',
        'certificates.comment-line': 'a line comment in a certificates search body is refused with 400',
        'certificates.nan': 'a NaN in a certificates search body is refused with 400',
        'certificates.nesting-25': '25-level nesting in the filters of a certificates search is refused with 400',
        'certificates.body-null': 'the body null on certificates search is refused with 400 Unable to read',
        'certificates.body-array': 'the body [] on certificates search is refused with 400',
        'certificates.body-array-marker': 'an array body on certificates search is refused with 400 and the marker is not echoed',
        'certificates.body-string': 'a string body on certificates search is refused with 400 and the marker is not echoed',
        'certificates.body-number': 'the body 123 on certificates search is refused with 400',
        'certificates.filters-object': 'filters as an object in a certificates search is refused with 400',
        'certificates.filters-string': 'filters "all", a string, in a certificates search is refused with 400',
        'certificates.itemsPerPage-abc': 'itemsPerPage "abc" in a certificates search is refused with 400',
        'certificates.includeArchived-yes': 'includeArchived "yes" in a certificates search is refused with 400',
        'certificates.duplicate-keys': 'a duplicate itemsPerPage key in a certificates search is answered 200, the last value wins',
        'certificates.bom': 'a leading UTF-8 BOM on certificates search answers 200 or 400, never a 5xx',
        'groups.trailing-comma': 'a trailing comma in a groups create body is refused with 400, nothing created',
        'groups.comment-block': 'a block comment in a groups create body is refused with 400, nothing created',
        'groups.comment-line': 'a line comment in a groups create body is refused with 400, nothing created',
        'groups.nan': 'a NaN in a groups create body is refused with 400, nothing created',
        'groups.nesting-25': '25-level nesting in customAttributes of a group create is refused with 400',
        'groups.body-null': 'the body null on groups create is refused with 400',
        'groups.body-array': 'the body [] on groups create is refused with 400',
        'groups.body-array-marker': 'an array body on groups create is refused with 400 and the marker is not echoed',
        'groups.body-string': 'a string body on groups create is refused with 400 and the marker is not echoed',
        'groups.body-number': 'the body 123 on groups create is refused with 400',
        'groups.name-object': 'a group name as an object is refused with 400 and the marker is not echoed',
        'groups.description-array': 'a group description as an array is refused with 400, nothing created',
        'groups.blank-name-control': 'a well-formed group create with the blank name "" is refused with 422',
        'groups.bom': 'a leading BOM before a blank group name answers 422 or 400 and creates nothing',
        'groups.duplicate-keys': 'a group create with the name key twice, both blank, is refused with 422',
    };
    const jsonTitle = (r: JsonRow): string => JSON_ROW_TITLE[r.id] ?? r.rule;
    const rule05 = ['body not JSON / wrong type → 400 "Unable to read HTTP message"; ilm#424 (the wire stays Jackson 2)', 'core ExceptionHandlingAdvice (no token of the body is echoed); ilm#442'];

    async function runJsonRow(api: GuardedApi, own: OwnObjects, id: string): Promise<void> {
        const row = jsonBattery(ctxFor(api, 'gen05')).find((r) => r.id === id);
        if (!row) throw new Error(`no JSON row ${id}`);
        const p = await sendCaseRequest(api, jsonReq(row));
        const problems = checkResponse(row.expect, p, row.echo ?? []);
        if (row.target === 'groups' && p.status >= 200 && p.status < 300) problems.push(await recordAcceptedGroup(api, own, p, nameInBody(row.data), `API-GEN-05[${id}]`));
        expect(problems, `${row.target}: ${row.rule}`).toEqual([]);
    }

    for (const r of jsonRows.filter((x) => x.kind !== 'pin')) {
        test(jsonTitle(r), testMeta({ id: 'API-GEN-05', row: r.id, prio: 'P1', issue: ISSUES, rule: [...rule05, r.rule] }), async ({ api, own }) => runJsonRow(api, own, r.id));
    }
    // Pins (never P1): today's behaviour where the written error contract and the ilm#442 probes disagree or are silent.
    for (const r of jsonRows.filter((x) => x.kind === 'pin' && !x.guardRefused)) {
        test(jsonTitle(r), testMeta({ id: 'API-GEN-05', row: r.id, prio: 'P3', issue: ISSUES, pin: r.pin, rule: [...rule05, r.rule] }), async ({ api, own }, testInfo) => {
            await runJsonRow(api, own, r.id);
            testInfo.annotations.push({ type: 'pin', description: `${r.pin}: ${r.rule}` });
        });
    }
    for (const r of jsonRows.filter((x) => x.guardRefused)) {
        test.fixme(jsonTitle(r),
            testMeta({ id: 'API-GEN-05', row: r.id, prio: 'P3', issue: ISSUES, pin: r.pin, rule: [...rule05, r.rule, 'not run until the guard allows a duplicate key on an allow-listed create'] }),
            async ({ api, own }) => runJsonRow(api, own, r.id));
    }

    // ================================================================== API-GEN-06
    const rule06 = ['"Unsupported Content-Type on a JSON endpoint answers 415"; core#2140 (open): 500 today on both builds', 'core ExceptionHandlingAdvice (no HttpMediaTypeNotSupportedException handler: the generic 500)'];
    for (const r of CONTENT_TYPE_ROWS) {
        const title = `${r.contentType === 'none' ? 'a body with no content type' : r.contentType.split(';')[0]} on ${r.url} answers 415`;
        const details = testMeta({ id: 'API-GEN-06', row: r.id, prio: 'P1', issue: 'ilm#428', bug: 'core#2140', rule: [...rule06, 'the 415 answers with {message}', ...(r.guardRefused ? [`not run until the guard allows ${r.contentType === 'none' ? 'a request without a content type' : `the content type ${r.contentType}`}`] : [])] });
        const body = async ({ api, own }: { api: GuardedApi; own: OwnObjects }): Promise<void> => {
            const p = await sendCaseRequest(api, contentTypeReq(r));
            if (r.resource === 'groups' && p.status >= 200 && p.status < 300) throw new Error(await recordAcceptedGroup(api, own, p, nameInBody(r.data), `API-GEN-06[${r.id}]`));
            test.fail(true, 'core#2140: an unsupported Content-Type answers 500, expected 415');
            expect(p.status, `${r.contentType} on ${r.url}: ${p.text.slice(0, 160)}`).toBe(415);
            expect(checkResponse({ status: 415 }, p), 'the 415 keeps the error-contract shape').toEqual([]);
        };
        if (r.guardRefused) test.fixme(title, details, body);
        else test(title, details, body);
    }

    test('an Accept: application/xml on a JSON endpoint answers a 4xx or a JSON 200',
        testMeta({ id: 'API-GEN-06', row: 'accept-xml', prio: 'P3', issue: 'ilm#428', pin: 'accept-xml-status', rule: ['the Accept row fixes the status core answers today (4xx, or 200 JSON)', 'never a server error'] }),
        async ({ api }, testInfo) => {
            const p = await sendCaseRequest(api, ACCEPT_XML);
            testInfo.annotations.push({ type: 'pin', description: `GET ${ACCEPT_XML.url} with Accept: application/xml answered ${p.status} (${p.contentType || 'no content type'})` });
            expect(acceptProblems(p), `${p.status}: ${p.text.slice(0, 160)}`).toEqual([]);
        });

    // ================================================================== API-GEN-07
    for (const r of TRACE_ROWS) {
        test(`TRACE ${r.url} is refused with 400 and an empty body`,
            testMeta({
                id: 'API-GEN-07', row: r.id, prio: 'P1', issue: ISSUES, bug: 'core#2502',
                rule: ['TRACE or any method outside the firewall allow list: 400 baseline, 401 migrated (core#2502, open); ilm#322 "status codes stay the same"', 'the same oracle as API-GEN-32[method]'],
            }),
            async ({ api }, testInfo) => {
                const a = await refusedMethodAnswer(api, testInfo, 'TRACE', r.url);
                test.skip(a.skip, INGRESS_SKIP_MESSAGE);
                test.fail(a.migrated, 'core#2502: the migrated build answers 401 to a refused method');
                expect(a.problems, `TRACE ${r.url}: a refused method answers 400 with an empty body (core, not the ingress)`).toEqual([]);
            });
    }

    for (const path of WRONG_METHOD_GETS) {
        test(`a GET on the POST-only path ${path} is a 4xx`,
            testMeta({
                id: 'API-GEN-07', row: `wrong-method.GET ${path}`, prio: 'P1', issue: ISSUES,
                rule: ['a refused HTTP method is an HttpRequestMethodNotSupportedException → ErrorMessageDto (405 or 400: the status core answers today is checked by the undefined-method row)', 'core ExceptionHandlingAdvice', 'never a 5xx', 'the 4xx carries the error-contract body'],
            }),
            async ({ api }) => {
                const p = await sendCaseRequest(api, { method: 'GET', url: path });
                expect(checkResponse({ status: '4xx' }, p), `GET ${path}`).toEqual([]);
            });
    }

    test('an undefined method gets the status core answers today',
        testMeta({ id: 'API-GEN-07', row: 'wrong-method.status', prio: 'P3', issue: ISSUES, pin: 'undefined-method-status', rule: 'a refused HTTP method: the error contract says 400, the method-not-allowed convention says 405 (the answer core gives now is asserted); ExceptionHandlingAdvice maps the exception to 400; ilm#442: an authority sub-path with a bad uuid answered 400 on both builds' }),
        async ({ api }, testInfo) => {
            const problems: string[] = [];
            for (const path of WRONG_METHOD_GETS) {
                const p = await sendCaseRequest(api, { method: 'GET', url: path });
                testInfo.annotations.push({ type: 'pin', description: `GET ${path} → ${p.status}` });
                problems.push(...checkResponse(wrongMethodExpectation('GET'), p).map((m) => `${path}: ${m}`));
            }
            expect(problems.join('\n')).toBe('');
        });

    for (const r of METHOD_FIXME_ROWS) {
        const firewall = r.id.startsWith('unknown-method');
        test(`${r.method} ${r.url} is refused`,
            testMeta({
                id: 'API-GEN-07', row: r.id, prio: 'P1', issue: ISSUES, ...(firewall ? { bug: 'core#2502' } : {}),
                rule: firewall
                    ? ['"TRACE or any method outside the firewall allow list: 400 baseline, 401 migrated" (core#2502)', 'the same oracle as API-GEN-32[method]']
                    : ['API-GEN-07 ("POST /v1/statistics", "DELETE /v1/info": a 4xx, never 5xx, body shape per API-GEN-01)', 'core StatisticsController / InfoController define GET only (interfaces StatisticsController, InfoController)'],
            }),
            async ({ api }, testInfo) => {
                if (firewall) {
                    const a = await refusedMethodAnswer(api, testInfo, r.method, r.url);
                    test.skip(a.skip, INGRESS_SKIP_MESSAGE);
                    test.fail(a.migrated, 'core#2502: the migrated build answers 401 to a refused method');
                    expect(a.problems, `${r.method} ${r.url}: a refused method answers 400 with an empty body (core, not the ingress)`).toEqual([]);
                    return;
                }
                const res = r.method === 'POST' ? await api.post(r.url) : await api.delete(r.url);
                const p = await answerOf(res, Date.now());
                expect(checkResponse({ status: '4xx' }, p), `${r.method} ${r.url}`).toEqual([]);
            });
    }

    // ================================================================== API-GEN-08
    const rule08 = ['missing or failed credentials → 401, never 200 / 403 / 5xx, no data in a 401 body', 'core SecurityConfig (authenticationEntryPoint → sendError(401)); AuthHelper (only /v?/health/** and /v?/connector/register are public)'];

    async function protectedSweep(label: string, perform: (p: (typeof PROTECTED_ENDPOINTS)[number], marker: string) => Promise<ApiAnswer>, marker: string, echoOf: (p: ApiAnswer) => string[]): Promise<string> {
        const problems: string[] = [];
        for (const p of PROTECTED_ENDPOINTS) {
            const answer = await perform(p, marker);
            const issues = checkResponse({ status: 401 }, answer, echoOf(answer));
            if (issues.length) problems.push(`${label} ${p.resource} (${p.url}): ${issues.join('; ')}`);
        }
        return problems.join('\n');
    }

    test(`no credentials → 401 on ${PROTECTED_ENDPOINTS.length} protected endpoints (including /v1/info)`,
        testMeta({ id: 'API-GEN-08', row: 'none', prio: 'P1', issue: ISSUES, rule: rule08 }),
        async ({ request, env }) => {
            test.skip(env.authMode === 'header', 'AUTH_MODE=header: the dev proxy adds the identity to every call, so a call without credentials is not anonymous there');
            test.setTimeout(MANY_STEPS_TEST_MS);
            const problems: string[] = [];
            for (const p of PROTECTED_ENDPOINTS) {
                const answer = await answerOf(await request.get(p.url, { headers: ACCEPT_JSON }), Date.now());
                const issues = checkResponse({ status: 401 }, answer);
                if (issues.length) problems.push(`none ${p.resource} (${p.url}): ${issues.join('; ')}`);
            }
            expect(problems.join('\n'), 'protected endpoints that answered an anonymous request').toBe('');
        });

    const identityTest = (identity: Exclude<Identity, 'none' | 'tampered-bearer'>, what: string): void => {
        test(`${what} → 401 on ${PROTECTED_ENDPOINTS.length} protected endpoints`,
            testMeta({ id: 'API-GEN-08', row: identity, prio: 'P1', issue: ISSUES, rule: [...rule08, 'the answer never echoes the credential'] }),
            async ({ api, env }) => {
                test.skip(env.authMode === 'header', 'AUTH_MODE=header: no bearer token on the local dev stack (the identity is the certificate header)');
                test.setTimeout(MANY_STEPS_TEST_MS);
                const marker = ctxFor(api, 'gen08').marker;
                const authorization = authorizationOf(identity, marker)!;
                const out = await protectedSweep(identity, (p) => sendCaseRequest(api, identityReq(p.url, authorization)), marker, () => secretsOf(authorization, marker));
                expect(out, `protected endpoints that accepted or mis-answered ${what}`).toBe('');
            });
    };
    identityTest('garbage-bearer', 'a garbage Bearer token');
    identityTest('garbage-jwt', 'a JWT-shaped token with a garbage signature');
    identityTest('alg-none', 'a forged alg:none token');
    identityTest('garbage-basic', 'a garbage Basic header');

    test(`a token with one character changed → 401 on ${PROTECTED_ENDPOINTS.length} protected endpoints`,
        testMeta({ id: 'API-GEN-08', row: 'tampered-bearer', prio: 'P1', issue: ISSUES, needs: 'bearer-token', rule: [...rule08, 'the admin token fixture is opaque; jwtTools.tamperSignature changes one character of its signature'] }),
        async ({ api, adminToken }) => {
            test.setTimeout(MANY_STEPS_TEST_MS);
            const token = tamperSignature(adminToken!.bearer());
            const authorization = `Bearer ${token}`;
            const out = await protectedSweep('tampered-bearer', (p) => sendCaseRequest(api, identityReq(p.url, authorization)), '', () => [token]);
            expect(out, 'protected endpoints that accepted a token with one changed character').toBe('');
        });

    test('the health endpoints answer 200 without credentials',
        testMeta({ id: 'API-GEN-08', row: 'anonymous-health', prio: 'P1', issue: ISSUES, rule: ['AuthHelper (public: /v?/health/**); the liveness and readiness bodies are also checked by the deployment rows (here only for the exact body)', '/health, /health/liveness and /health/readiness answer 200 without credentials (liveness and readiness exactly {"status":"UP"})'] }),
        async ({ request }) => {
            for (const h of ANONYMOUS_HEALTH) {
                const path = h.id === 'health' ? PROBE_PATHS.health : h.id === 'liveness' ? PROBE_PATHS.liveness : PROBE_PATHS.readiness;
                const p = await answerOf(await request.get(path, { headers: ACCEPT_JSON }), Date.now());
                if (h.exactBody) expectHealthGroupUp(p, path);
                else expect(p.status, `${path}: ${p.text.slice(0, 160)}`).toBe(200);
            }
        });

});
