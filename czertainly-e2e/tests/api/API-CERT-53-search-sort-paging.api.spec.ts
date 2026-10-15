/**
 * API-CERT-53, 54, 56 — certificate search: sorting and paging over the run's own SEED-A (ilm#428 T4 steps 9–11; inventory-api
 * plan §2.2 "Sort oracles (Cmp)", §3.2; rules §2.2 r2–r5, r21–r24, §1.3).
 *
 *   53 sort on property fields NOT_AFTER, NOT_BEFORE (the C21 / C22 tie), GROUP_NAME (min asc / max desc), OWNER: both directions,
 *      rows without a value last in both directions, the uuid tie-break stable across two reads and across a page boundary,
 *      pages of 10 concatenated = one request of 24                                                       (S-own: groups / owner)
 *   54 sort on attribute columns: `num` numerically, `day` chronologically, `txt`, `pick` (smallest value ascending, largest descending), nulls last
 *   56 paging contract and combined requests: sizes 1 / 10 / 24 / 25 / 1000, totalPages = ceil(totalItems / itemsPerPage), a page past the
 *      last, defaults, the 400 of pageNumber 0 / itemsPerPage 0 / negatives, pairwise combinations, default order = created descending
 *
 * Oracles: the comparator over the manifest (inventoryTables.ts `expectedUuidOrder`: values in the requested direction, every row
 * without a value last in BOTH directions, ties by uuid ASCENDING — core SortOrderBuilder.tieBreak :253-259 `criteriaBuilder.asc(uuid)`,
 * core#2394: this answers the plan's question Q-G from the code instead of "pinned after the first observation"). The `txt` order is
 * collation-dependent in the database (C vs en_US: `Red` / `red`): only the collation-independent facts are asserted for it.
 * The huge-value probes of itemsPerPage live in API-GEN-10 (P2).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { expectMessageObject } from '../../utils/regression/errorContract';
import { walkPages } from '../../utils/regression/invariants';
import { Filter, findField, prop, readCatalogue, searchPage, searchRaw, Json } from '../../utils/regression/inventoryApi';
import { searchSeed, seedA } from '../../utils/regression/inventoryRows';
import { CertId, SEED_A_DEFAULT_ORDER, seedIsolation, uuidsOfIds } from '../../utils/regression/inventorySeedFull';
import type { SeedAManifest } from '../../utils/regression/inventorySeedFull';
import { expectedUuidOrder, SortField } from '../../utils/regression/inventoryTables';
import { meta, tags } from '../../utils/regression/tags';
import type { GuardedApi } from '../../utils/regression/guardedApi';

const ISSUE = 'ilm#428';

interface SortSpec {
    fieldSource: 'property' | 'custom';
    fieldIdentifier: string;
    direction: 'asc' | 'desc';
}

/** The seed rows in the server's order: all 24 on one page. */
async function sortedSeed(api: GuardedApi, m: SeedAManifest, sort: SortSpec | undefined, filters: Filter[] = []): Promise<{ uuids: string[]; /** in the order the server answered */ ids: CertId[]; status: number; text: string }> {
    const r = await searchSeed(api, m, filters, sort ? { sort } : {});
    return { uuids: r.uuids, ids: r.ordered, status: r.probe.status, text: r.probe.text };
}

/** The same order read in pages of `size`, concatenated (the isolation filter keeps it at 24 rows). */
async function pagedSeed(api: GuardedApi, m: SeedAManifest, sort: SortSpec | undefined, size: number, filters: Filter[] = [], extra: Json = {}): Promise<string[]> {
    const walked = await walkPages(
        async (pageNumber, itemsPerPage) => {
            const p = await searchPage(api, { filters: [seedIsolation(m), ...filters], itemsPerPage, pageNumber, ...(sort ? { sort } : {}), ...extra });
            return { items: p.rows, totalItems: p.totalItems, totalPages: p.totalPages };
        },
        { pageSize: size },
    );
    return walked.items.map((r) => String(r.uuid));
}

/** Is the field offered as `sortable` by the live catalogue (rules §2.2 r24: sort only works on sortable fields)? */
async function assertSortable(api: GuardedApi, source: 'property' | 'custom', identifier: string): Promise<void> {
    const f = findField(await readCatalogue(api), identifier, source);
    expect(f, `${identifier} is in the catalogue`).toBeTruthy();
    expect(f!.sortable, `${identifier} is sortable (rules §2.2 r24, core#2031 AC4)`).toBe(true);
}

