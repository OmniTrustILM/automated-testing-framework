/**
 * Certificate search filters over the run's own certificate seed: text, date, list, collection, owner and custom
 * attribute conditions, the refusals of the filter engine, relations over all data, complements and AND. Exact row sets
 * come from the row tables (searchTables.ts) with the Common Name prefix filter; the search is a read (POST_READ).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { expect422Messages } from '../../utils/regression/errorContract';
import { propertyFilter, readCatalogue, fieldsOf, findField, CONDITION_SETS, searchPage, Filter, sameSet, CatalogueField, send, readJsonOk } from '../../utils/regression/inventory/searchApi';
import { andNarrows, anyOfBound, catalogueFields, contradictions, CountFn, describeViolations, emptyPartition, equalsPartition, narrowingPairs } from '../../utils/regression/inventory/searchConsistency';
import { resolveRowContext, searchSeedCertificates, certificateSeedPlan } from '../../utils/regression/inventory/seedRows';
import { CertId, certById, seedIsolation } from '../../utils/regression/inventory/seedFull';
import { ATTRIBUTE_ROWS, COLLECTION_ROWS, COUNT_PINS, COUNT_REFUSALS, DATE_REFUSALS, DATE_ROWS, DURATION_REFUSALS, FilterRow, LIST_REFUSALS, LIST_ROWS, notAfterOf, OWNER_REFUSALS, TEXT_ROWS } from '../../utils/regression/inventory/searchTables';
import { testMeta, tags } from '../../utils/regression/tags';
import type { GuardedApi } from '../../utils/regression/guard/types';
import type { SeedAManifest } from '../../utils/regression/inventory/seedFull';

const ISSUE = 'ilm#428';

type Json = Record<string, any>;

/** The common body of a positive row: 200, the exact seed set, the total. A row with a known bug is `test.fail()` before the failing step. */
async function expectRow(api: GuardedApi, m: SeedAManifest, row: FilterRow, markBug: () => void, ctx = {}, extra: Json = {}): Promise<void> {
    const r = await searchSeedCertificates(api, m, row.filters(m, ctx), extra);
    expect(r.probe.status, `${row.row}: ${r.probe.text.slice(0, 300)}`).toBe(200);
    const want = [...row.expect(m)].sort();
    if (row.bug) test.fail(true, `${row.bug}: the rule says the filter value is a literal; the engine treats \`%\` and \`_\` as wildcards today`);
    expect(r.ids, `${row.row} ${row.title}: seeds returned`).toEqual(want);
    expect(r.totalItems, `${row.row}: totalItems`).toBe(want.length);
}

/** A refusal: the status, a JSON array of non-empty strings (422) or {message} (400), the text, never a 5xx. */
function expectRefusal(p: { status: number; contentType: string; text: string }, status: 422 | 400, text: RegExp | string, what: string): void {
    expect(p.status, `${what}: ${p.text.slice(0, 300)}`).toBe(status);
    if (status === 422) {
        expect(p.contentType, `${what}: content type`).toMatch(/application\/json/);
        const messages = expect422Messages(p.text);
        const hit = messages.some((s) => (typeof text === 'string' ? s === text : text.test(s)));
        expect(hit, `${what}: ${JSON.stringify(messages)} should match ${String(text)}`).toBe(true);
    }
}

