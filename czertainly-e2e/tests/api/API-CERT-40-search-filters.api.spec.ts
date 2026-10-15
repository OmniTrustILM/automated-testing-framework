/**
 * API-CERT-41 … 52 — the certificate search filters over the run's own SEED-A (ilm#428 T4 steps 3–8, ilm#442 oracles;
 * inventory-api plan §2.2 / §3.2, rules §2.2 / §2.3 / §1.3). `POST /api/v1/certificates` is a read (POST_READ of the
 * guard); the only writes are the seed's own creates and PATCHes (inventorySeedFull.ts: S-own rows 45 / 51 / 52 rest on
 * the group / owner updates of own certificates).
 *
 *   41 text conditions on COMMON_NAME (T-1 … T-14)       42 datetime conditions on NOT_AFTER / NOT_BEFORE (D-1 … D-15)
 *   43 list and enum conditions (L-1 … L-8)              45 collection and owner fields (G-1 … G-6, O-1 … O-3)
 *   46 attribute-sourced filters on the five types       48 the 422 set of the filter engine
 *   50 invariants over ALL data (catalogue-driven)       51 complement relations exactly on SEED-A
 *   52 AND semantics
 *
 * Oracles: exact row sets are the plan's tables (utils/regression/inventoryTables.ts, double entry in tests/unit/
 * inventory-core.spec.ts) over SEED-A with the isolation filter (Common Name starts with the seed prefix); property
 * relations (API-CERT-50) read every certificate of the tier and write no count down. Rows whose rule contradicts today's
 * engine are `test.fail()` + `@bug:` (core#2505 wildcards, core#2504 datetime without offset); rows with no written rule
 * are `@pin` and never P1 (core#712 case sensitivity, Q4 offset). Every refusal asserts status AND body shape
 * (errorContract.ts: a 422 is a JSON array of non-empty strings) and is never a 5xx.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { expect422Messages } from '../../utils/regression/errorContract';
import { prop, readCatalogue, fieldsOf, findField, CONDITION_SETS, searchPage, Filter, sameSet, CatalogueField, send, okJson } from '../../utils/regression/inventoryApi';
import {
    andNarrows, anyOfBound, catalogueFields, contradictions, CountFn, describeViolations, emptyPartition, equalsPartition, filterOf, narrowingPairs,
} from '../../utils/regression/inventoryInvariants';
import { resolveRowContext, searchSeed, seedA } from '../../utils/regression/inventoryRows';
import { CertId, certById, seedIsolation } from '../../utils/regression/inventorySeedFull';
import {
    ATTRIBUTE_EDGES, ATTRIBUTE_ROWS, COLLECTION_ROWS, COUNT_PINS, COUNT_REFUSALS, DATE_REFUSALS, DATE_ROWS, DURATION_REFUSALS, FilterRow, LIST_REFUSALS, LIST_ROWS, notAfterOf,
    OWNER_REFUSALS, TEXT_ROWS,
} from '../../utils/regression/inventoryTables';
import { meta, tags } from '../../utils/regression/tags';
import type { GuardedApi } from '../../utils/regression/guardedApi';
import type { SeedAManifest } from '../../utils/regression/inventorySeedFull';

const ISSUE = 'ilm#428';

type Json = Record<string, any>;

/** The common body of a positive row: 200, the exact seed set, the total. A row with a known bug is `test.fail()` before the failing step. */
async function expectRow(api: GuardedApi, m: SeedAManifest, row: FilterRow, markBug: () => void, ctx = {}, extra: Json = {}): Promise<void> {
    const r = await searchSeed(api, m, row.filters(m, ctx), extra);
    expect(r.probe.status, `${row.row}: ${r.probe.text.slice(0, 300)}`).toBe(200);
    const want = [...row.expect(m)].sort();
    if (row.bug) test.fail(true, `${row.bug}: the rule says the filter value is a literal; the engine treats \`%\` and \`_\` as wildcards today`);
    expect(r.ids, `${row.row} ${row.title}: seeds returned`).toEqual(want);
    expect(r.totalItems, `${row.row}: totalItems`).toBe(want.length);
}