test.describe('API-CERT-53 certificate search: sorting and paging', { tag: tags.api }, () => {
    // ------------------------------------------------------------------ 53: property fields

    const PROPERTY_SORTS: Array<{ field: SortField; label: string }> = [
        { field: 'NOT_AFTER', label: 'Expires At (a unique value per seed except the C21 / C22 tie)' },
        { field: 'NOT_BEFORE', label: 'Valid From (a unique value per seed except the C21 / C22 tie)' },
        { field: 'GROUP_NAME', label: 'Group (smallest group name ascending, largest descending; 16 without a group last)' },
        { field: 'OWNER', label: 'Owner (22 without an owner last)' },
    ];

    for (const { field, label } of PROPERTY_SORTS) {
        for (const dir of ['asc', 'desc'] as const) {
            test(`API-CERT-53[${field}.${dir}]: sort by ${label}, ${dir}: the comparator order, nulls last, stable across two reads and across page boundaries`,
                meta({ id: 'API-CERT-53', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r4 (uuid tie-break), r21–r23 (whole set ordered before paging; objects without a value last in both directions; multi-valued: min asc / max desc), r24; core#2031, #2394; ilm#322 (Hibernate 7 null ordering)' }),
                async ({ api }, testInfo) => {
                    const m = await seedA(api, testInfo, 'API-CERT-53');
                    await assertSortable(api, 'property', field);
                    const sort: SortSpec = { fieldSource: 'property', fieldIdentifier: field, direction: dir };
                    const first = await sortedSeed(api, m, sort);
                    expect(first.status, first.text.slice(0, 300)).toBe(200);
                    expect(first.uuids, `${field} ${dir}: the 24 seeds in the comparator order (groups of equal keys ordered by uuid ascending)`).toEqual(expectedUuidOrder(m, field, dir));
                    // The same read twice: the order does not move (a unique tie-break, core#2030).
                    const second = await sortedSeed(api, m, sort);
                    expect(second.uuids, 'the order is stable across two reads').toEqual(first.uuids);
                    // Pages of 10 (the boundaries fall inside tie groups for GROUP_NAME / OWNER): concatenated = the one request of 24.
                    expect(await pagedSeed(api, m, sort, 10), 'pages of 10 concatenated').toEqual(first.uuids);
                });
        }
    }

    // ------------------------------------------------------------------ 54: attribute columns

    const ATTRIBUTE_SORTS: Array<{ key: 'num' | 'day' | 'pick'; field: SortField; what: string }> = [
        { key: 'num', field: 'num', what: 'numerically (-5, 0, 10 … 100, 1000: a text sort would put 100 and 1000 before 20)' },
        { key: 'day', field: 'day', what: 'chronologically' },
        { key: 'pick', field: 'pick', what: 'by the smallest value ascending and the largest descending' },
    ];

    for (const { key, field, what } of ATTRIBUTE_SORTS) {
        for (const dir of ['asc', 'desc'] as const) {
            test(`API-CERT-54[${key}.${dir}]: sort by the ${key} attribute column ${what}, ${dir}, rows without a value last`,
                meta({ id: 'API-CERT-54', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r22 (nulls last both directions), r23 (multi-valued: min asc / max desc); core#2033 AC1, AC3, core#2394; ilm#428 T4#9, #10' }),
                async ({ api }, testInfo) => {
                    const m = await seedA(api, testInfo, 'API-CERT-54');
                    const identifier = m.attributes[key].identifier;
                    await assertSortable(api, 'custom', identifier);
                    const sort: SortSpec = { fieldSource: 'custom', fieldIdentifier: identifier, direction: dir };
                    const r = await sortedSeed(api, m, sort);
                    expect(r.status, r.text.slice(0, 300)).toBe(200);
                    expect(r.uuids, `${key} ${dir}`).toEqual(expectedUuidOrder(m, field, dir));
                });
        }
    }

    for (const dir of ['asc', 'desc'] as const) {
        test(`API-CERT-54[txt.${dir}]: sort by the txt attribute column, ${dir}: nulls last; the lowercase values in order (the C03 value \`Red\` sits where the database collation puts it)`,
            meta({ id: 'API-CERT-54', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r22, r23; string order depends on the database collation (C vs en_US), so only the collation-independent facts are asserted (annulled < blue < green < red < red-blue)' }),
            async ({ api }, testInfo) => {
                const m = await seedA(api, testInfo, 'API-CERT-54');
                const identifier = m.attributes.txt.identifier;
                await assertSortable(api, 'custom', identifier);
                const r = await sortedSeed(api, m, { fieldSource: 'custom', fieldIdentifier: identifier, direction: dir });
                expect(r.status, r.text.slice(0, 300)).toBe(200);
                const withValue = m.certificates.filter((c) => c.txt !== null).map((c) => c.id);
                const without = m.certificates.filter((c) => c.txt === null).map((c) => c.id);
                const head = r.ids.slice(0, withValue.length);
                expect([...head].sort(), 'the 7 certificates with a value come first').toEqual([...withValue].sort());
                expect([...r.ids.slice(withValue.length)].sort(), 'the 17 without a value are the last block, in both directions').toEqual([...without].sort());
                // The six lowercase values, C03's mixed-case `Red` left out: annulled (C09) < blue (C05) < green (C04) < red (C01, C02) < red-blue (C06).
                const lowercase = head.filter((id) => id !== 'C03');
                const rank = (id: CertId): number => ({ C09: 0, C05: 1, C04: 2, C01: 3, C02: 3, C06: 4 } as Record<string, number>)[id];
                const ranks = lowercase.map(rank);
                const sorted = [...ranks].sort((a, b) => (dir === 'asc' ? a - b : b - a));
                expect(ranks, `${dir}: ${lowercase.join(', ')}`).toEqual(sorted);
            });
    }

    // ------------------------------------------------------------------ 56: paging contract and combined requests

    test('API-CERT-56[default-order]: with no sort the listing is created descending: C23 … C01, then the CA C24 (uploaded first)',
        meta({ id: 'API-CERT-56', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r4 (default order created descending, CertificateServiceImpl :614; uuid tie-break); ilm#133 AC12 (legacy shape and order)' }),
        async ({ api }, testInfo) => {
            const m = await seedA(api, testInfo, 'API-CERT-56');
            const r = await sortedSeed(api, m, undefined);
            expect(r.status, r.text.slice(0, 300)).toBe(200);
            expect(r.ids, 'default order = SEED_A_DEFAULT_ORDER').toEqual([...SEED_A_DEFAULT_ORDER]);
        });

    for (const size of [1, 10, 24, 25, 1000]) {
        test(`API-CERT-56[size-${size}]: itemsPerPage ${size} over the 24 seeds: totalPages = ceil(24 / ${size}), full pages, the union is the set`,
            meta({ id: 'API-CERT-56', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r2 (totalPages = ceil(totalItems / itemsPerPage)), r5 (itemsPerPage maximum 1000 is documentation); ilm#428 T4#11' }),
            async ({ api }, testInfo) => {
                const m = await seedA(api, testInfo, 'API-CERT-56');
                const first = await searchPage(api, { filters: [seedIsolation(m)], itemsPerPage: size, pageNumber: 1 });
                expect(first.totalItems).toBe(24);
                expect(first.itemsPerPage, 'the page size is echoed').toBe(size);
                expect(first.pageNumber).toBe(1);
                expect(first.totalPages).toBe(Math.ceil(24 / size));
                expect(first.rows).toHaveLength(Math.min(size, 24));
                const uuids = await pagedSeed(api, m, undefined, size);
                expect([...uuids].sort(), 'the pages cover every seed exactly once').toEqual(uuidsOfIds(m, m.certificates.map((c) => c.id)));
            });
    }

    test('API-CERT-56[past-last]: a page past the last answers 200, an empty list and the same totals',
        meta({ id: 'API-CERT-56', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r2 ("A page past the last answers 200 with an empty list and the real totalItems / totalPages")' }),
        async ({ api }, testInfo) => {
            const m = await seedA(api, testInfo, 'API-CERT-56');
            for (const pageNumber of [4, 99_999_999]) {
                const p = await searchPage(api, { filters: [seedIsolation(m)], itemsPerPage: 10, pageNumber });
                expect(p.rows, `page ${pageNumber}`).toEqual([]);
                expect(p.totalItems, `page ${pageNumber}: totalItems`).toBe(24);
                expect(p.totalPages, `page ${pageNumber}: totalPages`).toBe(3);
            }
        });

    test('API-CERT-56[defaults]: itemsPerPage and pageNumber omitted = size 10, page 1',
        meta({ id: 'API-CERT-56', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r1 (null filters, itemsPerPage, pageNumber are defaulted: 10 and 1; RequestValidatorHelper :32-42)' }),
        async ({ api }, testInfo) => {
            const m = await seedA(api, testInfo, 'API-CERT-56');
            const probe = await searchRaw(api, { filters: [seedIsolation(m)] });
            expect(probe.status, probe.text.slice(0, 200)).toBe(200);
            const body = probe.json as Json;
            expect(body.itemsPerPage).toBe(10);
            expect(body.pageNumber).toBe(1);
            expect(body.certificates).toHaveLength(10);
            expect(body.totalItems).toBe(24);
            expect(body.totalPages).toBe(3);
        });

    const BAD_PAGING: Array<{ row: string; body: Json }> = [
        { row: 'pageNumber-0', body: { pageNumber: 0, itemsPerPage: 10 } },
        { row: 'pageNumber-negative', body: { pageNumber: -1, itemsPerPage: 10 } },
        { row: 'itemsPerPage-0', body: { pageNumber: 1, itemsPerPage: 0 } },
        { row: 'itemsPerPage-negative', body: { pageNumber: 1, itemsPerPage: -1 } },
    ];
    for (const { row, body } of BAD_PAGING) {
        test(`API-CERT-56[${row}]: ${JSON.stringify(body)} is refused 400 {"message":"The request could not be processed."}`,
            meta({ id: 'API-CERT-56', prio: 'P1', issue: ISSUE, rule: 'inventory-api §1.3 row "search body: itemsPerPage 0 or pageNumber 0 or negative" (PageRequest.of IllegalArgumentException, ExceptionHandlingAdvice :155-160)' }),
            async ({ api }, testInfo) => {
                const m = await seedA(api, testInfo, 'API-CERT-56');
                const p = await searchRaw(api, { filters: [seedIsolation(m)], ...body });
                expect(p.status, p.text.slice(0, 300)).toBe(400);
                expect(expectMessageObject(p.text)).toBe('The request could not be processed.');
            });
    }

    // Pairwise combinations (all pairs of {sort, size, includeArchived, filter count} covered by these 8 rows): the concatenated pages
    // of each equal one big request with the same sort, filters and includeArchived.
    type SortVariant = 'none' | 'asc' | 'desc' | 'attribute-desc';
    const sortOf = (variant: SortVariant, m: SeedAManifest): SortSpec | undefined => {
        switch (variant) {
            case 'none':
                return undefined;
            case 'asc':
                return { fieldSource: 'property', fieldIdentifier: 'NOT_AFTER', direction: 'asc' };
            case 'desc':
                return { fieldSource: 'property', fieldIdentifier: 'NOT_AFTER', direction: 'desc' };
            case 'attribute-desc':
                return { fieldSource: 'custom', fieldIdentifier: m.attributes.num.identifier, direction: 'desc' };
        }
    };
    const PAIRWISE: Array<{ sort: SortVariant; size: 5 | 10; archived: boolean; two: boolean }> = [
        { sort: 'none', size: 5, archived: false, two: false },
        { sort: 'none', size: 10, archived: true, two: true },
        { sort: 'asc', size: 5, archived: true, two: true },
        { sort: 'asc', size: 10, archived: false, two: false },
        { sort: 'desc', size: 5, archived: false, two: true },
        { sort: 'desc', size: 10, archived: true, two: false },
        { sort: 'attribute-desc', size: 5, archived: true, two: false },
        { sort: 'attribute-desc', size: 10, archived: false, two: true },
    ];
    for (const [i, row] of PAIRWISE.entries()) {
        const name = `sort=${row.sort} size=${row.size} includeArchived=${row.archived} filters=${row.two ? 2 : 1}`;
        test(`API-CERT-56[pairwise-${i + 1}]: ${name}: the concatenated pages equal one big request`,
            meta({ id: 'API-CERT-56', prio: 'P1', issue: ISSUE, rule: 'inventory-api §2.2 r4, r21 (page 2 continues where page 1 ended), r6 (includeArchived); pairwise over {sort, size, includeArchived, filter count}' }),
            async ({ api }, testInfo) => {
                const m = await seedA(api, testInfo, 'API-CERT-56');
                const sort = sortOf(row.sort, m);
                const filters: Filter[] = row.two ? [prop('KEY_SIZE', 'EQUALS', [2048])] : [];
                // The one big request carries the same sort, filters and includeArchived as the paged ones.
                const big = await searchPage(api, { filters: [seedIsolation(m), ...filters], itemsPerPage: 100, pageNumber: 1, includeArchived: row.archived, ...(sort ? { sort } : {}) });
                const paged = await pagedSeed(api, m, sort, row.size, filters, { includeArchived: row.archived });
                expect(paged, name).toEqual(big.rows.map((x) => String(x.uuid)));
                expect(big.totalItems).toBe(row.two ? 21 : 24);
            });
    }
});