test.describe('certificate search filters', { tag: tags.api }, () => {
    /**
     * One table row as one Playwright test (inside the describe so the suite tag is inherited): pins and known bugs are carried by the
     * row (a pin is never P1). `markBug` is `test.fail()` placed right before the failing step by `expectRow`.
     */
    function rowTest(id: string, row: FilterRow, rule: string, run: (api: GuardedApi, m: SeedAManifest, markBug: () => void) => Promise<void>): void {
        test(`${row.title}`,
            testMeta({ id, row: row.row, prio: row.pin ? 'P2' : 'P1', issue: ISSUE, pin: row.pin, bug: row.bug, rule }),
            async ({ api }, testInfo) => {
                const markBug = (): void => {
                    if (row.bug) test.fail(true, `${row.bug}: the rule fixes today's engine behaviour as a bug`);
                };
                await run(api, await certificateSeedPlan(api, testInfo, id), markBug);
            });
    }

    // ------------------------------------------------------------------ 41: text conditions

    for (const row of TEXT_ROWS) {
        rowTest('API-CERT-41', row, 'string conditions; ilm#428 step 3', async (api, m, markBug) => expectRow(api, m, row, markBug));
    }

    // ------------------------------------------------------------------ 42: datetime conditions

    for (const row of DATE_ROWS) {
        rowTest('API-CERT-42', row, 'datetime conditions; core#1030; ilm#428 step 4', async (api, m, markBug) => expectRow(api, m, row, markBug));
    }

    test('GREATER_OR_EQUAL and LESSER on one seed\'s expiry split the seeds into two disjoint sets',
        testMeta({ id: 'API-CERT-42', row: 'D-9', prio: 'P1', issue: ISSUE, rule: 'DATETIME: GREATER_OR_EQUAL T + LESSER T = total non-null' }),
        async ({ api }, testInfo) => {
            const m = await certificateSeedPlan(api, testInfo, 'API-CERT-42');
            const t3 = notAfterOf(m, 'C03');
            const [ge, lt] = [await searchSeedCertificates(api, m, [propertyFilter('NOT_AFTER', 'GREATER_OR_EQUAL', t3)]), await searchSeedCertificates(api, m, [propertyFilter('NOT_AFTER', 'LESSER', t3)])];
            expect(ge.probe.status, ge.probe.text.slice(0, 200)).toBe(200);
            expect(lt.probe.status, lt.probe.text.slice(0, 200)).toBe(200);
            expect(ge.uuids.filter((u) => lt.uuids.includes(u)), 'the two sets are disjoint').toEqual([]);
            expect(ge.uuids.length + lt.uuids.length, 'the counts add up to the 24 seeds').toBe(24);
        });

    test.describe('robustness: a date that does not parse is never a 5xx', () => {
        for (const r of DATE_REFUSALS) {
            // Rule: a datetime that does not parse is a caller error (4xx). Today the engine answers 500 (core#2504, open).
            test(`${r.title} should answer a 4xx, not today\'s 500`,
                testMeta({ id: 'API-CERT-42', row: r.row, prio: 'P1', issue: ISSUE, bug: r.bug, rule: 'a date that does not parse is refused (core#2504 open)' }),
                async ({ api }, testInfo) => {
                    const m = await certificateSeedPlan(api, testInfo, 'API-CERT-42');
                    const p = (await searchSeedCertificates(api, m, [propertyFilter('NOT_AFTER', 'EQUALS', r.value(m))])).probe;
                    test.fail(true, `${r.bug}: ${p.status} today (500 expected to become a 4xx)`);
                    expect(p.status, `${r.row}: ${p.text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
                    expect(p.status, `${r.row}: never a 5xx`).toBeLessThan(500);
                });
        }
    });

    for (const r of DURATION_REFUSALS) {
        test(`NOT_AFTER IN_NEXT ${JSON.stringify(r.value)} is refused 422 with the duration text`,
            testMeta({ id: 'API-CERT-42', row: r.row, prio: 'P1', issue: ISSUE, rule: 'a bad duration for IN_NEXT / IN_PAST is refused (422 `… cannot be parsed to a Duration.`); core#1030' }),
            async ({ api }, testInfo) => {
                const m = await certificateSeedPlan(api, testInfo, 'API-CERT-42');
                const p = (await searchSeedCertificates(api, m, [propertyFilter('NOT_AFTER', 'IN_NEXT', r.value)])).probe;
                expectRefusal(p, 422, r.text, `IN_NEXT ${JSON.stringify(r.value)}`);
            });
    }

    // ------------------------------------------------------------------ 43: list and enum conditions

    for (const row of LIST_ROWS) {
        rowTest('API-CERT-43', row, 'list conditions (enum lists compare the code; any-of / none-of); ilm#428 step 5', async (api, m, markBug) => {
            const ctx = await resolveRowContext(api, m);
            await expectRow(api, m, row, markBug, ctx);
        });
    }

    for (const r of LIST_REFUSALS) {
        test(`${r.filter.fieldIdentifier} ${r.filter.condition} is refused 422 naming the supported conditions`,
            testMeta({ id: 'API-CERT-43', row: r.row, prio: 'P1', issue: ISSUE, rule: 'a condition the field does not advertise is refused (FilterPredicatesBuilder.requireAdvertisedCondition)' }),
            async ({ api }, testInfo) => {
                const m = await certificateSeedPlan(api, testInfo, 'API-CERT-43');
                expectRefusal((await searchSeedCertificates(api, m, [r.filter])).probe, 422, r.text, r.row);
            });
    }

    // ------------------------------------------------------------------ 45: collection and owner fields (S-own: groups and owner come from the seed PATCHes)

    for (const row of COLLECTION_ROWS) {
        rowTest('API-CERT-45', row, 'collection fields (EQUALS any-of / NOT_EQUALS none-of, EMPTY, COUNT_*; OWNER null handling); core#1117; ilm#428 step 5', async (api, m, markBug) => expectRow(api, m, row, markBug));
    }

    for (const r of COUNT_REFUSALS) {
        test(`GROUP_NAME ${r.condition} ${JSON.stringify(r.value)} is refused 422, not parsed as an Integer`,
            testMeta({ id: 'API-CERT-45', row: r.row, prio: 'P1', issue: ISSUE, rule: `COUNT_* take an integer (unparsable = 422); a refusal is a 4xx, never 5xx; core FilterPredicatesBuilder :707-728 parses the value for COUNT_GREATER_THAN / COUNT_LESS_THAN; core's own FilterPredicatesBuilderITest expects a ValidationException for COUNT_EQUAL / COUNT_NOT_EQUAL too${r.unfiled ? `; suspected defect: red until it is filed or fixed (no test.fail, nothing is filed)` : ''}` }),
            async ({ api }, testInfo) => {
                const m = await certificateSeedPlan(api, testInfo, 'API-CERT-45');
                const p = (await searchSeedCertificates(api, m, [propertyFilter('GROUP_NAME', r.condition, r.value)])).probe;
                // Suspected product defect (G-5d / e): COUNT_EQUAL / COUNT_NOT_EQUAL do not parse the value, so the intended 422 is asserted as written and the
                // row is red today. No test.fail: the defect is unfiled; it gets its @bug tag when it is.
                expectRefusal(p, 422, r.text, `${r.condition} ${JSON.stringify(r.value)}`);
            });
    }

    for (const r of COUNT_PINS) {
        test(`GROUP_NAME ${r.condition} ${JSON.stringify(r.value)} (a JSON number) answers 200 with no seed`,
            testMeta({ id: 'API-CERT-45', row: r.row, prio: 'P2', issue: ISSUE, pin: 'Q-COUNT', rule: 'characterisation pin (suspected defect context): a numeric 1.5 or -1 on COUNT_EQUAL is not refused today (the string "1.5" is expected to be refused: see the preceding test, red today); no group count equals it, so 200 and no seed row' }),
            async ({ api }, testInfo) => {
                const m = await certificateSeedPlan(api, testInfo, 'API-CERT-45');
                const r2 = await searchSeedCertificates(api, m, [propertyFilter('GROUP_NAME', r.condition, r.value)]);
                expect(r2.probe.status, `${r.row}: ${r2.probe.text.slice(0, 300)}`).toBe(200);
                expect(r2.ids, `${r.row}: no seed has a group count equal to ${r.value}`).toEqual([]);
                expect(r2.totalItems, `${r.row}: totalItems`).toBe(0);
            });
    }

    for (const r of OWNER_REFUSALS) {
        test(`OWNER ${r.condition} is refused 422 because OWNER is a list field`,
            testMeta({ id: 'API-CERT-45', row: r.row, prio: 'P1', issue: ISSUE, rule: 'a condition the field does not advertise is refused 422 before any predicate is built; core FilterField.java:115 (OWNER is SearchFieldTypeEnum.LIST); NOT_CONTAINS / NOT_MATCHES on OWNER are refused (see searchTables.ts OWNER_REFUSALS)' }),
            async ({ api }, testInfo) => {
                const m = await certificateSeedPlan(api, testInfo, 'API-CERT-45');
                const p = (await searchSeedCertificates(api, m, [propertyFilter('OWNER', r.condition, r.value)])).probe;
                expectRefusal(p, 422, `Field OWNER does not support the ${r.condition} condition; it supports EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY.`, r.row);
            });
    }

    // ------------------------------------------------------------------ 46: attribute-sourced filters on all five types

    test('the five seed attributes publish the absolute condition set of their type',
        testMeta({ id: 'API-CERT-46', row: 'catalogue', prio: 'P1', issue: ISSUE, rule: ['the filter matrix of the search field types (core SearchFieldTypeEnum / SearchHelper.prepareSearchForJSON); ilm#428', 'condition counts: string 10, number 8, date 10, boolean 4, multi-select list 4'] }),
        async ({ api }, testInfo) => {
            const m = await certificateSeedPlan(api, testInfo, 'API-CERT-46');
            const catalogue = await readCatalogue(api);
            const custom = fieldsOf(catalogue, 'custom');
            const want: Array<[keyof SeedAManifest['attributes'], CatalogueField['type'], readonly string[]]> = [
                ['txt', 'string', CONDITION_SETS.string], ['num', 'number', CONDITION_SETS.number], ['day', 'date', CONDITION_SETS.date],
                ['flag', 'boolean', CONDITION_SETS.boolean], ['pick', 'list', CONDITION_SETS.list],
            ];
            const problems: string[] = [];
            for (const [key, type, conditions] of want) {
                const f = custom.find((x) => x.fieldIdentifier === m.attributes[key].identifier);
                if (!f) {
                    problems.push(`${key}: ${m.attributes[key].identifier} is not in the catalogue`);
                    continue;
                }
                if (f.type !== type) problems.push(`${key}: type ${f.type}, expected ${type}`);
                if (!sameSet(f.conditions, conditions)) problems.push(`${key}: conditions [${f.conditions.join(', ')}], expected [${conditions.join(', ')}]`);
            }
            expect(problems).toEqual([]);
        });

    for (const row of ATTRIBUTE_ROWS) {
        rowTest('API-CERT-46', row, 'attribute filters by EXISTS; NOT_EQUALS / NOT_CONTAINS are complements incl. objects without a value; core#741, #813; ilm#428 steps 6, 7', async (api, m, markBug) => expectRow(api, m, row, markBug));
    }

    // ------------------------------------------------------------------ 48: the 422 set of the filter engine

    interface Refusal {
        row: string;
        title: string;
        /** The request body's filter; `m` is SEED-A. */
        filter: (m: SeedAManifest) => Json;
        text: RegExp;
        /** The listing to ask (default: certificates). */
        url?: string;
    }
    const REFUSALS: Refusal[] = [
        { row: 'not-advertised', title: 'KEY_SIZE GREATER, a condition the field does not advertise,', filter: () => propertyFilter('KEY_SIZE', 'GREATER', [2048]), text: /^Field KEY_SIZE does not support the GREATER condition; it supports EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY\.$/ },
        { row: 'missing-value', title: 'a value condition without a value', filter: () => propertyFilter('COMMON_NAME', 'CONTAINS'), text: /^Filter for field COMMON_NAME with operator CONTAINS requires at least one value\.$/ },
        { row: 'empty-value-list', title: 'an empty value list `value: []` on a value condition', filter: () => ({ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: [] }), text: /^Filter for field COMMON_NAME with operator EQUALS requires at least one value\.$/ },
        { row: 'invalid-regex', title: 'MATCHES "(", a regex Java cannot compile,', filter: () => propertyFilter('COMMON_NAME', 'MATCHES', '('), text: /^Input is not a valid regex: / },
        { row: 'quote-sequence', title: 'MATCHES with a \\Q…\\E literal-quote sequence, which POSIX regex lacks,', filter: () => propertyFilter('COMMON_NAME', 'MATCHES', '\\Qabc\\E'), text: /^Literal quote sequences \\Q, \\R, \\G, \\h, \\H, \\z, \\X, \\V are not supported in PostgreSQL POSIX regex$/ },
        { row: 'bad-duration', title: 'IN_NEXT "30 days", a duration that is not ISO-8601,', filter: () => propertyFilter('NOT_AFTER', 'IN_NEXT', '30 days'), text: /^Filter field value 30 days cannot be parsed to a Duration\.$/ },
        { row: 'empty-duration', title: 'IN_NEXT with an empty duration ""', filter: () => propertyFilter('NOT_AFTER', 'IN_NEXT', ''), text: /(cannot be parsed to a Duration\.|requires at least one value\.)/ },
        { row: 'non-numeric-number', title: 'a non-numeric value on an integer custom attribute', filter: (m) => ({ fieldSource: 'custom', fieldIdentifier: m.attributes.num.identifier, condition: 'EQUALS', value: 'abc' }), text: /^Filter field value abc cannot be parsed as an Integer\.$/ },
        { row: 'non-numeric-count', title: 'COUNT_GREATER_THAN "abc", a non-numeric value,', filter: () => propertyFilter('GROUP_NAME', 'COUNT_GREATER_THAN', 'abc'), text: /^Filter field value abc cannot be parsed as an Integer\.$/ },
        { row: 'attribute-without-suffix', title: 'a custom attribute identifier without the |CONTENT_TYPE suffix', filter: (m) => ({ fieldSource: 'custom', fieldIdentifier: m.attributes.txt.name, condition: 'CONTAINS', value: 'red' }), text: /^Filter field identifier .+ does not name an attribute\.$/ },
    ];

    for (const r of REFUSALS) {
        test(`${r.title} is refused with 422`,
            testMeta({ id: 'API-CERT-48', row: r.row, prio: 'P1', issue: ISSUE, rule: ['the 422 cases of the filter engine; a 422 is a JSON array of strings; never a 5xx', 'each case is refused with the fixed text'] }),
            async ({ api }, testInfo) => {
                const m = await certificateSeedPlan(api, testInfo, 'API-CERT-48');
                const p = await send(api, 'POST', r.url ?? '/api/v1/certificates', { data: { filters: [seedIsolation(m), r.filter(m)], itemsPerPage: 10, pageNumber: 1 } });
                expectRefusal(p, 422, r.text, r.row);
            });
    }

    test('a non-numeric CKI_LENGTH on the keys list is refused 422 as not a Number',
        testMeta({ id: 'API-CERT-48', row: 'keys-number', prio: 'P1', issue: ISSUE, rule: ['keys have the NUMBER field CKI_LENGTH, FilterPredicatesBuilder.preparePropertyFilterValues :1081-1089', 'the 422 text is "cannot be parsed as a Number."'] }),
        async ({ api }) => {
            const catalogue = await readCatalogue(api, '/api/v1/keys/search');
            const f = findField(catalogue, 'CKI_LENGTH');
            test.skip(!f, 'the keys catalogue has no CKI_LENGTH field on this build');
            expect(f!.type, 'CKI_LENGTH is a NUMBER field').toBe('number');
            const p = await send(api, 'POST', '/api/v1/keys', { data: { filters: [propertyFilter('CKI_LENGTH', 'GREATER', 'abc')], itemsPerPage: 1, pageNumber: 1 } });
            expectRefusal(p, 422, /^Filter field value abc cannot be parsed as a Number\.$/, 'CKI_LENGTH GREATER abc');
        });

    // ------------------------------------------------------------------ 50: invariants over ALL data

    test('over all certificates, EMPTY plus NOT_EMPTY and EQUALS plus NOT_EQUALS add up to the total',
        testMeta({ id: 'API-CERT-50', prio: 'P1', issue: ISSUE, rule: ['metamorphic invariants of the filters over all data (the three validation fields excluded: core#2503, API-CERT-49); core#741; ilm#428, ilm#442', 'driven by the live catalogue: EMPTY + NOT_EMPTY = total, EQUALS v + NOT_EQUALS v = total, any-of <= sum, AND narrows, contradictions = 0'] }),
        async ({ api }, testInfo) => {
            // About 3 requests per field and sampled value over every source of the catalogue: minutes on a large tier.
            test.setTimeout(900_000);
            const catalogue = await readCatalogue(api);
            let fields = catalogueFields(catalogue);
            // A disabled custom attribute is still offered by the catalogue and its EMPTY answers everything (core#2507, open): the
            // enabled definitions are the ones `GET /v1/attributes/custom/resources/certificates` lists.
            const enabled = await send(api, 'GET', '/api/v1/attributes/custom/resources/certificates');
            const enabledIds = new Set((readJsonOk<Json[]>(enabled, 'custom attributes of certificates') ?? []).map((d) => `${d.name}|${String(d.contentType).toUpperCase()}`));
            const disabled = fields.filter((r) => r.source === 'custom' && !enabledIds.has(r.field.fieldIdentifier));
            if (disabled.length) testInfo.annotations.push({ type: 'excluded', description: `${disabled.length} custom attribute field(s) not in the enabled list (core#2507)` });
            fields = fields.filter((r) => !disabled.includes(r));
            const count: CountFn = async (filters) => (await searchPage(api, { filters, itemsPerPage: 1, pageNumber: 1, includeArchived: true })).totalItems;
            const total = () => count([]);

            const violations = [
                ...(await emptyPartition(fields, count, total)),
                ...(await equalsPartition(fields, count, total)),
                ...(await anyOfBound(fields, count)),
                ...(await andNarrows(narrowingPairs(fields), count)),
                ...(await contradictions(fields, count)),
            ];
            testInfo.annotations.push({ type: 'fields', description: `${fields.length} catalogue fields checked` });
            expect(violations, describeViolations(violations)).toEqual([]);
        });

    // ------------------------------------------------------------------ 51: the complement relations exactly on SEED-A (S-own)

    interface Pair {
        name: string;
        a: (m: SeedAManifest) => Filter[];
        b: (m: SeedAManifest) => Filter[];
        /** The ids the union must equal: all 24 unless the relation excludes null rows. */
        domain?: (m: SeedAManifest) => CertId[];
    }
    const all24 = (m: SeedAManifest): CertId[] => m.certificates.map((c) => c.id);
    const attr = (m: SeedAManifest, key: keyof SeedAManifest['attributes'], condition: string, value?: unknown): Filter =>
        value === undefined ? { fieldSource: 'custom', fieldIdentifier: m.attributes[key].identifier, condition } : { fieldSource: 'custom', fieldIdentifier: m.attributes[key].identifier, condition, value };
    const PAIRS: Pair[] = [
        { name: 'COMMON_NAME CONTAINS and NOT_CONTAINS "web"', a: () => [propertyFilter('COMMON_NAME', 'CONTAINS', 'web')], b: () => [propertyFilter('COMMON_NAME', 'NOT_CONTAINS', 'web')] },
        { name: 'COMMON_NAME EQUALS and NOT_EQUALS on the run\'s gamma-db name', a: (m) => [propertyFilter('COMMON_NAME', 'EQUALS', `${m.prefix}gamma-db`)], b: (m) => [propertyFilter('COMMON_NAME', 'NOT_EQUALS', `${m.prefix}gamma-db`)] },
        { name: 'COMMON_NAME EMPTY and NOT_EMPTY', a: () => [propertyFilter('COMMON_NAME', 'EMPTY')], b: () => [propertyFilter('COMMON_NAME', 'NOT_EMPTY')] },
        { name: 'CERTIFICATE_STATE EQUALS and NOT_EQUALS issued', a: () => [propertyFilter('CERTIFICATE_STATE', 'EQUALS', ['issued'])], b: () => [propertyFilter('CERTIFICATE_STATE', 'NOT_EQUALS', ['issued'])] },
        { name: 'KEY_SIZE EQUALS and NOT_EQUALS 2048', a: () => [propertyFilter('KEY_SIZE', 'EQUALS', [2048])], b: () => [propertyFilter('KEY_SIZE', 'NOT_EQUALS', [2048])] },
        { name: 'KEY_SIZE EMPTY and NOT_EMPTY', a: () => [propertyFilter('KEY_SIZE', 'EMPTY')], b: () => [propertyFilter('KEY_SIZE', 'NOT_EMPTY')] },
        { name: 'GROUP_NAME EQUALS and NOT_EQUALS on the run\'s group a', a: (m) => [propertyFilter('GROUP_NAME', 'EQUALS', [m.groups.a.name])], b: (m) => [propertyFilter('GROUP_NAME', 'NOT_EQUALS', [m.groups.a.name])] },
        { name: 'GROUP_NAME EMPTY and NOT_EMPTY', a: () => [propertyFilter('GROUP_NAME', 'EMPTY')], b: () => [propertyFilter('GROUP_NAME', 'NOT_EMPTY')] },
        { name: 'OWNER EMPTY and NOT_EMPTY', a: () => [propertyFilter('OWNER', 'EMPTY')], b: () => [propertyFilter('OWNER', 'NOT_EMPTY')] },
        { name: 'OWNER EQUALS and NOT_EQUALS on the seed owner', a: (m) => [propertyFilter('OWNER', 'EQUALS', [m.owner.username])], b: (m) => [propertyFilter('OWNER', 'NOT_EQUALS', [m.owner.username])] },
        { name: 'txt CONTAINS and NOT_CONTAINS "red"', a: (m) => [attr(m, 'txt', 'CONTAINS', 'red')], b: (m) => [attr(m, 'txt', 'NOT_CONTAINS', 'red')] },
        { name: 'txt EQUALS and NOT_EQUALS "red"', a: (m) => [attr(m, 'txt', 'EQUALS', 'red')], b: (m) => [attr(m, 'txt', 'NOT_EQUALS', 'red')] },
        { name: 'txt EMPTY and NOT_EMPTY', a: (m) => [attr(m, 'txt', 'EMPTY')], b: (m) => [attr(m, 'txt', 'NOT_EMPTY')] },
        { name: 'num EQUALS and NOT_EQUALS 30', a: (m) => [attr(m, 'num', 'EQUALS', '30')], b: (m) => [attr(m, 'num', 'NOT_EQUALS', '30')] },
        { name: 'num EMPTY and NOT_EMPTY', a: (m) => [attr(m, 'num', 'EMPTY')], b: (m) => [attr(m, 'num', 'NOT_EMPTY')] },
        { name: 'day EQUALS and NOT_EQUALS on one seed\'s date', a: (m) => [attr(m, 'day', 'EQUALS', certById(m, 'C03').day)], b: (m) => [attr(m, 'day', 'NOT_EQUALS', certById(m, 'C03').day)] },
        { name: 'day EMPTY and NOT_EMPTY', a: (m) => [attr(m, 'day', 'EMPTY')], b: (m) => [attr(m, 'day', 'NOT_EMPTY')] },
        { name: 'flag EQUALS and NOT_EQUALS true', a: (m) => [attr(m, 'flag', 'EQUALS', true)], b: (m) => [attr(m, 'flag', 'NOT_EQUALS', true)] },
        { name: 'flag EMPTY and NOT_EMPTY', a: (m) => [attr(m, 'flag', 'EMPTY')], b: (m) => [attr(m, 'flag', 'NOT_EMPTY')] },
        { name: 'pick EQUALS and NOT_EQUALS "a"', a: (m) => [attr(m, 'pick', 'EQUALS', ['a'])], b: (m) => [attr(m, 'pick', 'NOT_EQUALS', ['a'])] },
        { name: 'pick EMPTY and NOT_EMPTY', a: (m) => [attr(m, 'pick', 'EMPTY')], b: (m) => [attr(m, 'pick', 'NOT_EMPTY')] },
    ];

    for (const [i, pair] of PAIRS.entries()) {
        test(`${pair.name} are disjoint and cover ${pair.domain ? 'the rows with a value' : 'all 24 seeds'}`,
            testMeta({ id: 'API-CERT-51', row: String(i + 1).padStart(2, '0'), prio: 'P1', issue: ISSUE, rule: ['NOT_EQUALS / NOT_CONTAINS are the complement incl. nulls; EMPTY / NOT_EMPTY partition; core#741, #813', 'OWNER is a list field: NOT_EQUALS includes the certificates without an owner'] }),
            async ({ api }, testInfo) => {
                const m = await certificateSeedPlan(api, testInfo, 'API-CERT-51');
                const [a, b] = [await searchSeedCertificates(api, m, pair.a(m)), await searchSeedCertificates(api, m, pair.b(m))];
                expect(a.probe.status, a.probe.text.slice(0, 200)).toBe(200);
                expect(b.probe.status, b.probe.text.slice(0, 200)).toBe(200);
                expect(a.ids.filter((id) => b.ids.includes(id)), 'the two sets are disjoint').toEqual([]);
                expect([...a.ids, ...b.ids].sort(), 'the union').toEqual([...(pair.domain ?? all24)(m)].sort());
            });
    }

    // ------------------------------------------------------------------ 52: AND semantics

    test('NOT_AFTER from the 25-day seed\'s expiry and before the 120-day seed\'s returns the three between',
        testMeta({ id: 'API-CERT-52', row: 'window', prio: 'P1', issue: ISSUE, rule: 'filters are ANDed (core#741)' }),
        async ({ api }, testInfo) => {
            const m = await certificateSeedPlan(api, testInfo, 'API-CERT-52');
            const r = await searchSeedCertificates(api, m, [propertyFilter('NOT_AFTER', 'GREATER_OR_EQUAL', notAfterOf(m, 'C03')), propertyFilter('NOT_AFTER', 'LESSER', notAfterOf(m, 'C06'))]);
            expect(r.probe.status, r.probe.text.slice(0, 200)).toBe(200);
            expect(r.ids).toEqual(['C03', 'C04', 'C05']);
        });

    test('state issued AND GROUP_NAME of the run\'s group a returns the six members of group a',
        testMeta({ id: 'API-CERT-52', row: 'state-and-group', prio: 'P1', issue: ISSUE, rule: 'filters are ANDed; a contradicting pair gives an empty set' }),
        async ({ api }, testInfo) => {
            const m = await certificateSeedPlan(api, testInfo, 'API-CERT-52');
            const r = await searchSeedCertificates(api, m, [propertyFilter('CERTIFICATE_STATE', 'EQUALS', ['issued']), propertyFilter('GROUP_NAME', 'EQUALS', [m.groups.a.name])]);
            expect(r.ids).toEqual(['C01', 'C02', 'C03', 'C04', 'C05', 'C06']);
        });

    test('the same field with contradicting conditions returns nothing',
        testMeta({ id: 'API-CERT-52', row: 'contradiction', prio: 'P1', issue: ISSUE, rule: '"I search by 2 contradicting filters at once, and the result set is not empty" was core#741' }),
        async ({ api }, testInfo) => {
            const m = await certificateSeedPlan(api, testInfo, 'API-CERT-52');
            for (const filters of [
                [propertyFilter('NOT_AFTER', 'GREATER', notAfterOf(m, 'C06')), propertyFilter('NOT_AFTER', 'LESSER', notAfterOf(m, 'C03'))],
                [propertyFilter('COMMON_NAME', 'EMPTY'), propertyFilter('COMMON_NAME', 'NOT_EMPTY')],
                [propertyFilter('CERTIFICATE_STATE', 'EQUALS', ['issued']), propertyFilter('CERTIFICATE_STATE', 'EQUALS', ['revoked'])],
            ]) {
                const r = await searchSeedCertificates(api, m, filters);
                expect(r.probe.status, r.probe.text.slice(0, 200)).toBe(200);
                expect(r.ids, filters.map((f) => `${f.fieldIdentifier} ${f.condition}`).join(' AND ')).toEqual([]);
            }
        });

    test('permuting the filters keeps the set and order, and a repeated filter is idempotent',
        testMeta({ id: 'API-CERT-52', row: 'order', prio: 'P1', issue: ISSUE, rule: ['filters are ANDed; includeArchived lifts only the archived predicate (SEED-A has none archived)', 'a third filter only narrows; includeArchived changes nothing here'] }),
        async ({ api }, testInfo) => {
            const m = await certificateSeedPlan(api, testInfo, 'API-CERT-52');
            const f1 = propertyFilter('NOT_AFTER', 'GREATER_OR_EQUAL', notAfterOf(m, 'C03'));
            const f2 = propertyFilter('GROUP_NAME', 'NOT_EMPTY');
            const f3 = propertyFilter('KEY_SIZE', 'EQUALS', [2048]);
            const orders = [[f1, f2, f3], [f3, f2, f1], [f2, f1, f3]];
            const results = [];
            for (const filters of orders) results.push(await searchSeedCertificates(api, m, filters));
            for (const r of results) expect(r.probe.status, r.probe.text.slice(0, 200)).toBe(200);
            for (const r of results.slice(1)) expect(r.uuids, 'same set and same order for a permuted filter list').toEqual(results[0].uuids);
            const twice = await searchSeedCertificates(api, m, [f1, f1, f2]);
            const once = await searchSeedCertificates(api, m, [f1, f2]);
            expect(twice.uuids, 'an identical filter twice is idempotent').toEqual(once.uuids);
            const two = await searchSeedCertificates(api, m, [f1, f2]);
            expect(results[0].ids.filter((id) => !two.ids.includes(id)), 'a third filter only narrows').toEqual([]);
            expect(results[0].ids.length).toBeLessThanOrEqual(two.ids.length);
            const archived = await searchSeedCertificates(api, m, [f1, f2, f3], { includeArchived: true });
            expect(archived.uuids, 'AND with includeArchived: the same rows').toEqual(results[0].uuids);
        });
});
