/**
 * REG-CERT-49 — Certificate list: header sorting (release checklist: Certificates, list). ilm#428, core#2031.
 *
 * WHAT: 1. No sort chosen → the FE sends no sort, no header is sorted, and the list is created descending.
 *       2. Click Expires At → ascending, second click → descending; the sort request, the arrow, aria-sort and the row order follow.
 *       3. Click Groups → the sort moves (Expires At is no longer sorted); smallest group name first ascending, largest first
 *          descending, empty rows last.
 *       4. Click Owner → rows without an owner come last in both directions.
 *       5. A sort change on page 2 → back to page 1 with the first ten of the new ordering.
 *       6. Has private key (not sortable) → both sort menu items are disabled and a click sends nothing.
 * WHY: sorting must happen before paging and treat empty values the same in both directions; a sort the catalogue does not
 *      allow must stay inert. A red test means the list order or the paging contract changed.
 * HOW: data is the run's own certificate seed (idempotent, 24 rows, 2 with an owner); the list is read, never changed. The
 *      oracle is the order computed from the seed manifest, not from the page.
 */
import { expect, test } from '../../../fixtures/areas/certificateList';
import { NOT_SORTABLE_REASON } from '../../../pages/ColumnHeaderMenuWidget';
import { findField } from '../../../utils/regression/inventory/searchApi';
import { SEED_A_DEFAULT_ORDER } from '../../../utils/regression/inventory/seedFull';
import { expectedOrderGroups } from '../../../utils/regression/inventory/searchTables';
import { visibleIds, expectListOrder, COLUMN } from '../../../utils/regression/inventory/certificateListSteps';
import { sortOf } from '../../../utils/regression/inventory/oracles/sortOracles';
import { CertificateListPage } from '../../../pages/CertificateListPage';
import { testMeta, tags } from '../../../utils/regression/tags';
import { LIST_SPEC_TEST_MS } from '../../../utils/regression/timeouts';

const ISSUE = 'ilm#428';