/** A refusal: the status, a JSON array of non-empty strings (422) or {message} (400), the text, never a 5xx. */
function expectRefusal(p: { status: number; contentType: string; text: string }, status: 422 | 400, text: RegExp | string, what: string): void {
    expect(p.status, `${what}: ${p.text.slice(0, 300)}`).toBe(status);
    expect(p.status, `${what}: never a 5xx`).toBeLessThan(500);
    if (status === 422) {
        expect(p.contentType, `${what}: content type`).toMatch(/application\/json/);
        const messages = expect422Messages(p.text);
        const hit = messages.some((s) => (typeof text === 'string' ? s === text : text.test(s)));
        expect(hit, `${what}: ${JSON.stringify(messages)} should match ${String(text)}`).toBe(true);
    }
}

test.describe('API-CERT-40 certificate search filters', { tag: tags.api }, () => {
    /**
     * One table row as one Playwright test (inside the describe so the suite tag is inherited): pins and known bugs are carried by the
     * row (a pin is never P1). `markBug` is `test.fail()` placed right before the failing step by `expectRow`.
     */
    function rowTest(id: string, row: FilterRow, rule: string, run: (api: GuardedApi, m: SeedAManifest, markBug: () => void) => Promise<void>): void {
        test(`${id}[${row.row}]: ${row.title}`,
            meta({ id, prio: row.pin ? 'P2' : 'P1', issue: ISSUE, pin: row.pin, bug: row.bug, rule: `${rule}; plan row ${row.row}` }),
            async ({ api }, testInfo) => {
                const markBug = (): void => {
                    if (row.bug) test.fail(true, `${row.bug}: the rule fixes today's engine behaviour as a bug`);
                };
                await run(api, await seedA(api, testInfo, id), markBug);
            });
    }

    // ------------------------------------------------------------------ 41: text conditions

    for (const row of TEXT_ROWS) {
        rowTest('API-CERT-41', row, 'inventory-api §2.2 r12, r15, §2.3 string row; ilm#428 T4#3', async (api, m, markBug) => expectRow(api, m, row, markBug));
    }

    // ------------------------------------------------------------------ 42: datetime conditions

    for (const row of DATE_ROWS) {
        rowTest('API-CERT-42', row, 'inventory-api §2.2 r17–r18, §2.3 datetime row; core#1030; ilm#428 T4#4', async (api, m, markBug) => expectRow(api, m, row, markBug));
    }

    test('API-CERT-42[D-9]: GREATER_OR_EQUAL T(C03) and LESSER T(C03) partition the set (counts add to 24, row sets disjoint)',
        meta({ id: 'API-CERT-42', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.4 DATETIME: GREATER_OR_EQUAL T + LESSER T = total non-null; plan row D-9' }),
        async ({ api }, testInfo) => {
            const m = await seedA(api, testInfo, 'API-CERT-42');
            const t3 = notAfterOf(m, 'C03');
            const [ge, lt] = [await searchSeed(api, m, [prop('NOT_AFTER', 'GREATER_OR_EQUAL', t3)]), await searchSeed(api, m, [prop('NOT_AFTER', 'LESSER', t3)])];
            expect(ge.probe.status, ge.probe.text.slice(0, 200)).toBe(200);
            expect(lt.probe.status, lt.probe.text.slice(0, 200)).toBe(200);
            expect(ge.uuids.filter((u) => lt.uuids.includes(u)), 'the two sets are disjoint').toEqual([]);
            expect(ge.uuids.length + lt.uuids.length, 'the counts add up to the 24 seeds').toBe(24);
        });

    for (const r of DATE_REFUSALS) {
        // Rule: a datetime that does not parse is a caller error (4xx). Today the engine answers 500 (core#2504, open).
        test(`API-CERT-42[${r.row}]: ${r.title}: 4xx expected, 500 today`,
            meta({ id: 'API-CERT-42', prio: 'P1', issue: ISSUE, bug: r.bug, rule: 'inventory-api §1.3 row "date that does not parse", §2.2 r17 (core#2504 open); plan row D-3' }),
            async ({ api }, testInfo) => {
                const m = await seedA(api, testInfo, 'API-CERT-42');
                const p = (await searchSeed(api, m, [prop('NOT_AFTER', 'EQUALS', r.value(m))])).probe;
                test.fail(true, `${r.bug}: ${p.status} today (500 expected to become a 4xx)`);
                expect(p.status, `${r.row}: ${p.text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
                expect(p.status, `${r.row}: never a 5xx`).toBeLessThan(500);
            });
    }

    for (const r of DURATION_REFUSALS) {
        test(`API-CERT-42[${r.row}]: NOT_AFTER IN_NEXT ${JSON.stringify(r.value)} is refused 422 with the duration text`,
            meta({ id: 'API-CERT-42', prio: 'P1', issue: ISSUE, rule: 'inventory-api §1.3 row "bad duration for IN_NEXT/IN_PAST" (422 `… cannot be parsed to a Duration.`); core#1030; plan row D-14' }),
            async ({ api }, testInfo) => {
                const m = await seedA(api, testInfo, 'API-CERT-42');
                const p = (await searchSeed(api, m, [prop('NOT_AFTER', 'IN_NEXT', r.value)])).probe;
                expectRefusal(p, 422, r.text, `IN_NEXT ${JSON.stringify(r.value)}`);
            });
    }

    // ------------------------------------------------------------------ 43: list and enum conditions

    for (const row of LIST_ROWS) {
        rowTest('API-CERT-43', row, 'inventory-api §2.2 r14 (enum lists compare the code; any-of / none-of), §2.3 list row; ilm#428 T4#5', async (api, m, markBug) => {
            const ctx = await resolveRowContext(api, m);
            await expectRow(api, m, row, markBug, ctx);
        });
    }

    for (const r of LIST_REFUSALS) {
        test(`API-CERT-43[${r.row}]: ${r.filter.fieldIdentifier} ${r.filter.condition} is refused 422 naming the supported conditions`,
            meta({ id: 'API-CERT-43', prio: 'P1', issue: ISSUE, rule: 'inventory-api §1.3 row "condition not advertised" (FilterPredicatesBuilder.requireAdvertisedCondition); plan row L-4' }),
            async ({ api }, testInfo) => {
                const m = await seedA(api, testInfo, 'API-CERT-43');
                expectRefusal((await searchSeed(api, m, [r.filter])).probe, 422, r.text, r.row);
            });
    }

    // ------------------------------------------------------------------ 45: collection and owner fields (S-own: groups and owner come from the seed PATCHes)

    for (const row of COLLECTION_ROWS) {
        rowTest('API-CERT-45', row, 'inventory-api §2.2 r12–r14, r16 (collection EQUALS any-of / NOT_EQUALS none-of, EMPTY, COUNT_*; OWNER null handling r15); core#1117; ilm#428 T4#5', async (api, m, markBug) => expectRow(api, m, row, markBug));
    }

    for (const r of COUNT_REFUSALS) {
        test(`API-CERT-45[${r.row}]: GROUP_NAME ${r.condition} ${JSON.stringify(r.value)} is refused 422 "cannot be parsed as an Integer."${r.unfiled ? " (suspected defect, unfiled)" : ''}`,
            meta({ id: 'API-CERT-45', prio: 'P1', issue: ISSUE, rule: `inventory-api §2.2 r16 (COUNT_* take an integer; unparsable = 422), §1.2 r6 (4xx, never 5xx); core FilterPredicatesBuilder :707-728 parses the value for COUNT_GREATER_THAN / COUNT_LESS_THAN; core's own FilterPredicatesBuilderITest expects a ValidationException for COUNT_EQUAL / COUNT_NOT_EQUAL too; plan row G-5${r.unfiled ? `; suspected defect: red until it is filed or fixed (no test.fail, nothing is filed)` : ''}` }),
            async ({ api }, testInfo) => {
                const m = await seedA(api, testInfo, 'API-CERT-45');
                const p = (await searchSeed(api, m, [prop('GROUP_NAME', r.condition, r.value)])).probe;
                // Suspected product defect (G-5d / e): COUNT_EQUAL / COUNT_NOT_EQUAL do not parse the value, so the intended 422 is asserted as written and the
                // row is red today. No test.fail: the defect is unfiled; it gets its @bug tag when it is.
                expectRefusal(p, 422, r.text, `${r.condition} ${JSON.stringify(r.value)}`);
            });
    }

    for (const r of COUNT_PINS) {
        test(`API-CERT-45[${r.row}]: GROUP_NAME ${r.condition} ${JSON.stringify(r.value)} (a JSON number, not a whole count) answers 200 with no seed today`,
            meta({ id: 'API-CERT-45', prio: 'P2', issue: ISSUE, pin: 'Q-COUNT', rule: 'characterisation pin (suspected defect context): a numeric 1.5 or -1 on COUNT_EQUAL is not refused today (the string "1.5" is the open C1 row G-5e); no group count equals it, so 200 and no seed row; plan row G-5' }),
            async ({ api }, testInfo) => {
                const m = await seedA(api, testInfo, 'API-CERT-45');
                const r2 = await searchSeed(api, m, [prop('GROUP_NAME', r.condition, r.value)]);
                expect(r2.probe.status, `${r.row}: ${r2.probe.text.slice(0, 300)}`).toBe(200);
                expect(r2.ids, `${r.row}: no seed has a group count equal to ${r.value}`).toEqual([]);
                expect(r2.totalItems, `${r.row}: totalItems`).toBe(0);
            });
    }

    for (const r of OWNER_REFUSALS) {
        test(`API-CERT-45[${r.row}]: OWNER ${r.condition} is refused 422: OWNER is a list field (EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY only)`,
            meta({ id: 'API-CERT-45', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r8 (a condition the field does not advertise is refused 422 before any predicate is built), §2.3 list row; core FilterField.java:115 (OWNER is SearchFieldTypeEnum.LIST); plan row O-2 (the plan expected NOT_CONTAINS / NOT_MATCHES on OWNER: a plan deviation, see inventoryTables.ts OWNER_REFUSALS)' }),
            async ({ api }, testInfo) => {
                const m = await seedA(api, testInfo, 'API-CERT-45');
                const p = (await searchSeed(api, m, [prop('OWNER', r.condition, r.value)])).probe;
                expectRefusal(p, 422, `Field OWNER does not support the ${r.condition} condition; it supports EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY.`, r.row);
            });
    }

    // ------------------------------------------------------------------ 46: attribute-sourced filters on all five types

    test('API-CERT-46[catalogue]: the five seed attributes are published with the absolute condition set of their type (string 10, number 8, date 10, boolean 4, multi-select list 4)',
        meta({ id: 'API-CERT-46', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.3 filter matrix (core SearchFieldTypeEnum / SearchHelper.prepareSearchForJSON); ilm#428 T4#6, #7' }),
        async ({ api }, testInfo) => {
            const m = await seedA(api, testInfo, 'API-CERT-46');
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
        rowTest('API-CERT-46', row, 'inventory-api §2.2 r10–r12, r16–r18 (attribute filters by EXISTS; NOT_EQUALS / NOT_CONTAINS are complements incl. objects without a value; core#741, #813); ilm#428 T4#6, #7', async (api, m, markBug) => expectRow(api, m, row, markBug));
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
        { row: 'not-advertised', title: 'a condition the field does not advertise (KEY_SIZE GREATER)', filter: () => prop('KEY_SIZE', 'GREATER', [2048]), text: /^Field KEY_SIZE does not support the GREATER condition; it supports EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY\.$/ },
        { row: 'missing-value', title: 'a value condition without a value', filter: () => prop('COMMON_NAME', 'CONTAINS'), text: /^Filter for field COMMON_NAME with operator CONTAINS requires at least one value\.$/ },
        { row: 'empty-value-list', title: '`value: []` on a value condition', filter: () => ({ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: [] }), text: /^Filter for field COMMON_NAME with operator EQUALS requires at least one value\.$/ },
        { row: 'invalid-regex', title: 'MATCHES with a regex Java cannot compile', filter: () => prop('COMMON_NAME', 'MATCHES', '('), text: /^Input is not a valid regex: / },
        { row: 'quote-sequence', title: 'MATCHES with a \\Q literal-quote sequence', filter: () => prop('COMMON_NAME', 'MATCHES', '\\Qabc\\E'), text: /^Literal quote sequences \\Q, \\R, \\G, \\h, \\H, \\z, \\X, \\V are not supported in PostgreSQL POSIX regex$/ },
        { row: 'bad-duration', title: 'IN_NEXT with a duration that is not ISO-8601', filter: () => prop('NOT_AFTER', 'IN_NEXT', '30 days'), text: /^Filter field value 30 days cannot be parsed to a Duration\.$/ },
        { row: 'empty-duration', title: 'IN_NEXT with an empty duration', filter: () => prop('NOT_AFTER', 'IN_NEXT', ''), text: /(cannot be parsed to a Duration\.|requires at least one value\.)/ },
        { row: 'non-numeric-number', title: 'a non-numeric value on an integer custom attribute', filter: (m) => ({ fieldSource: 'custom', fieldIdentifier: m.attributes.num.identifier, condition: 'EQUALS', value: 'abc' }), text: /^Filter field value abc cannot be parsed as an Integer\.$/ },
        { row: 'non-numeric-count', title: 'COUNT_GREATER_THAN with a non-numeric value', filter: () => prop('GROUP_NAME', 'COUNT_GREATER_THAN', 'abc'), text: /^Filter field value abc cannot be parsed as an Integer\.$/ },
        { row: 'attribute-without-suffix', title: 'a custom attribute identifier without the |CONTENT_TYPE suffix', filter: (m) => ({ fieldSource: 'custom', fieldIdentifier: m.attributes.txt.name, condition: 'CONTAINS', value: 'red' }), text: /^Filter field identifier .+ does not name an attribute\.$/ },
    ];

    for (const r of REFUSALS) {
        test(`API-CERT-48[${r.row}]: ${r.title} is refused 422 with the fixed text`,
            meta({ id: 'API-CERT-48', prio: 'P1', issue: ISSUE, rule: 'inventory-api §1.3 status matrix (422 rows of the filter engine), §1.2 r2 (a 422 is a JSON array of strings), §1.2 r6 (never a 5xx); QA#10' }),
            async ({ api }, testInfo) => {
                const m = await seedA(api, testInfo, 'API-CERT-48');
                const p = await send(api, 'POST', r.url ?? '/api/v1/certificates', { data: { filters: [seedIsolation(m), r.filter(m)], itemsPerPage: 10, pageNumber: 1 } });
                expectRefusal(p, 422, r.text, r.row);
            });
    }

    test('API-CERT-48[keys-number]: a non-numeric value on the NUMBER field CKI_LENGTH of the keys list is refused 422 "cannot be parsed as a Number."',
        meta({ id: 'API-CERT-48', prio: 'P1', issue: ISSUE, rule: 'inventory-api §3.5 (keys have the NUMBER field CKI_LENGTH), FilterPredicatesBuilder.preparePropertyFilterValues :1081-1089; QA#10' }),
        async ({ api }) => {
            const catalogue = await readCatalogue(api, '/api/v1/keys/search');
            const f = findField(catalogue, 'CKI_LENGTH');
            test.skip(!f, 'the keys catalogue has no CKI_LENGTH field on this build');
            expect(f!.type, 'CKI_LENGTH is a NUMBER field').toBe('number');
            const p = await send(api, 'POST', '/api/v1/keys', { data: { filters: [prop('CKI_LENGTH', 'GREATER', 'abc')], itemsPerPage: 1, pageNumber: 1 } });
            expectRefusal(p, 422, /^Filter field value abc cannot be parsed as a Number\.$/, 'CKI_LENGTH GREATER abc');
        });

    // ------------------------------------------------------------------ 50: invariants over ALL data

    test('API-CERT-50: relations over all certificates, driven by the live catalogue: EMPTY + NOT_EMPTY = total, EQUALS v + NOT_EQUALS v = total, any-of <= sum, AND narrows, contradictions = 0',
        meta({ id: 'API-CERT-50', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r9, r12–r14, §2.3 "Observed metamorphic invariants" (the three validation fields excluded: core#2503, API-CERT-49); core#741; ilm#428 T4#3–8, ilm#442 oracles' }),
        async ({ api }, testInfo) => {
            // About 3 requests per field and sampled value over every source of the catalogue: minutes on a large tier.
            test.setTimeout(900_000);
            const catalogue = await readCatalogue(api);
            let fields = catalogueFields(catalogue);
            // A disabled custom attribute is still offered by the catalogue and its EMPTY answers everything (core#2507, open): the
            // enabled definitions are the ones `GET /v1/attributes/custom/resources/certificates` lists.
            const enabled = await send(api, 'GET', '/api/v1/attributes/custom/resources/certificates');
            const enabledIds = new Set((okJson<Json[]>(enabled, 'custom attributes of certificates') ?? []).map((d) => `${d.name}|${String(d.contentType).toUpperCase()}`));
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
        { name: 'COMMON_NAME CONTAINS / NOT_CONTAINS web', a: () => [prop('COMMON_NAME', 'CONTAINS', 'web')], b: () => [prop('COMMON_NAME', 'NOT_CONTAINS', 'web')] },
        { name: 'COMMON_NAME EQUALS / NOT_EQUALS <P>gamma-db', a: (m) => [prop('COMMON_NAME', 'EQUALS', `${m.prefix}gamma-db`)], b: (m) => [prop('COMMON_NAME', 'NOT_EQUALS', `${m.prefix}gamma-db`)] },
        { name: 'COMMON_NAME EMPTY / NOT_EMPTY', a: () => [prop('COMMON_NAME', 'EMPTY')], b: () => [prop('COMMON_NAME', 'NOT_EMPTY')] },
        { name: 'CERTIFICATE_STATE EQUALS / NOT_EQUALS issued', a: () => [prop('CERTIFICATE_STATE', 'EQUALS', ['issued'])], b: () => [prop('CERTIFICATE_STATE', 'NOT_EQUALS', ['issued'])] },
        { name: 'KEY_SIZE EQUALS / NOT_EQUALS 2048', a: () => [prop('KEY_SIZE', 'EQUALS', [2048])], b: () => [prop('KEY_SIZE', 'NOT_EQUALS', [2048])] },
        { name: 'KEY_SIZE EMPTY / NOT_EMPTY', a: () => [prop('KEY_SIZE', 'EMPTY')], b: () => [prop('KEY_SIZE', 'NOT_EMPTY')] },
        { name: 'GROUP_NAME EQUALS / NOT_EQUALS <P>grp-a', a: (m) => [prop('GROUP_NAME', 'EQUALS', [m.groups.a.name])], b: (m) => [prop('GROUP_NAME', 'NOT_EQUALS', [m.groups.a.name])] },
        { name: 'GROUP_NAME EMPTY / NOT_EMPTY', a: () => [prop('GROUP_NAME', 'EMPTY')], b: () => [prop('GROUP_NAME', 'NOT_EMPTY')] },
        { name: 'OWNER EMPTY / NOT_EMPTY', a: () => [prop('OWNER', 'EMPTY')], b: () => [prop('OWNER', 'NOT_EMPTY')] },
        { name: 'OWNER EQUALS / NOT_EQUALS the owner (a list field: NOT_EQUALS includes the certificates without an owner)', a: (m) => [prop('OWNER', 'EQUALS', [m.owner.username])], b: (m) => [prop('OWNER', 'NOT_EQUALS', [m.owner.username])] },
        { name: 'txt CONTAINS / NOT_CONTAINS red', a: (m) => [attr(m, 'txt', 'CONTAINS', 'red')], b: (m) => [attr(m, 'txt', 'NOT_CONTAINS', 'red')] },
        { name: 'txt EQUALS / NOT_EQUALS red', a: (m) => [attr(m, 'txt', 'EQUALS', 'red')], b: (m) => [attr(m, 'txt', 'NOT_EQUALS', 'red')] },
        { name: 'txt EMPTY / NOT_EMPTY', a: (m) => [attr(m, 'txt', 'EMPTY')], b: (m) => [attr(m, 'txt', 'NOT_EMPTY')] },
        { name: 'num EQUALS / NOT_EQUALS 30', a: (m) => [attr(m, 'num', 'EQUALS', '30')], b: (m) => [attr(m, 'num', 'NOT_EQUALS', '30')] },
        { name: 'num EMPTY / NOT_EMPTY', a: (m) => [attr(m, 'num', 'EMPTY')], b: (m) => [attr(m, 'num', 'NOT_EMPTY')] },
        { name: 'day EQUALS / NOT_EQUALS the C03 date', a: (m) => [attr(m, 'day', 'EQUALS', certById(m, 'C03').day)], b: (m) => [attr(m, 'day', 'NOT_EQUALS', certById(m, 'C03').day)] },
        { name: 'day EMPTY / NOT_EMPTY', a: (m) => [attr(m, 'day', 'EMPTY')], b: (m) => [attr(m, 'day', 'NOT_EMPTY')] },
        { name: 'flag EQUALS / NOT_EQUALS true', a: (m) => [attr(m, 'flag', 'EQUALS', true)], b: (m) => [attr(m, 'flag', 'NOT_EQUALS', true)] },
        { name: 'flag EMPTY / NOT_EMPTY', a: (m) => [attr(m, 'flag', 'EMPTY')], b: (m) => [attr(m, 'flag', 'NOT_EMPTY')] },
        { name: 'pick EQUALS / NOT_EQUALS [a]', a: (m) => [attr(m, 'pick', 'EQUALS', ['a'])], b: (m) => [attr(m, 'pick', 'NOT_EQUALS', ['a'])] },
        { name: 'pick EMPTY / NOT_EMPTY', a: (m) => [attr(m, 'pick', 'EMPTY')], b: (m) => [attr(m, 'pick', 'NOT_EMPTY')] },
    ];

    for (const [i, pair] of PAIRS.entries()) {
        test(`API-CERT-51[${String(i + 1).padStart(2, '0')}]: ${pair.name}: disjoint, union = ${pair.domain ? 'the rows with a value' : 'the 24 seeds'}`,
            meta({ id: 'API-CERT-51', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r12–r14 (NOT_EQUALS / NOT_CONTAINS are the complement incl. nulls; EMPTY / NOT_EMPTY partition); core#741, #813' }),
            async ({ api }, testInfo) => {
                const m = await seedA(api, testInfo, 'API-CERT-51');
                const [a, b] = [await searchSeed(api, m, pair.a(m)), await searchSeed(api, m, pair.b(m))];
                expect(a.probe.status, a.probe.text.slice(0, 200)).toBe(200);
                expect(b.probe.status, b.probe.text.slice(0, 200)).toBe(200);
                expect(a.ids.filter((id) => b.ids.includes(id)), 'the two sets are disjoint').toEqual([]);
                expect([...a.ids, ...b.ids].sort(), 'the union').toEqual([...(pair.domain ?? all24)(m)].sort());
            });
    }

    // ------------------------------------------------------------------ 52: AND semantics

    test('API-CERT-52[window]: NOT_AFTER >= T(C03) AND < T(C06) = {C03, C04, C05}',
        meta({ id: 'API-CERT-52', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r9 (filters are ANDed; core#741)' }),
        async ({ api }, testInfo) => {
            const m = await seedA(api, testInfo, 'API-CERT-52');
            const r = await searchSeed(api, m, [prop('NOT_AFTER', 'GREATER_OR_EQUAL', notAfterOf(m, 'C03')), prop('NOT_AFTER', 'LESSER', notAfterOf(m, 'C06'))]);
            expect(r.probe.status, r.probe.text.slice(0, 200)).toBe(200);
            expect(r.ids).toEqual(['C03', 'C04', 'C05']);
        });

    test('API-CERT-52[state-and-group]: CERTIFICATE_STATE issued AND GROUP_NAME <P>grp-a = the 6 members of group a',
        meta({ id: 'API-CERT-52', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r9, r14' }),
        async ({ api }, testInfo) => {
            const m = await seedA(api, testInfo, 'API-CERT-52');
            const r = await searchSeed(api, m, [prop('CERTIFICATE_STATE', 'EQUALS', ['issued']), prop('GROUP_NAME', 'EQUALS', [m.groups.a.name])]);
            expect(r.ids).toEqual(['C01', 'C02', 'C03', 'C04', 'C05', 'C06']);
        });

    test('API-CERT-52[contradiction]: the same field with contradicting conditions returns nothing (core#741)',
        meta({ id: 'API-CERT-52', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r9: "I search by 2 contradicting filters at once, and the result set is not empty" was core#741' }),
        async ({ api }, testInfo) => {
            const m = await seedA(api, testInfo, 'API-CERT-52');
            for (const filters of [
                [prop('NOT_AFTER', 'GREATER', notAfterOf(m, 'C06')), prop('NOT_AFTER', 'LESSER', notAfterOf(m, 'C03'))],
                [prop('COMMON_NAME', 'EMPTY'), prop('COMMON_NAME', 'NOT_EMPTY')],
                [prop('CERTIFICATE_STATE', 'EQUALS', ['issued']), prop('CERTIFICATE_STATE', 'EQUALS', ['revoked'])],
            ]) {
                const r = await searchSeed(api, m, filters);
                expect(r.probe.status, r.probe.text.slice(0, 200)).toBe(200);
                expect(r.ids, filters.map((f) => `${f.fieldIdentifier} ${f.condition}`).join(' AND ')).toEqual([]);
            }
        });

    test('API-CERT-52[order]: permuting the filters gives the same set in the same order; an identical filter twice is idempotent; a third filter only narrows; includeArchived changes nothing here',
        meta({ id: 'API-CERT-52', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r9, r6 (includeArchived lifts only the archived predicate; SEED-A has none archived)' }),
        async ({ api }, testInfo) => {
            const m = await seedA(api, testInfo, 'API-CERT-52');
            const f1 = prop('NOT_AFTER', 'GREATER_OR_EQUAL', notAfterOf(m, 'C03'));
            const f2 = prop('GROUP_NAME', 'NOT_EMPTY');
            const f3 = prop('KEY_SIZE', 'EQUALS', [2048]);
            const orders = [[f1, f2, f3], [f3, f2, f1], [f2, f1, f3]];
            const results = [];
            for (const filters of orders) results.push(await searchSeed(api, m, filters));
            for (const r of results) expect(r.probe.status, r.probe.text.slice(0, 200)).toBe(200);
            for (const r of results.slice(1)) expect(r.uuids, 'same set and same order for a permuted filter list').toEqual(results[0].uuids);
            const twice = await searchSeed(api, m, [f1, f1, f2]);
            const once = await searchSeed(api, m, [f1, f2]);
            expect(twice.uuids, 'an identical filter twice is idempotent').toEqual(once.uuids);
            const two = await searchSeed(api, m, [f1, f2]);
            expect(results[0].ids.filter((id) => !two.ids.includes(id)), 'a third filter only narrows').toEqual([]);
            expect(results[0].ids.length).toBeLessThanOrEqual(two.ids.length);
            const archived = await searchSeed(api, m, [f1, f2, f3], { includeArchived: true });
            expect(archived.uuids, 'AND with includeArchived: the same rows').toEqual(results[0].uuids);
        });
});
