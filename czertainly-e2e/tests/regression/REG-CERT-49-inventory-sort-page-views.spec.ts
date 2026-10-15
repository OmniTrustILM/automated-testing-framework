/**
 * REG-CERT-49 … 51 — the certificate inventory list: header sorting, paging and the value rendering of the Standard view
 * (ilm#428 steps 2, 9-11; inventory-api rules §2.2 r21-r24, §4.2 r1-r6, §4.3).
 *
 *   REG-CERT-49  header sorting: click toggles asc -> desc, a second column takes over, the arrow / aria-sort only on the sorted
 *                column, the page returns to 1; order by Expires At, Groups (smallest name ascending, largest descending) and Owner
 *                (rows without a value last in BOTH directions); the PRIVATE_KEY header menu: both items disabled with the reason;
 *                no sort = created descending (C23 ... C01, C24)
 *   REG-CERT-50  paging: the size control offers exactly 10 / 25 / 50 / 100; size 10 over the 24 own rows gives pages of 10 / 10 / 4;
 *                10 -> 50 from page 3 keeps the page holding the first visible row; a page change clears the selection; the pager is
 *                hidden with one page and the size control at 0 rows
 *   REG-CERT-51  columns and value rendering on the Standard view: the 16 columns in order; every cell equals the API value formatted
 *                for display (expired C07, not-yet-valid C20, grouped C03, ownerless C08 and every other own seed); empty values show the
 *                shared placeholder; none of null / undefined / NaN / Invalid Date anywhere in the table body
 *
 * Oracles: the visible order is the comparator over the SEED-A manifest (`expectedOrderGroups`: non-null keys in the requested
 * direction, then every row without a value as the last block in both directions; ties compared as a set because the engine's
 * tie-break is the uuid); the default order is `SEED_A_DEFAULT_ORDER`; the display rules are written down in
 * `formatForDisplay` (pages/InventoryPage.ts) from the FE's cell registry. Every list carries the isolation filter, added through the
 * widget first. The data are the run's own SEED-A certificates, groups and owner (S-own: the group / owner PATCHes); nothing is changed here.
 *
 * Plan deviation (REG-CERT-51): the "Private key" cell of a certificate without a private key is the shared EMPTY placeholder, not a
 * "No" badge: `certificateTableHelpers.tsx:202-210` renders the key icon or nothing (the Archived column is the Yes / No badge).
 */
import type { Page } from '@playwright/test';
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import type { TestEnv } from '../../utils/env';
import { PlatformLabels, expectedBadgeText } from '../../pages/FilterWidget';
import { InventoryPage, NOT_SORTABLE_REASON, PAGE_SIZES, STANDARD_COLUMNS, formatForDisplay } from '../../pages/InventoryPage';
import { findField, isolation, readCatalogue, searchAllRows, uuidSet } from '../../utils/regression/inventoryApi';
import { CertId, SEED_A_DEFAULT_ORDER, SeedAManifest, certById, ensureSeedA, uuidsOfIds } from '../../utils/regression/inventorySeedFull';
import { SortField, expectedOrderGroups, orderProblem } from '../../utils/regression/inventoryTables';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-CERT-49';
const ISSUE = 'ilm#428';

const COLUMN = {
    notAfter: 'property:NOT_AFTER',
    groups: 'property:GROUP_NAME',
    owner: 'property:OWNER',
    privateKey: 'property:PRIVATE_KEY',
} as const;

/** The list opened, the isolation filter added through the widget (and kept), optionally a page size. */
async function openInventory(page: Page, env: TestEnv, m: SeedAManifest, labels: PlatformLabels, opts: { pageSize?: 10 | 25 | 50 | 100 } = {}): Promise<InventoryPage> {
    const inventory = new InventoryPage(page);
    await loginAsSmokeUser(page, env);
    await inventory.goToList();
    await inventory.isolate(m.prefix, labels);
    if (opts.pageSize) await inventory.setPageSize(opts.pageSize);
    return inventory;
}

/** The seed ids of the rows shown, in display order (`?<name>` for a row that is not a seed). */
async function visibleIds(inventory: InventoryPage, m: SeedAManifest): Promise<CertId[]> {
    const byName = new Map(m.certificates.map((c) => [c.commonName, c.id]));
    return (await inventory.commonNames()).map((name) => byName.get(name) ?? (`?${name}` as CertId));
}