test.describe('Certificate list: sorting', { tag: tags.regression }, () => {
    test.describe.configure({ timeout: LIST_SPEC_TEST_MS });

    // ------------------------------------------------------------------ REG-CERT-49

    test(
        'with no sort the list is created descending and no header is sorted',
        testMeta({
            id: 'REG-CERT-49', row: 'default',
            prio: 'P2',
            issue: ISSUE,
            rule: ['the FE sends no `sort` for the certificate list, so Core\'s default order (created descending) applies (the list page); upload order: the last-created certificate first, then the earlier ones in reverse'],
        }),
        async ({ signedIn, listSeed }) => {
            const { manifest: m, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed);
            const seen = await inventory.filterByCommonNamePrefix(m.prefix, labels);
            await inventory.setPageSize(25);
            expect(seen.body.sort, 'the FE sends no sort by default').toBeUndefined();
            await inventory.assertNotSorted();
            await expect.poll(() => visibleIds(inventory, m), { message: 'created descending' }).toEqual([...SEED_A_DEFAULT_ORDER]);
        },
    );

    test(
        'a click sorts ascending, a second descending, and the arrow and aria-sort follow',
        testMeta({
            id: 'REG-CERT-49', row: 'Expires At',
            prio: 'P2',
            issue: ISSUE,
            rule: ['header click toggles asc then desc, one sort at a time (CustomTable); aria-sort on the sorted header only; sort before paging'],
        }),
        async ({ signedIn, listSeed }) => {
            const { manifest: m, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true, pageSize: 25 });
            await inventory.assertNotSorted(); // an unsorted header carries no aria-sort: asserted before AND after the click

            for (const direction of ['asc', 'desc'] as const) {
                await test.step(`click on Expires At -> ${direction}`, async () => {
                    const seen = await inventory.sortBy(COLUMN.notAfter);
                    expect(seen.body.sort).toEqual(sortOf('NOT_AFTER', 'property', direction));
                    expect(seen.body.pageNumber).toBe(1);
                    await inventory.assertSortedBy(COLUMN.notAfter, direction);
                    await expectListOrder(inventory, m, 'NOT_AFTER', direction);
                });
            }
        },
    );

    test(
        'the Groups column sorts by smallest name ascending, largest descending, empty rows last',
        testMeta({
            id: 'REG-CERT-49', row: 'Groups',
            prio: 'P2',
            issue: ISSUE,
            rule: [
                'a click on another column moves the sort (one sort field only, CustomTable)',
                'a multi-valued field sorts by its smallest value ascending and its largest descending; objects without a value come last in both directions',
            ],
        }),
        async ({ signedIn, listSeed }) => {
            const { manifest: m, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true, pageSize: 25 });

            await test.step('Expires At first (ascending)', async () => {
                await inventory.sortBy(COLUMN.notAfter);
                await inventory.assertSortedBy(COLUMN.notAfter, 'asc');
            });
            for (const direction of ['asc', 'desc'] as const) {
                await test.step(`click on Groups -> ${direction}: the sort moved, Expires At is no longer sorted`, async () => {
                    const seen = await inventory.sortBy(COLUMN.groups);
                    expect(seen.body.sort).toEqual(sortOf('GROUP_NAME', 'property', direction));
                    await inventory.assertSortedBy(COLUMN.groups, direction); // aria-sort on this header only
                    await expectListOrder(inventory, m, 'GROUP_NAME', direction);
                });
            }
        },
    );

    test(
        'sorting by Owner keeps rows without an owner last in both directions',
        testMeta({
            id: 'REG-CERT-49', row: 'Owner',
            prio: 'P2',
            issue: ISSUE,
            rule: ['objects without a value sort last in both directions (SortOrderBuilder nullPrecedence LAST; ilm#322, the Hibernate 7 risk of where sorting puts empty values); sorted by OWNER, 22 rows without a value'],
        }),
        async ({ signedIn, listSeed }) => {
            const { manifest: m, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true, pageSize: 25 });
            const withOwner = m.certificates.filter((c) => c.owner).length;
            expect(withOwner, 'the own seed gives the owner to 2 certificates').toBe(2);

            for (const direction of ['asc', 'desc'] as const) {
                await test.step(`click on Owner -> ${direction}`, async () => {
                    const seen = await inventory.sortBy(COLUMN.owner);
                    expect(seen.body.sort).toEqual(sortOf('OWNER', 'property', direction));
                    await inventory.assertSortedBy(COLUMN.owner, direction);
                    await expectListOrder(inventory, m, 'OWNER', direction);
                    // The null block is the tail both ways: the last 22 rows have no owner, the first 2 have one.
                    const owners = await inventory.cellTexts(COLUMN.owner);
                    expect(owners.slice(0, withOwner).every((t) => t !== '' && !t.includes('No value')), 'owned rows first').toBe(true);
                    expect(owners.slice(withOwner).every((t) => t.includes('No value')), 'rows without an owner last').toBe(true);
                });
            }
        },
    );

    test(
        'a sort change returns to page 1',
        testMeta({
            id: 'REG-CERT-49', row: 'page 1',
            prio: 'P2',
            issue: ISSUE,
            rule: ['a sort change goes back to page 1 ("page 2 of one ordering is not page 2 of another", PagedList); core#2031 AC2 sort before paging'],
        }),
        async ({ signedIn, listSeed }) => {
            const { manifest: m, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true }); // size 10: 24 rows = 3 pages
            await inventory.goToPage(2);
            await inventory.pager.assertPager({ page: 2, pages: 3 });
            const seen = await inventory.sortBy(COLUMN.notAfter);
            expect(seen.body.pageNumber, 'the sort request asks for page 1').toBe(1);
            expect(seen.body.sort).toEqual(sortOf('NOT_AFTER', 'property', 'asc'));
            await inventory.pager.assertPager({ page: 1, pages: 3 });
            await inventory.assertSortedBy(COLUMN.notAfter, 'asc');
            // The first page of the new ordering: the first ten of the comparator (no tie among them).
            const groups = expectedOrderGroups(m, 'NOT_AFTER', 'asc').slice(0, 10);
            expect(groups.every((g) => g.length === 1), 'the first ten expiries are distinct').toBe(true);
            await expect.poll(() => visibleIds(inventory, m)).toEqual(groups.map((g) => g[0]));
        },
    );

    test(
        'the Has private key sort items are disabled and a click does nothing',
        testMeta({
            id: 'REG-CERT-49', row: 'PRIVATE_KEY',
            prio: 'P2',
            issue: ISSUE,
            rule: ['a non-sortable column (PRIVATE_KEY is derived) shows both sort items disabled with "This field cannot be used for ordering." (ColumnHeaderMenu); sortability comes only from the catalogue `sortable` flag'],
        }),
        async ({ signedIn, listSeed }) => {
            const { manifest: m, catalogue, labels } = listSeed;
            expect(findField(catalogue, 'PRIVATE_KEY', 'property')?.sortable, 'the catalogue marks PRIVATE_KEY as not sortable').toBe(false);

            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true, pageSize: 25 });
            await inventory.assertNoSortButton(COLUMN.privateKey);
            await inventory.columnMenu(COLUMN.privateKey).open();
            await inventory.columnMenu(COLUMN.privateKey).assertSortItemsDisabled(NOT_SORTABLE_REASON);
            // Selecting a disabled item is inert: no request, no sort, the menu stays open.
            const mark = inventory.traffic.start().mark();
            await inventory.columnMenu(COLUMN.privateKey).clickSortMenuItem('asc');
            await inventory.columnMenu(COLUMN.privateKey).assertOpen();
            expect(inventory.traffic.nonReadsSince(mark), 'a disabled sort item sends nothing').toEqual([]);
            await inventory.columnMenu(COLUMN.privateKey).close();
            await inventory.assertNotSorted();
        },
    );
});
