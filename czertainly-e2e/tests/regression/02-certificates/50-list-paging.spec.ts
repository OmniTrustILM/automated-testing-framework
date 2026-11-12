/**
 * REG-CERT-50 — Certificate list: paging (release checklist: Certificates, list). ilm#428.
 *
 * WHAT: 1. The page-size control offers exactly 10, 25, 50 and 100 and defaults to 10.
 *       2. Size 10 over the 24 own rows → three pages of 10, 10 and 4 distinct rows in the default order, with the right summary.
 *       3. Size 10 to 50 on page 3 → the page holding the first visible row (page 1) shows all 24 rows; the pager is hidden.
 *       4. Check two rows, change the page → the selection is cleared and the bulk toolbar disabled; it does not come back.
 *       5. 24 rows at size 25 → no pager, size control stays; a filter without rows → no size control, no pager, no summary;
 *          removing the badge brings them back.
 * WHY: paging must stay stable and never carry a selection across pages, or a bulk action could hit rows the operator no
 *      longer sees (fe#2193).
 * HOW: data is the run's own certificate seed (idempotent, 24 rows); the list is read, never changed. The oracle is the
 *      seed manifest and its default order (newest created first), not the page.
 */
import { expect, test } from '../../../fixtures/areas/certificateList';
import { expectedBadgeText } from '../../../utils/regression/inventory/fieldLabels';
import { PAGE_SIZES } from '../../../pages/PagerWidget';
import { CertId, SEED_A_DEFAULT_ORDER, certById } from '../../../utils/regression/inventory/seedFull';
import { visibleIds } from '../../../utils/regression/inventory/certificateListSteps';
import { CertificateListPage } from '../../../pages/CertificateListPage';
import { testMeta, tags } from '../../../utils/regression/tags';
import { LIST_SPEC_TEST_MS } from '../../../utils/regression/timeouts';

const ISSUE = 'ilm#428';

test.describe('Certificate list: paging', { tag: tags.regression }, () => {
    test.describe.configure({ timeout: LIST_SPEC_TEST_MS });

    // ------------------------------------------------------------------ REG-CERT-50

    test(
        'the page-size control offers exactly 10, 25, 50, 100 and defaults to 10',
        testMeta({
            id: 'REG-CERT-50', row: 'sizes',
            prio: 'P2',
            issue: ISSUE,
            rule: ['FE page sizes are 10, 25, 50, 100, default 10 (fe#2193: no option above 100)'],
        }),
        async ({ signedIn, listSeed }) => {
            const { manifest: m, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true });
            expect(await inventory.pager.selectedPageSize(), 'default page size').toBe(10);
            expect(await inventory.pager.pageSizeOptions()).toEqual([...PAGE_SIZES]);
        },
    );

    test(
        'size 10 over the 24 own rows gives pages of 10 / 10 / 4 with distinct rows',
        testMeta({
            id: 'REG-CERT-50', row: 'pages',
            prio: 'P2',
            issue: ISSUE,
            rule: ['totalPages = ceil(totalItems / itemsPerPage); core#2030 uuid tie-break keeps paging stable; default order: newest created first'],
        }),
        async ({ signedIn, listSeed }) => {
            const { manifest: m, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true }); // size 10
            const slices: CertId[][] = [];
            for (const [index, size] of [10, 10, 4].entries()) {
                const pageNumber = index + 1;
                await test.step(`page ${pageNumber}: ${size} rows`, async () => {
                    if (pageNumber > 1) await inventory.goToPage(pageNumber);
                    await inventory.pager.assertPager({ page: pageNumber, pages: 3 });
                    await expect.poll(async () => (await visibleIds(inventory, m)).length).toBe(size);
                    slices.push(await visibleIds(inventory, m));
                    expect(await inventory.pager.summary()).toEqual({ from: index * 10 + 1, to: index * 10 + size, total: 24 });
                });
            }
            const union = slices.flat();
            expect(new Set(union).size, 'rows are distinct across the pages').toBe(24);
            expect([...union].sort(), 'the union is the set of 24 seeds').toEqual(m.certificates.map((c) => c.id).sort());
            expect(union, 'the pages walk the default order').toEqual([...SEED_A_DEFAULT_ORDER]);
        },
    );

    test(
        'size 10 to 50 on page 3 keeps the page that holds the first visible row',
        testMeta({
            id: 'REG-CERT-50', row: '10 to 50',
            prio: 'P2',
            issue: ISSUE,
            rule: ['changing the page size keeps the page that contains the first visible row (CustomTable: ceil(first / size)); fe#2193'],
        }),
        async ({ signedIn, listSeed }) => {
            const { manifest: m, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true }); // size 10
            await inventory.goToPage(3);
            await inventory.pager.assertPager({ page: 3, pages: 3 });
            const firstVisible = (await inventory.commonNames())[0]; // row 21 of the default order
            expect(firstVisible, 'row 21 of the default order').toBe(certById(m, SEED_A_DEFAULT_ORDER[20]).commonName);

            const seen = await inventory.setPageSize(50);
            expect(seen?.body.itemsPerPage).toBe(50);
            expect(seen?.body.pageNumber, 'the page holding row 21 at size 50 is page 1').toBe(Math.ceil(21 / 50));
            expect(await inventory.pager.selectedPageSize()).toBe(50);
            const names = await inventory.commonNames();
            expect(names, 'the first visible row of page 3 is still visible').toContain(firstVisible);
            expect(names).toHaveLength(24);
            await inventory.pager.assertPagerHidden(); // one page left
            expect(await inventory.pager.summary()).toEqual({ from: 1, to: 24, total: 24 });
        },
    );

    test(
        'a page change clears the row selection',
        testMeta({
            id: 'REG-CERT-50', row: 'selection',
            prio: 'P2',
            issue: ISSUE,
            rule: ['every fetch clears the row selection, so a selection never spans pages (PagedList); the bulk toolbar is enabled only while a row is checked'],
        }),
        async ({ signedIn, listSeed }) => {
            const { manifest: m, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true });
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
        'the pager is hidden with one page and the size control at 0 rows',
        testMeta({
            id: 'REG-CERT-50', row: 'hidden controls',
            prio: 'P2',
            issue: ISSUE,
            rule: ['the size selector is hidden when totalItems is 0, the pager when there is one page (CustomTable)'],
        }),
        async ({ signedIn, listSeed }) => {
            const { manifest: m, labels } = listSeed;
            const inventory = await CertificateListPage.openSeeded(signedIn, listSeed, { isolate: true, pageSize: 25 });

            await test.step('24 rows at size 25: one page, the size control stays', async () => {
                await expect.poll(async () => (await inventory.commonNames()).length).toBe(24);
                await inventory.pager.assertPagerHidden();
                await inventory.pager.assertPageSizeControl(true);
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
                await inventory.pager.assertPageSizeControl(false);
                await inventory.pager.assertPagerHidden();
                expect(await inventory.pager.summary()).toBeNull();
            });

            await test.step('removing the badge brings the rows and the size control back', async () => {
                await inventory.filter.removeBadge(none);
                await expect.poll(async () => (await inventory.commonNames()).length).toBe(24);
                await inventory.pager.assertPageSizeControl(true);
            });
        },
    );
});