/** Settled rows (`expect.poll`, so a refetch in flight cannot be read half way) follow the comparator of a field and direction. */
async function assertOrder(inventory: InventoryPage, m: SeedAManifest, field: SortField, direction: 'asc' | 'desc'): Promise<void> {
    const groups = expectedOrderGroups(m, field, direction);
    await expect
        .poll(async () => orderProblem(await visibleIds(inventory, m), groups), { message: `rows ordered by ${field} ${direction} (comparator over the manifest, ties as a set)` })
        .toBeUndefined();
}

const sortOf = (field: string, direction: 'asc' | 'desc') => ({ fieldSource: 'property', fieldIdentifier: field, direction });

test.describe('REG-CERT-49…51 inventory list: sort, paging, columns', { tag: tags.regression }, () => {
    test.describe.configure({ timeout: 240_000 });

    // ------------------------------------------------------------------ REG-CERT-49

    test(
        'REG-CERT-49[default]: with no sort the list is created descending (C23 … C01, C24) and no header is sorted',
        meta({
            id: 'REG-CERT-49',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §4.2 r1: the FE sends no `sort` for the certificate list, so Core\'s default order (created descending) applies (list/index.tsx:244-257); §2.2 r4; plan §2.1 upload order C24 first, then C01…C23'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const labels = await PlatformLabels.read(api);
            const inventory = new InventoryPage(page);
            await loginAsSmokeUser(page, env);
            await inventory.goToList();
            const seen = await inventory.isolate(m.prefix, labels);
            await inventory.setPageSize(25);
            expect(seen.body.sort, 'the FE sends no sort by default').toBeUndefined();
            await inventory.assertNotSorted();
            await expect.poll(() => visibleIds(inventory, m), { message: 'created descending' }).toEqual([...SEED_A_DEFAULT_ORDER]);
        },
    );

    test(
        'REG-CERT-49[Expires At]: a header click sorts ascending, a second click descending; the arrow and aria-sort sit on that column only',
        meta({
            id: 'REG-CERT-49',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §4.2 r2: header click toggles asc then desc, one sort at a time (CustomTable/index.tsx:573-592); aria-sort on the sorted header only (:101-107); §2.2 r21 sort before paging; plan §2.2 sort oracles (Cmp)'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, m, labels, { pageSize: 25 });
            await inventory.assertNotSorted(); // an unsorted header carries no aria-sort: asserted before AND after the click

            for (const direction of ['asc', 'desc'] as const) {
                await test.step(`click on Expires At -> ${direction}`, async () => {
                    const seen = await inventory.sortBy(COLUMN.notAfter);
                    expect(seen.body.sort).toEqual(sortOf('NOT_AFTER', direction));
                    expect(seen.body.pageNumber).toBe(1);
                    await inventory.assertSortedBy(COLUMN.notAfter, direction);
                    await assertOrder(inventory, m, 'NOT_AFTER', direction);
                });
            }
        },
    );

    test(
        'REG-CERT-49[Groups]: a click on a second column takes the sort over; groups sort by the smallest name ascending and the largest descending, members-less rows last',
        meta({
            id: 'REG-CERT-49',
            prio: 'P1',
            issue: ISSUE,
            rule: [
                'inventory-api rules §4.2 r2: a click on another column moves the sort (one sort field only, CustomTable/index.tsx:580-582)',
                'inventory-api rules §2.2 r22-r23: a multi-valued field sorts by its smallest value ascending and its largest descending; objects without a value come last in both directions',
            ],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, m, labels, { pageSize: 25 });

            await test.step('Expires At first (ascending)', async () => {
                await inventory.sortBy(COLUMN.notAfter);
                await inventory.assertSortedBy(COLUMN.notAfter, 'asc');
            });
            for (const direction of ['asc', 'desc'] as const) {
                await test.step(`click on Groups -> ${direction}: the sort moved, Expires At is no longer sorted`, async () => {
                    const seen = await inventory.sortBy(COLUMN.groups);
                    expect(seen.body.sort).toEqual(sortOf('GROUP_NAME', direction));
                    await inventory.assertSortedBy(COLUMN.groups, direction); // aria-sort on this header only
                    await assertOrder(inventory, m, 'GROUP_NAME', direction);
                });
            }
        },
    );

    test(
        'REG-CERT-49[Owner]: sorting by Owner keeps the rows without an owner as the last block in both directions',
        meta({
            id: 'REG-CERT-49',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §2.2 r22: objects without a value sort last in both directions (SortOrderBuilder nullPrecedence LAST; ilm#322 Hibernate 7 risk "where sorting puts empty values"); plan §2.2 sort oracles: OWNER, 22 rows without a value'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, m, labels, { pageSize: 25 });
            const withOwner = m.certificates.filter((c) => c.owner).length;
            expect(withOwner, 'SEED-A gives the owner to 2 certificates').toBe(2);

            for (const direction of ['asc', 'desc'] as const) {
                await test.step(`click on Owner -> ${direction}`, async () => {
                    const seen = await inventory.sortBy(COLUMN.owner);
                    expect(seen.body.sort).toEqual(sortOf('OWNER', direction));
                    await inventory.assertSortedBy(COLUMN.owner, direction);
                    await assertOrder(inventory, m, 'OWNER', direction);
                    // The null block is the tail both ways: the last 22 rows have no owner, the first 2 have one.
                    const owners = await inventory.cellTexts(COLUMN.owner);
                    expect(owners.slice(0, withOwner).every((t) => t !== '' && !t.includes('No value')), 'owned rows first').toBe(true);
                    expect(owners.slice(withOwner).every((t) => t.includes('No value')), 'rows without an owner last').toBe(true);
                });
            }
        },
    );

    test(
        'REG-CERT-49[page 1]: a sort change returns to page 1',
        meta({
            id: 'REG-CERT-49',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §4.2 r3: a sort change goes back to page 1 ("Page 2 of one ordering is not page 2 of another", PagedList.tsx:270-283); core#2031 AC2 sort before paging'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, m, labels); // size 10: 24 rows = 3 pages
            await inventory.goToPage(2);
            await inventory.assertPager({ page: 2, pages: 3 });
            const seen = await inventory.sortBy(COLUMN.notAfter);
            expect(seen.body.pageNumber, 'the sort request asks for page 1').toBe(1);
            expect(seen.body.sort).toEqual(sortOf('NOT_AFTER', 'asc'));
            await inventory.assertPager({ page: 1, pages: 3 });
            await inventory.assertSortedBy(COLUMN.notAfter, 'asc');
            // The first page of the new ordering: the first ten of the comparator (no tie among them: C07, C01 … C10).
            const groups = expectedOrderGroups(m, 'NOT_AFTER', 'asc').slice(0, 10);
            expect(groups.every((g) => g.length === 1), 'the first ten expiries are distinct').toBe(true);
            await expect.poll(() => visibleIds(inventory, m)).toEqual(groups.map((g) => g[0]));
        },
    );

    test(
        'REG-CERT-49[PRIVATE_KEY]: the Has private key header menu offers both sort items disabled with the reason; a header click does nothing',
        meta({
            id: 'REG-CERT-49',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §4.2 r2 and §2.2 r24: a non-sortable column (PRIVATE_KEY is derived) shows both sort items disabled with "This field cannot be used for ordering." (ColumnHeaderMenu/index.tsx:21,192-216); sortability comes only from the catalogue `sortable` flag'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const labels = await PlatformLabels.read(api);
            const catalogue = await readCatalogue(api);
            expect(findField(catalogue, 'PRIVATE_KEY', 'property')?.sortable, 'the catalogue marks PRIVATE_KEY as not sortable').toBe(false);

            const inventory = await openInventory(page, env, m, labels, { pageSize: 25 });
            await inventory.assertNoSortButton(COLUMN.privateKey);
            await inventory.openColumnMenu(COLUMN.privateKey);
            await inventory.assertSortItemsDisabled(COLUMN.privateKey, NOT_SORTABLE_REASON);
            // Selecting a disabled item is inert: no request, no sort, the menu stays open.
            const mark = inventory.traffic.mark();
            await inventory.pressSortItem(COLUMN.privateKey, 'asc');
            await inventory.assertColumnMenuOpen(COLUMN.privateKey);
            expect(inventory.traffic.nonReadsSince(mark), 'a disabled sort item sends nothing').toEqual([]);
            await inventory.closeColumnMenu(COLUMN.privateKey);
            await inventory.assertNotSorted();
        },
    );

    // ------------------------------------------------------------------ REG-CERT-50

    test(
        'REG-CERT-50[sizes]: the page-size control offers exactly 10, 25, 50, 100; the default is 10',
        meta({
            id: 'REG-CERT-50',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §4.2 r5: FE page sizes are 10, 25, 50, 100, default 10 (utils/pagination.ts:1; fe#2193 AC: no option above 100)'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, m, labels);
            expect(await inventory.selectedPageSize(), 'default page size').toBe(10);
            expect(await inventory.pageSizeOptions()).toEqual([...PAGE_SIZES]);
        },
    );

    test(
        'REG-CERT-50[pages]: size 10 over the 24 own rows gives pages of 10 / 10 / 4, rows distinct, the union is the whole set',
        meta({
            id: 'REG-CERT-50',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §4.2 r5 and §2.2 r2 (totalPages = ceil(totalItems / itemsPerPage)); core#2030 uuid tie-break keeps paging stable; plan §2.1 default order C23 … C01, C24'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, m, labels); // size 10
            const slices: CertId[][] = [];
            for (const [index, size] of [10, 10, 4].entries()) {
                const pageNumber = index + 1;
                await test.step(`page ${pageNumber}: ${size} rows`, async () => {
                    if (pageNumber > 1) await inventory.goToPage(pageNumber);
                    await inventory.assertPager({ page: pageNumber, pages: 3 });
                    await expect.poll(async () => (await visibleIds(inventory, m)).length).toBe(size);
                    slices.push(await visibleIds(inventory, m));
                    expect(await inventory.summary()).toEqual({ from: index * 10 + 1, to: index * 10 + size, total: 24 });
                });
            }
            const union = slices.flat();
            expect(new Set(union).size, 'rows are distinct across the pages').toBe(24);
            expect([...union].sort(), 'the union is the set of 24 seeds').toEqual(m.certificates.map((c) => c.id).sort());
            expect(union, 'the pages walk the default order').toEqual([...SEED_A_DEFAULT_ORDER]);
        },
    );

    test(
        'REG-CERT-50[10 to 50]: switching the size from 10 to 50 on page 3 keeps the page that holds the first visible row',
        meta({
            id: 'REG-CERT-50',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §4.2 r6: changing the page size keeps the page that contains the first visible row (CustomTable/index.tsx:596-608: ceil(first / size)); fe#2193'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, m, labels); // size 10
            await inventory.goToPage(3);
            await inventory.assertPager({ page: 3, pages: 3 });
            const firstVisible = (await inventory.commonNames())[0]; // row 21 of the default order
            expect(firstVisible, 'row 21 of the default order').toBe(certById(m, SEED_A_DEFAULT_ORDER[20]).commonName);

            const seen = await inventory.setPageSize(50);
            expect(seen?.body.itemsPerPage).toBe(50);
            expect(seen?.body.pageNumber, 'the page holding row 21 at size 50 is page 1').toBe(Math.ceil(21 / 50));
            expect(await inventory.selectedPageSize()).toBe(50);
            const names = await inventory.commonNames();
            expect(names, 'the first visible row of page 3 is still visible').toContain(firstVisible);
            expect(names).toHaveLength(24);
            await inventory.assertPagerHidden(); // one page left
            expect(await inventory.summary()).toEqual({ from: 1, to: 24, total: 24 });
        },
    );

    test(
        'REG-CERT-50[selection]: a page change clears the row selection',
        meta({
            id: 'REG-CERT-50',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §4.2 r6: every fetch clears the row selection, so a selection never spans pages (PagedList.tsx:414-417); the bulk toolbar is enabled only while a row is checked (list/index.tsx:167-210)'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, m, labels);
            await inventory.assertBulkToolbar(false);
            const [first, second] = (await inventory.commonNames()).slice(0, 2);
            await inventory.checkRows([first, second]);
            expect(await inventory.checkedCommonNames()).toEqual([first, second]);
            await inventory.assertBulkToolbar(true);

            await inventory.goToPage(2);
            await inventory.assertBulkToolbar(false);
            expect(await inventory.checkedCommonNames(), 'nothing is checked on page 2').toEqual([]);

            await inventory.goToPage(1);
            expect(await inventory.checkedCommonNames(), 'the selection did not come back with page 1').toEqual([]);
            await inventory.assertBulkToolbar(false);
        },
    );

    test(
        'REG-CERT-50[hidden controls]: the pager is hidden with one page and the size control at 0 rows',
        meta({
            id: 'REG-CERT-50',
            prio: 'P1',
            issue: ISSUE,
            rule: ['inventory-api rules §4.2 r5: the size selector is hidden when totalItems is 0, the pager when there is one page (CustomTable/index.tsx:965-992)'],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, m, labels, { pageSize: 25 });

            await test.step('24 rows at size 25: one page, the size control stays', async () => {
                await expect.poll(async () => (await inventory.commonNames()).length).toBe(24);
                await inventory.assertPagerHidden();
                await inventory.assertPageSizeControl(true);
            });

            const none = expectedBadgeText({ source: labels.source('property'), field: 'Common Name', condition: labels.condition('EQUALS'), value: `${m.prefix}no-such-row` });
            await test.step('a filter without rows: no size control, no pager, no summary', async () => {
                const seen = await inventory.filter.addFilter({
                    source: labels.source('property'),
                    field: 'Common Name',
                    condition: labels.condition('EQUALS'),
                    value: `${m.prefix}no-such-row`,
                });
                expect(seen.json?.totalItems).toBe(0);
                await expect.poll(async () => (await inventory.commonNames()).length).toBe(0);
                await inventory.assertPageSizeControl(false);
                await inventory.assertPagerHidden();
                expect(await inventory.summary()).toBeNull();
            });

            await test.step('removing the badge brings the rows and the size control back', async () => {
                await inventory.filter.removeBadge(none);
                await expect.poll(async () => (await inventory.commonNames()).length).toBe(24);
                await inventory.assertPageSizeControl(true);
            });
        },
    );

    // ------------------------------------------------------------------ REG-CERT-51

    test(
        'REG-CERT-51: the Standard view shows the 16 columns in order and every cell equals the API value formatted for display',
        meta({
            id: 'REG-CERT-51',
            prio: 'P1',
            issue: ISSUE,
            rule: [
                'inventory-api rules §4.3: the FE Standard set is 16 columns (certificateTableHelpers.tsx:99-180); ilm#428 step 2 (absolute variant: no pixel differential)',
                'display rules: dates `yyyy-MM-dd HH:mm:ss` in the browser zone (utils/dateUtil.ts:41-57), state / validation labels from the platform enums (utils/certificate.tsx:207-243), a blank value is the shared empty state (CustomTable/columns/buildTableRows.tsx:11-26, EmptyCell.tsx)',
            ],
        }),
        async ({ page, api, env }) => {
            const m = await ensureSeedA(api, SPEC);
            const labels = await PlatformLabels.read(api);
            const inventory = await openInventory(page, env, m, labels, { pageSize: 25 });
            await expect.poll(async () => (await inventory.commonNames()).length, { message: 'the 24 own rows are shown' }).toBe(24);

            await test.step('The 16 columns, in order, with the shipped headings', async () => {
                await inventory.assertColumns(STANDARD_COLUMNS.map((c) => c.id));
                expect(await inventory.columnHeadings()).toEqual(STANDARD_COLUMNS.map((c) => c.heading));
            });

            const apiRows = await searchAllRows(api, { filters: [isolation(m.prefix)], includeArchived: false });
            expect(uuidSet(apiRows), 'the API holds the same 24 rows').toEqual(uuidsOfIds(m, m.certificates.map((c) => c.id)));
            const zone = await inventory.browserTimeZone();
            const ctx = { timeZone: zone, labels };

            // The four named seeds first (clearer failures), then every other own row: the rule is the same for all.
            const named: CertId[] = ['C07', 'C20', 'C03', 'C08'];
            const order = [...named, ...m.certificates.map((c) => c.id).filter((id) => !named.includes(id))];
            for (const id of order) {
                const cert = certById(m, id);
                const apiRow = apiRows.find((r) => r.uuid === cert.uuid);
                expect(apiRow, `${id} is in the API list`).toBeDefined();
                const expected = Object.fromEntries(STANDARD_COLUMNS.map((c) => [c.id, formatForDisplay(c.id, apiRow!, ctx)]));
                await test.step(`${id}${named.includes(id) ? ' (named seed)' : ''}: every cell equals the formatted API value`, async () => {
                    await inventory.assertCellValues(cert.commonName, expected);
                });
            }

            await test.step('Seeds the plan names: state label, Archived badge, owner and group cells', async () => {
                const state = labels.display('CertificateState', 'issued');
                expect(await inventory.cellTexts('property:CERTIFICATE_STATE'), 'state label of every uploaded certificate').toEqual(Array(24).fill(state));
                expect(await inventory.cellTexts('property:ARCHIVED'), 'Archived badge').toEqual(Array(24).fill('No'));
                const c08 = await inventory.readRow(certById(m, 'C08').commonName);
                expect(c08[COLUMN.owner].empty, 'the ownerless certificate shows the placeholder, not a word').toBe(true);
                const c01 = await inventory.readRow(certById(m, 'C01').commonName);
                expect(c01[COLUMN.owner].text, 'the owner shows the owner\'s name').toBe(m.owner.username);
                const c03 = await inventory.readRow(certById(m, 'C03').commonName);
                expect(c03[COLUMN.groups].text, 'two groups: the first name and +1').toContain('+1');
            });

            await test.step('null, undefined, NaN, Invalid Date appear nowhere in the table body', async () => {
                await inventory.assertNoForbiddenWords();
            });
        },
    );
});
