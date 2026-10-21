/**
 * Certificate search sorting and paging over the run's own certificate seed: property and custom attribute sorts in
 * both directions with empty values last and a stable tie-break, page sizes and page numbers, the 400 of invalid paging,
 * and the default order (created descending). The order oracle is the comparator over the seed manifest (searchTables.ts).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { expectMessageObject } from '../../utils/regression/errorContract';
import { walkPages } from '../../utils/regression/inventory/listInvariants';
import { Filter, findField, propertyFilter, readCatalogue, searchPage, searchRaw, Json } from '../../utils/regression/inventory/searchApi';
import { searchSeedCertificates, certificateSeedPlan } from '../../utils/regression/inventory/seedRows';
import { CertId, SEED_A_DEFAULT_ORDER, seedIsolation, uuidsOfIds } from '../../utils/regression/inventory/seedFull';
import type { SeedAManifest } from '../../utils/regression/inventory/seedFull';
import { expectedUuidOrder, SortField } from '../../utils/regression/inventory/searchTables';
import { testMeta, tags } from '../../utils/regression/tags';
import type { GuardedApi } from '../../utils/regression/guard/types';

const ISSUE = 'ilm#428';

interface SortSpec {
    fieldSource: 'property' | 'custom';
    fieldIdentifier: string;
    direction: 'asc' | 'desc';
}

/** The seed rows in the server's order: all 24 on one page. */
async function sortedSeed(api: GuardedApi, m: SeedAManifest, sort: SortSpec | undefined, filters: Filter[] = []): Promise<{ uuids: string[]; /** in the order the server answered */ ids: CertId[]; status: number; text: string }> {
    const r = await searchSeedCertificates(api, m, filters, sort ? { sort } : {});
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

/** Is the field offered as `sortable` by the live catalogue (sort only works on sortable fields)? */
async function assertSortable(api: GuardedApi, source: 'property' | 'custom', identifier: string): Promise<void> {
    const f = findField(await readCatalogue(api), identifier, source);
    expect(f, `${identifier} is in the catalogue`).toBeTruthy();
    expect(f!.sortable, `${identifier} is sortable (core#2031 AC4)`).toBe(true);
}

test.describe('certificate search sorting and paging', { tag: tags.api }, () => {
    // ------------------------------------------------------------------ 53: property fields

    const PROPERTY_SORTS: Array<{ field: SortField; label: string }> = [
        { field: 'NOT_AFTER', label: 'Expires At' },
        { field: 'NOT_BEFORE', label: 'Valid From' },
        { field: 'GROUP_NAME', label: 'Group' },
        { field: 'OWNER', label: 'Owner' },
    ];

    for (const { field, label } of PROPERTY_SORTS) {
        for (const dir of ['asc', 'desc'] as const) {
            test(`sorting by ${label} ${dir} puts nulls last and stays stable across reads and pages`,
                testMeta({ id: 'API-CERT-53', row: `${field}.${dir}`, prio: 'P1', issue: ISSUE, rule: ['uuid tie-break; whole set ordered before paging; objects without a value last in both directions; multi-valued: min asc / max desc; core#2031, #2394; ilm#322 (Hibernate 7 null ordering)', 'the comparator order is stable across two reads and across page boundaries; Expires At / Valid From: a unique value per seed except the tie of two equal start dates; Group: smallest group name ascending, largest descending, 16 without a group last; Owner: 22 without an owner last'] }),
                async ({ api }, testInfo) => {
                    const m = await certificateSeedPlan(api, testInfo, 'API-CERT-53');
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
        { key: 'num', field: 'num', what: 'numerically' },
        { key: 'day', field: 'day', what: 'chronologically' },
        { key: 'pick', field: 'pick', what: 'by min / max value' },
    ];

    for (const { key, field, what } of ATTRIBUTE_SORTS) {
        for (const dir of ['asc', 'desc'] as const) {
            test(`sorting by the ${key} column ${what} ${dir} puts empty values last`,
                testMeta({ id: 'API-CERT-54', row: `${key}.${dir}`, prio: 'P1', issue: ISSUE, rule: ['nulls last in both directions; multi-valued: min asc / max desc; core#2033 AC1, AC3, core#2394; ilm#428', 'num sorts numerically (-5, 0, 10 … 100, 1000: a text sort would put 100 and 1000 before 20); pick sorts by the smallest value ascending and the largest descending; rows without a value last'] }),
                async ({ api }, testInfo) => {
                    const m = await certificateSeedPlan(api, testInfo, 'API-CERT-54');
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
        test(`sorting by the txt column ${dir} puts nulls last and keeps the lowercase values in order`,
            testMeta({ id: 'API-CERT-54', row: `txt.${dir}`, prio: 'P1', issue: ISSUE, rule: ['string order depends on the database collation (C vs en_US), so only the collation-independent facts are asserted (annulled < blue < green < red < red-blue)', 'the C03 value `Red` sits where the database collation puts it'] }),
            async ({ api }, testInfo) => {
                const m = await certificateSeedPlan(api, testInfo, 'API-CERT-54');
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

    test('with no sort the listing is newest first by creation, and the CA comes last',
        testMeta({ id: 'API-CERT-56', row: 'default-order', prio: 'P1', issue: ISSUE, rule: ['default order created descending, CertificateServiceImpl :614; uuid tie-break; ilm#133 AC12 (legacy shape and order)', 'order C23 … C01, then the CA C24 (uploaded first)'] }),
        async ({ api }, testInfo) => {
            const m = await certificateSeedPlan(api, testInfo, 'API-CERT-56');
            const r = await sortedSeed(api, m, undefined);
            expect(r.status, r.text.slice(0, 300)).toBe(200);
            expect(r.ids, 'default order = SEED_A_DEFAULT_ORDER').toEqual([...SEED_A_DEFAULT_ORDER]);
        });

    for (const size of [1, 10, 24, 25, 1000]) {
        test(`itemsPerPage ${size} gives ceil(24 / ${size}) pages whose union is the whole seed`,
            testMeta({ id: 'API-CERT-56', row: `size-${size}`, prio: 'P1', issue: ISSUE, rule: ['totalPages = ceil(totalItems / itemsPerPage); itemsPerPage maximum 1000 is documentation; ilm#428', 'over the 24 seeds, full pages'] }),
            async ({ api }, testInfo) => {
                const m = await certificateSeedPlan(api, testInfo, 'API-CERT-56');
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

    test('a page past the last answers 200, an empty list and the same totals',
        testMeta({ id: 'API-CERT-56', row: 'past-last', prio: 'P1', issue: ISSUE, rule: 'a page past the last answers 200 with an empty list and the real totalItems / totalPages' }),
        async ({ api }, testInfo) => {
            const m = await certificateSeedPlan(api, testInfo, 'API-CERT-56');
            for (const pageNumber of [4, 99_999_999]) {
                const p = await searchPage(api, { filters: [seedIsolation(m)], itemsPerPage: 10, pageNumber });
                expect(p.rows, `page ${pageNumber}`).toEqual([]);
                expect(p.totalItems, `page ${pageNumber}: totalItems`).toBe(24);
                expect(p.totalPages, `page ${pageNumber}: totalPages`).toBe(3);
            }
        });

    test('omitting itemsPerPage and pageNumber gives page 1 of size 10',
        testMeta({ id: 'API-CERT-56', row: 'defaults', prio: 'P1', issue: ISSUE, rule: 'null filters, itemsPerPage, pageNumber are defaulted: 10 and 1; RequestValidatorHelper :32-42' }),
        async ({ api }, testInfo) => {
            const m = await certificateSeedPlan(api, testInfo, 'API-CERT-56');
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
        test(`the paging body ${JSON.stringify(body)} is refused with 400`,
            testMeta({ id: 'API-CERT-56', row, prio: 'P1', issue: ISSUE, rule: ['search body with itemsPerPage 0 or pageNumber 0 or negative (PageRequest.of IllegalArgumentException, ExceptionHandlingAdvice :155-160)', 'the answer is {"message":"The request could not be processed."}'] }),
            async ({ api }, testInfo) => {
                const m = await certificateSeedPlan(api, testInfo, 'API-CERT-56');
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
        test(`paging with sort ${row.sort}, size ${row.size}, archived ${row.archived} and ${row.two ? 'two filters' : 'one filter'} matches one request`,
            testMeta({ id: 'API-CERT-56', row: `pairwise-${i + 1}`, prio: 'P1', issue: ISSUE, rule: ['page 2 continues where page 1 ended; includeArchived; pairwise over {sort, size, includeArchived, filter count}', 'the concatenated pages equal one big request'] }),
            async ({ api }, testInfo) => {
                const m = await certificateSeedPlan(api, testInfo, 'API-CERT-56');
                const sort = sortOf(row.sort, m);
                const filters: Filter[] = row.two ? [propertyFilter('KEY_SIZE', 'EQUALS', [2048])] : [];
                // The one big request carries the same sort, filters and includeArchived as the paged ones.
                const big = await searchPage(api, { filters: [seedIsolation(m), ...filters], itemsPerPage: 100, pageNumber: 1, includeArchived: row.archived, ...(sort ? { sort } : {}) });
                const paged = await pagedSeed(api, m, sort, row.size, filters, { includeArchived: row.archived });
                expect(paged, name).toEqual(big.rows.map((x) => String(x.uuid)));
                expect(big.totalItems).toBe(row.two ? 21 : 24);
            });
    }
});
