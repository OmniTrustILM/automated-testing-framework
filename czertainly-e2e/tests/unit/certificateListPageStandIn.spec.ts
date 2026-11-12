/**
 * Offline checks of pages/FilterWidget.ts, pages/CertificateListPage.ts and the shared steps of the text and list
 * filter rows against a stand-in of the admin UI (tests/unit/helpers/fakeCertificateListApp.ts). Each assertion meant
 * to catch a wrong page is shown failing on one.
 */
import { Browser, expect, test } from '@playwright/test';
import { FilterWidget, isCertificateListRequest, observeListRequest } from '../../pages/FilterWidget';
import { PlatformLabels, badgeOfFilter, expectedBadgeText, expectedFieldLabels, widgetSpecOf } from '../../utils/regression/inventory/fieldLabels';
import { filtersDifference } from '../../utils/regression/inventory/certificateListOracle';
import { CertificateListPage } from '../../pages/CertificateListPage';
import { openCertificateList } from '../../utils/regression/inventory/certificateListSteps';
import type { TestEnv } from '../../utils/env';
import { NOT_SORTABLE_REASON } from '../../pages/ColumnHeaderMenuWidget';
import { STANDARD_COLUMNS, formatDateTime, expectedCell } from '../../utils/regression/inventory/certificateListOracle';
import { CertId, SEED_A_DEFAULT_ORDER, SeedAManifest } from '../../utils/regression/inventory/seedFull';
import { isolation } from '../../utils/regression/inventory/searchApi';
import { COLLECTION_ROWS, LIST_ROWS, TEXT_ROWS, expectedOrderGroups, orderProblem } from '../../utils/regression/inventory/searchTables';
import { FAKE_ENUMS, FakeRow, Served, fakeCatalogue, fakeData, serveInventory } from './helpers/fakeCertificateListApp';

const labels = new PlatformLabels(FAKE_ENUMS as never);
const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

async function open(browser: Browser, opts: Parameters<typeof serveInventory>[1] = {}): Promise<{ app: Served; inventory: CertificateListPage; filter: FilterWidget }> {
    const app = await serveInventory(browser, opts);
    const inventory = new CertificateListPage(app.page);
    await inventory.goToList();
    return { app, inventory, filter: inventory.filter };
}

const idsShown = async (inventory: CertificateListPage, app: Served): Promise<CertId[]> => {
    const byName = new Map(app.data.plan.certificates.map((c) => [c.commonName, c.id]));
    return (await inventory.commonNames()).map((n) => byName.get(n) ?? (`?${n}` as CertId));
};

test.describe('FilterWidget', () => {
    test.describe.configure({ timeout: 90_000 });

    test('choose / offered lists / assertConditionsOffered: Source, Field and Condition options are read from the open popovers', async ({ browser }) => {
        const { app, filter } = await open(browser);
        try {
            const catalogue = fakeCatalogue(app.data);
            expect(await filter.offeredSources()).toEqual(['Property', 'Custom attribute']);
            await filter.choose({ source: 'Property' });
            // a field that publishes no condition is not offered (FilterWidget/index.tsx:454-462)
            const typeLabel = (c: string): string => labels.display('AttributeContentType', c);
            expect(await filter.offeredFields()).toEqual(expectedFieldLabels(catalogue[0].searchFieldData, typeLabel));
            expect(await filter.offeredFields()).not.toContain('Ordering only');
            await filter.choose({ field: 'Common Name' });
            await filter.assertConditionsOffered(catalogue[0].searchFieldData[0].conditions.map((c: string) => labels.condition(c)), { ordered: true });
            await filter.assertConditionsOffered(['contains', 'not contains', 'equals', 'not equals', 'empty', 'not empty', 'starts with', 'ends with', 'matches regex', 'not matches regex']);
            expect(await failsFast(filter.assertConditionsOffered(['contains', 'equals']))).toBe(true);
            expect(await failsFast(filter.assertConditionsOffered(['equals', 'contains'].concat(catalogue[0].searchFieldData[0].conditions.slice(2).map((c: string) => labels.condition(c))), { ordered: true }))).toBe(true);
            // the custom group: the field list holds the seed attributes
            await filter.choose({ source: 'Custom attribute' });
            expect((await filter.offeredFields()).length).toBe(2);
            // nothing was sent while choosing
            expect(app.listRequests).toHaveLength(1); // only the page's own first load
        } finally {
            await app.close();
        }
    });

    test('addFilter: text value, the request observed (registered before the click), badge text, rows; removeBadge sends the list request without the filter', async ({ browser }) => {
        const { app, inventory, filter } = await open(browser);
        try {
            const first = await filter.addFilter({ source: 'Property', field: 'Common Name', condition: 'starts with', value: app.data.plan.prefix });
            expect(first.status).toBe(200);
            expect(first.body.filters).toEqual([{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: app.data.plan.prefix }]);
            expect(first.body.pageNumber).toBe(1);
            expect(first.body.includeArchived).toBe(false);
            expect(first.json?.totalItems).toBe(24);
            await filter.assertBadges([expectedBadgeText({ source: 'Property', field: 'Common Name', condition: 'starts with', value: app.data.plan.prefix })]);

            const second = await filter.addFilter({ source: 'Property', field: 'Common Name', condition: 'contains', value: 'web' });
            expect(filtersDifference(second.body.filters, [
                { fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: app.data.plan.prefix },
                { fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'CONTAINS', value: 'web' },
            ])).toBeUndefined();
            expect(second.json?.totalItems).toBe(4); // C01, C03, C06, C07
            expect((await inventory.commonNames()).sort()).toEqual(['alpha-web', 'beta-web', 'gamma-web', 'Delta-web'].map((t) => `${app.data.plan.prefix}${t}`).sort());

            const removed = await filter.removeBadge(`Property 'Common Name' contains 'web'`);
            expect(removed.body.filters).toHaveLength(1);
            await filter.assertBadges([`Property 'Common Name' starts with '${app.data.plan.prefix}'`]);
            expect(await failsFast(filter.assertBadges(['nothing']))).toBe(true);
        } finally {
            await app.close();
        }
    });

    test('a duplicate source + field + condition sends no request and shows the alert; EMPTY disables the value control and sends no value key', async ({ browser }) => {
        const { app, inventory, filter } = await open(browser);
        try {
            await filter.addFilter({ source: 'Property', field: 'Common Name', condition: 'starts with', value: app.data.plan.prefix });
            const before = app.listRequests.length;
            await filter.choose({ source: 'Property', field: 'Common Name', condition: 'starts with' });
            await filter.fillValue('x');
            await filter.addExpectingNoRequest();
            await expect(app.page.getByTestId(/^alert-\d+$/)).toContainText('A filter with the same field and condition already exists');
            expect(app.listRequests).toHaveLength(before);

            await filter.choose({ source: 'Property', field: 'Expires At', condition: 'empty' });
            await filter.assertValueControlDisabled();
            await filter.assertAddEnabled();
            const seen = await filter.add();
            expect(seen.body.filters?.[1]).toEqual({ fieldSource: 'property', fieldIdentifier: 'NOT_AFTER', condition: 'EMPTY' });
            expect('value' in (seen.body.filters?.[1] ?? {})).toBe(false);
            expect(filtersDifference(seen.body.filters, [seen.body.filters![0], { fieldSource: 'property', fieldIdentifier: 'NOT_AFTER', condition: 'EMPTY' }])).toBeUndefined();
            await filter.assertBadges([`Property 'Common Name' starts with '${app.data.plan.prefix}'`, `Property 'Expires At' empty ''`]);
            expect(await inventory.commonNames()).toEqual([]); // every fake row has an expiry
        } finally {
            await app.close();
        }
    });

    test('list values: a multi-select keeps its popover open, sends an array in the order of the picks, the badge joins with OR; a boolean Select takes True / False', async ({ browser }) => {
        const { app, filter } = await open(browser);
        try {
            const seen = await filter.addFilter({ source: 'Property', field: 'Subject Type', condition: 'equals', value: ['Root CA', 'End Entity'] });
            expect(seen.body.filters).toEqual([{ fieldSource: 'property', fieldIdentifier: 'SUBJECT_TYPE', condition: 'EQUALS', value: ['rootCa', 'endEntity'] }]);
            await filter.assertBadges([`Property 'Subject Type' equals 'Root CA OR End Entity'`]);
            expect(await failsFast(filter.addFilter({ source: 'Property', field: 'Subject Type', condition: 'not equals', value: ['No Such Label'] }))).toBe(true);

            // a key size is a number in the catalogue: the label is its text, the wire value stays what the option carries
            const size = await filter.addFilter({ source: 'Property', field: 'Key Size', condition: 'equals', value: '3072' });
            expect(size.body.filters?.[1].value).toEqual([3072]);
            await filter.assertBadges([`Property 'Subject Type' equals 'Root CA OR End Entity'`, `Property 'Key Size' equals '3072'`]);

            // a group value is the group's name on the wire, whatever the option object holds
            const group = await filter.addFilter({ source: 'Property', field: 'Groups', condition: 'equals', value: [app.data.plan.groups.a.name] });
            expect(group.body.filters?.[2].value).toEqual([app.data.plan.groups.a.name]);

            await filter.choose({ source: 'Property', field: 'Has private key', condition: 'equals' });
            expect(await filter.valueKind()).toBe('select');
            await filter.fillValue('False');
            await filter.assertAddEnabled();
        } finally {
            await app.close();
        }
    });

    test('durations: `30d` goes out as P30D, `2d 30m` as P2DT30M and the badge reads them back; `5x` keeps Add disabled and sends nothing', async ({ browser }) => {
        const { app, filter } = await open(browser);
        try {
            const month = await filter.addFilter({ source: 'Property', field: 'Expires At', condition: 'in next', value: '30d' });
            expect(month.body.filters?.[0]).toEqual({ fieldSource: 'property', fieldIdentifier: 'NOT_AFTER', condition: 'IN_NEXT', value: 'P30D' });
            expect(month.json?.totalItems).toBe(3); // C01 +5 d, C02 +15 d, C03 +25 d
            const mixed = await filter.addFilter({ source: 'Property', field: 'Expires At', condition: 'in past', value: '2d 30m' });
            expect(mixed.body.filters?.[1].value).toBe('P2DT30M');
            await filter.assertBadges([`Property 'Expires At' in next '30d'`, `Property 'Expires At' in past '2d 30m'`]);

            const sent = app.listRequests.length;
            await filter.choose({ source: 'Property', field: 'Valid From', condition: 'in next' });
            await expect(filter.durationHint).toBeVisible();
            await filter.assertAddDisabled();
            await filter.fillValue('5x');
            await filter.assertAddDisabled();
            await filter.fillValue('1d 2x');
            await filter.assertAddDisabled();
            await filter.fillValue('5d');
            await filter.assertAddEnabled();
            expect(app.listRequests).toHaveLength(sent);
            expect(await failsFast(filter.assertAddDisabled())).toBe(true);
        } finally {
            await app.close();
        }
    });

    for (const timezoneId of ['UTC', 'Pacific/Auckland', 'America/New_York']) {
        test(`pickDate: the date-time picker walks the calendar, sets the time, and the wire value is the UTC instant of the local pick (${timezoneId})`, async ({ browser }) => {
            const { app, inventory, filter } = await open(browser, { timezoneId });
            try {
                // a month far from the current one, in both directions, across a year end
                const now = new Date();
                for (const delta of [-14, 9, 36]) {
                    const target = new Date(now.getFullYear(), now.getMonth() + delta, 17);
                    const picked = { year: target.getFullYear(), month: target.getMonth() + 1, day: 17, hours: 12, minutes: 5, seconds: 9 };
                    await filter.choose({ source: 'Property', field: 'Expires At', condition: 'greater than or equal' });
                    const shown = await filter.pickDate(picked);
                    expect(shown).toBe(`17.${String(picked.month).padStart(2, '0')}.${picked.year} 12:05:09`);
                    const instant = await filter.instantOf(picked);
                    const seen = await filter.add();
                    expect(seen.body.filters?.[0].value, `${timezoneId} ${delta}`).toBe(instant);
                    expect(instant).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
                    // the instant read back in the browser's zone is the picked wall clock (the runner's zone plays no part)
                    expect(formatDateTime(instant, timezoneId)).toBe(`${picked.year}-${String(picked.month).padStart(2, '0')}-17 12:05:09`);
                    const zone = await inventory.browserTimeZone();
                    expect(zone).toBe(timezoneId);
                    await filter.removeBadge((await filter.badges())[0]);
                }
                // the instant of a local wall time follows the BROWSER zone, not the runner's
                const utcNoon = await filter.instantOf({ year: 2026, month: 6, day: 1, hours: 12 });
                const expectedOffsets: Record<string, string> = { UTC: '2026-06-01T12:00:00.000Z', 'Pacific/Auckland': '2026-06-01T00:00:00.000Z', 'America/New_York': '2026-06-01T16:00:00.000Z' };
                expect(utcNoon).toBe(expectedOffsets[timezoneId]);
            } finally {
                await app.close();
            }
        });
    }

    test('pickDate on a date-only field closes after the day; the badge and wire value of a datetime filter use local and UTC forms', async ({ browser }) => {
        const { app, inventory, filter } = await open(browser, { timezoneId: 'Asia/Kolkata' });
        try {
            await filter.choose({ source: 'Custom attribute', field: app.data.plan.attributes.day.label, condition: 'greater than' });
            const shown = await filter.pickDate({ year: 2030, month: 2, day: 20 });
            expect(shown).toBe('20.02.2030');
            const seen = await filter.add();
            // a date-only field goes out as the picked yyyy-MM-dd: the value is parsed as UTC midnight and cut at the T
            // (dateUtil.ts:128-130), so the zone does not shift the day
            expect(seen.body.filters?.[0].value).toBe('2030-02-20');
            const picked = { year: 2026, month: 11, day: 3, hours: 8, minutes: 0, seconds: 0 };
            await filter.addFilter({ source: 'Property', field: 'Valid From', condition: 'lesser than', value: picked });
            const badge = (await filter.badges())[1];
            expect(badge).toBe("Property 'Valid From' lesser than '2026-11-03 08:00:00'"); // the badge is local time again (getFormattedDateTime)
            expect((await filter.addFilter({ source: 'Property', field: 'Expires At', condition: 'equals', value: { year: 2026, month: 11, day: 4, hours: 0, minutes: 30, seconds: 0 } })).body.filters?.[2].value).toBe('2026-11-03T19:00:00.000Z');
            expect(await inventory.browserTimeZone()).toMatch(/^Asia\/(Kolkata|Calcutta)$/); // the browser may report the alias
        } finally {
            await app.close();
        }
    });

    test('update: a badge is loaded into the form (Add becomes Update) and the edit replaces it; assertRefusalAlert reads the 422 toast', async ({ browser }) => {
        const { app, filter } = await open(browser);
        try {
            await filter.addFilter({ source: 'Property', field: 'Common Name', condition: 'contains', value: 'web' });
            await filter.editBadge("Property 'Common Name' contains 'web'");
            await expect(filter.addButton).toHaveText('Update');
            await filter.textValue.click();
            await filter.textValue.fill('api');
            const seen = await filter.update();
            expect(seen.body.filters).toEqual([{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'CONTAINS', value: 'api' }]);
            await filter.assertBadges([`Property 'Common Name' contains 'api'`]);

            const refused = await filter.addFilter({ source: 'Property', field: 'Common Name', condition: 'equals', value: '__refuse__' });
            expect(refused.status).toBe(422);
            await filter.assertRefusalAlert(/Failed to get list \(422\): Input is not a valid value/);
            expect(await failsFast(filter.assertRefusalAlert(/never shown/))).toBe(true);
        } finally {
            await app.close();
        }
    });

    test('observeListRequest skips a list request the page itself cancelled and returns the next one', async ({ browser }) => {
        const { app } = await open(browser);
        try {
            let first = true;
            await app.page.route('**/api/v1/certificates', (route) => {
                if (first && route.request().method() === 'POST') {
                    first = false;
                    return route.abort();
                }
                return route.fallback();
            });
            const seen = await observeListRequest(app.page, () => app.page.evaluate(() => {
                const send = (n: number) => fetch('/api/v1/certificates', { method: 'POST', body: JSON.stringify({ itemsPerPage: n }) }).then(() => undefined, () => undefined);
                return send(1).then(() => send(2));
            }));
            expect(seen.body.itemsPerPage, 'the cancelled first request is skipped').toBe(2);
            expect(seen.status).toBe(200);
        } finally {
            await app.close();
        }
    });

    test('observeListRequest: waits for the request the action causes (registered before), ignores the catalogue GET and other paths, and fails when none comes', async ({ browser }) => {
        const { app, filter } = await open(browser);
        try {
            const seen = await observeListRequest(app.page, () => filter.sourceTrigger.click().then(() => app.page.keyboard.press('Escape')).then(() => app.page.evaluate(() => fetch('/api/v1/certificates', { method: 'POST', body: '{"itemsPerPage":7}' }).then(() => undefined))));
            expect(seen.body.itemsPerPage).toBe(7);
            expect(isCertificateListRequest(seen.request)).toBe(true);
            const catalogueRequest = app.page.waitForRequest((r) => r.url().includes('/certificates/search'));
            await app.page.evaluate(() => fetch('/api/v1/certificates/search').then(() => undefined));
            expect(isCertificateListRequest(await catalogueRequest), 'the catalogue GET is not the list').toBe(false);
            await expect(observeListRequest(app.page, async () => undefined, { timeout: 500 })).rejects.toThrow(/Timeout/);
            const second = await observeListRequest(app.page, () => app.page.evaluate(() => Promise.all([fetch('/api/v1/certificates', { method: 'POST', body: '{"itemsPerPage":1}' }), fetch('/api/v1/certificates', { method: 'POST', body: '{"itemsPerPage":2}' })]).then(() => undefined)), { match: (b) => b.itemsPerPage === 2 });
            expect(second.body.itemsPerPage).toBe(2);
        } finally {
            await app.close();
        }
    });
});

test.describe('CertificateListPage', () => {
    test.describe.configure({ timeout: 90_000 });

    test('goToList waits for the settled list; columns, headings, cells and the rows read in one pass', async ({ browser }) => {
        const { app, inventory } = await open(browser);
        try {
            await inventory.assertColumns(STANDARD_COLUMNS.map((c) => c.id));
            expect(await inventory.columnHeadings()).toEqual(STANDARD_COLUMNS.map((c) => c.heading));
            expect(await inventory.visibleColumns()).toHaveLength(16);
            expect((await inventory.commonNames()).length).toBe(10);
            const first = app.data.rows[0];
            const row = await inventory.readRow(first.commonName);
            expect(Object.keys(row)).toHaveLength(17); // checkbox column + 16
            expect(row['property:COMMON_NAME']).toEqual({ text: first.commonName, empty: false });
            expect(row['property:OWNER'].empty).toBe(true);
            expect(await failsFast(inventory.assertColumns(['property:COMMON_NAME']))).toBe(true);
        } finally {
            await app.close();
        }
    });

    for (const timezoneId of ['UTC', 'Pacific/Auckland', 'Europe/Prague']) {
        test(`formatForDisplay equals what the page renders for every Standard column of all 24 rows (${timezoneId})`, async ({ browser }) => {
            const { app, inventory } = await open(browser, { timezoneId });
            try {
                await inventory.filterByCommonNamePrefix(app.data.plan.prefix, labels);
                await inventory.setPageSize(25);
                await expect.poll(async () => (await inventory.commonNames()).length).toBe(24);
                const zone = await inventory.browserTimeZone();
                expect(zone).toBe(timezoneId);
                for (const apiRow of app.data.rows) {
                    const expected = Object.fromEntries(STANDARD_COLUMNS.map((c) => [c.id, expectedCell(c.id, apiRow, { timeZone: zone, labels })]));
                    await inventory.assertCellValues(apiRow.commonName, expected);
                }
                await inventory.assertNoForbiddenWords();
            } finally {
                await app.close();
            }
        });
    }

    test('rowByCommonName: a CA whose name is also the Issuer Common Name link of the rows it issued resolves to its own row only', async ({ browser }) => {
        const { app, inventory } = await open(browser);
        try {
            await inventory.filterByCommonNamePrefix(app.data.plan.prefix, labels);
            await inventory.setPageSize(25);
            await expect.poll(async () => (await inventory.commonNames()).length).toBe(24);
            const ca = app.data.rows.find((r) => r.commonName.endsWith('ca-root'))!;
            const issued = app.data.rows.filter((r) => r.issuerCertificateUuid === ca.uuid);
            expect(issued.length, 'the stand-in links the CA from the rows it issued').toBe(3);
            // the row-wide link match the page object used before: the CA row plus the three it issued
            await expect(inventory.rows.filter({ has: app.page.getByRole('link', { name: ca.commonName, exact: true }) })).toHaveCount(4);
            const row = await inventory.rowByCommonName(ca.commonName);
            await expect(row).toHaveCount(1);
            await expect(row).toHaveAttribute('data-id', ca.uuid);
            const cells = await inventory.readRow(ca.commonName);
            expect(cells['property:COMMON_NAME'].text).toBe(ca.commonName);
            const leaf = await inventory.readRow(issued[0].commonName);
            expect(leaf['property:COMMON_NAME'].text).toBe(issued[0].commonName);
            expect(leaf['property:ISSUER_COMMON_NAME'].text).toBe(ca.commonName);
        } finally {
            await app.close();
        }
    });

    test('assertCellValues names every wrong cell; assertNoForbiddenWords fails on a planted word', async ({ browser }) => {
        const data = fakeData();
        const { app, inventory } = await open(browser, { data });
        try {
            const target = data.rows[0];
            await expect(inventory.assertCellValues(target.commonName, { 'property:ARCHIVED': { text: 'Yes' } })).rejects.toThrow(/property:ARCHIVED: expected .{1,3}Yes.{1,3}, got .{1,3}No/);
            expect(await failsFast(inventory.assertCellValues(target.commonName, { 'property:OWNER': { text: 'someone' } }))).toBe(true);
            expect(await failsFast(inventory.assertCellValues(target.commonName, { 'property:ARCHIVED': { empty: true } }))).toBe(true);
            expect(await failsFast(inventory.assertCellValues(target.commonName, { 'property:GROUP_NAME': { contains: ['+3'] } }))).toBe(true);
            await inventory.assertNoForbiddenWords();
            const planted: FakeRow = { ...target, commonName: `${target.commonName} undefined`, serialNumber: 'NaN' };
            app.setRows([planted, ...data.rows.slice(1)]);
            await inventory.filter.addFilter({ source: 'Property', field: 'Common Name', condition: 'contains', value: 'undefined' });
            await expect.poll(async () => (await inventory.commonNames()).length).toBe(1);
            await expect(inventory.assertNoForbiddenWords()).rejects.toThrow(/forbidden word/);
        } finally {
            await app.close();
        }
    });

    test('sorting: sortBy sends the sort, aria-sort and the arrow sit on the sorted header only, the second column takes over, the order follows the comparator', async ({ browser }) => {
        const { app, inventory } = await open(browser);
        try {
            await inventory.filterByCommonNamePrefix(app.data.plan.prefix, labels);
            await inventory.setPageSize(25);
            await inventory.assertNotSorted();
            expect(await idsShown(inventory, app)).toEqual([...SEED_A_DEFAULT_ORDER]);

            const asc = await inventory.sortBy('property:NOT_AFTER');
            expect(asc.body.sort).toEqual({ fieldSource: 'property', fieldIdentifier: 'NOT_AFTER', direction: 'asc' });
            await inventory.assertSortedBy('property:NOT_AFTER', 'asc');
            expect(orderProblem(await idsShown(inventory, app), expectedOrderGroups(app.data.plan, 'NOT_AFTER', 'asc'))).toBeUndefined();
            await inventory.sortBy('property:NOT_AFTER');
            await inventory.assertSortedBy('property:NOT_AFTER', 'desc');
            expect(orderProblem(await idsShown(inventory, app), expectedOrderGroups(app.data.plan, 'NOT_AFTER', 'desc'))).toBeUndefined();

            await inventory.sortBy('property:GROUP_NAME');
            await inventory.assertSortedBy('property:GROUP_NAME', 'asc');
            expect(await failsFast(inventory.assertSortedBy('property:NOT_AFTER', 'desc'))).toBe(true);
            expect(orderProblem(await idsShown(inventory, app), expectedOrderGroups(app.data.plan, 'GROUP_NAME', 'asc'))).toBeUndefined();
            await inventory.sortBy('property:GROUP_NAME');
            expect(orderProblem(await idsShown(inventory, app), expectedOrderGroups(app.data.plan, 'GROUP_NAME', 'desc'))).toBeUndefined();

            await inventory.sortBy('property:OWNER');
            const owners = await inventory.cellTexts('property:OWNER');
            expect(owners.slice(0, 2).every((t) => !t.includes('No value'))).toBe(true);
            expect(owners.slice(2).every((t) => t.includes('No value'))).toBe(true);
            expect(await failsFast(inventory.assertNotSorted())).toBe(true);
        } finally {
            await app.close();
        }
    });

    test('a sort change returns to page 1 (the request asks for it, the pager shows it)', async ({ browser }) => {
        const { app, inventory } = await open(browser);
        try {
            await inventory.filterByCommonNamePrefix(app.data.plan.prefix, labels);
            const toPage2 = await inventory.goToPage(2);
            expect(toPage2.body.pageNumber).toBe(2);
            await inventory.pager.assertPager({ page: 2, pages: 3 });
            const sorted = await inventory.sortBy('property:NOT_AFTER');
            expect(sorted.body.pageNumber).toBe(1);
            await inventory.pager.assertPager({ page: 1, pages: 3 });
            expect(await failsFast(inventory.pager.assertPager({ page: 2, pages: 3 }))).toBe(true);
        } finally {
            await app.close();
        }
    });

    test('the header menu of a column that cannot be ordered: no sort button, both items disabled with the reason, selecting one is inert', async ({ browser }) => {
        const { app, inventory } = await open(browser);
        try {
            await inventory.assertNoSortButton('property:PRIVATE_KEY');
            await inventory.columnMenu('property:PRIVATE_KEY').open();
            await inventory.columnMenu('property:PRIVATE_KEY').assertSortItemsDisabled(NOT_SORTABLE_REASON);
            const mark = inventory.traffic.start().mark();
            await inventory.columnMenu('property:PRIVATE_KEY').clickSortMenuItem('asc');
            await inventory.columnMenu('property:PRIVATE_KEY').assertOpen();
            expect(inventory.traffic.nonReadsSince(mark)).toEqual([]);
            await inventory.columnMenu('property:PRIVATE_KEY').close();
            await inventory.assertNotSorted();
            // a sortable column's items are enabled: the helper must fail there
            await inventory.columnMenu('property:NOT_AFTER').open();
            expect(await failsFast(inventory.columnMenu('property:NOT_AFTER').assertSortItemsDisabled())).toBe(true);
            await inventory.columnMenu('property:NOT_AFTER').close();
            await expect(inventory.assertNoSortButton('property:NOT_AFTER')).rejects.toThrow();
        } finally {
            await app.close();
        }
    });

    test('paging: size options, default size, 10 / 10 / 4 pages, 10 -> 50 from page 3 keeps the page of the first visible row, summary and hidden controls', async ({ browser }) => {
        const { app, inventory } = await open(browser);
        try {
            expect(await inventory.pager.selectedPageSize()).toBe(10);
            expect(await inventory.pager.pageSizeOptions()).toEqual([10, 25, 50, 100]);
            await inventory.filterByCommonNamePrefix(app.data.plan.prefix, labels);
            const seen: CertId[][] = [];
            for (const [i, size] of [10, 10, 4].entries()) {
                if (i > 0) await inventory.goToPage(i + 1);
                await inventory.pager.assertPager({ page: i + 1, pages: 3 });
                seen.push(await idsShown(inventory, app));
                expect(seen[i]).toHaveLength(size);
                expect(await inventory.pager.summary()).toEqual({ from: i * 10 + 1, to: i * 10 + size, total: 24 });
            }
            expect(seen.flat()).toEqual([...SEED_A_DEFAULT_ORDER]);

            const firstOfPage3 = (await inventory.commonNames())[0];
            const resized = await inventory.setPageSize(50);
            expect(resized?.body).toMatchObject({ itemsPerPage: 50, pageNumber: 1 });
            expect(await inventory.commonNames()).toContain(firstOfPage3);
            await inventory.pager.assertPagerHidden();
            expect(await inventory.pager.selectedPageSize()).toBe(50);
            expect(await inventory.setPageSize(50), 'the same size is a no-op').toBeUndefined();
            expect(await failsFast(inventory.pager.assertPager({ page: 1, pages: 1 }))).toBe(true);

            // no rows: the size control, the pager and the summary are hidden
            await inventory.pager.assertPageSizeControl(true);
            await inventory.filter.addFilter({ source: 'Property', field: 'Common Name', condition: 'equals', value: `${app.data.plan.prefix}no-such-row` });
            await expect.poll(async () => (await inventory.commonNames()).length).toBe(0);
            await inventory.pager.assertPageSizeControl(false);
            expect(await inventory.pager.summary()).toBeNull();
            expect(await failsFast(inventory.pager.assertPageSizeControl(true))).toBe(true);
        } finally {
            await app.close();
        }
    });

    test('selection: checkRows ticks rows, the bulk toolbar follows, a page change clears the selection', async ({ browser }) => {
        const { app, inventory } = await open(browser);
        try {
            await inventory.filterByCommonNamePrefix(app.data.plan.prefix, labels);
            await inventory.assertBulkToolbar(false);
            const [a, b] = (await inventory.commonNames()).slice(0, 2);
            await inventory.checkRows([a, b]);
            expect(await inventory.checkedCommonNames()).toEqual([a, b]);
            await inventory.assertBulkToolbar(true);
            expect(await failsFast(inventory.assertBulkToolbar(false))).toBe(true);
            await inventory.goToPage(2);
            expect(await inventory.checkedCommonNames()).toEqual([]);
            await inventory.assertBulkToolbar(false);
            await inventory.goToPage(1);
            expect(await inventory.checkedCommonNames()).toEqual([]);
        } finally {
            await app.close();
        }
    });

    test('include archived: the switch is set through its label and the list refetches with includeArchived; reset keeps nothing but the model\'s defaults', async ({ browser }) => {
        const { app, inventory, filter } = await open(browser);
        try {
            await inventory.assertIncludeArchived(false);
            const on = await inventory.setIncludeArchived(true);
            expect(on?.body.includeArchived).toBe(true);
            await inventory.assertIncludeArchived(true);
            expect(await inventory.setIncludeArchived(true)).toBeUndefined();
            const off = await inventory.setIncludeArchived(false);
            expect(off?.body.includeArchived).toBe(false);
            await filter.addFilter({ source: 'Property', field: 'Common Name', condition: 'contains', value: 'web' });
            const reset = await filter.reset();
            expect(reset.body.filters).toEqual([]);
            await filter.assertBadges([]);
        } finally {
            await app.close();
        }
    });

    test('a list refetch in flight is waited for: afterList settles on the busy overlay, so rows are never read half way', async ({ browser }) => {
        const { app, inventory } = await open(browser, { slowListMs: 150 });
        try {
            await inventory.filterByCommonNamePrefix(app.data.plan.prefix, labels);
            const resized = await inventory.setPageSize(25);
            expect(resized?.json?.certificates).toHaveLength(24);
            // no poll needed: the page settled before afterList returned
            expect((await inventory.commonNames()).length).toBe(24);
        } finally {
            await app.close();
        }
    });
});

test.describe('the REG-CERT-41 / 43 flows (shared helpers) against the stand-in', () => {
    test.describe.configure({ timeout: 90_000 });

    const flow = async (browser: Browser, rows: Array<{ id: string; filters: (plan: ReturnType<typeof fakeData>['plan']) => ReturnType<typeof isolation>[]; expect: (plan: ReturnType<typeof fakeData>['plan']) => string[] }>): Promise<void> => {
        const { app, inventory, filter } = await open(browser);
        try {
            const plan = app.data.plan;
            const catalogue = fakeCatalogue(app.data);
            const byId = new Map(plan.certificates.map((c) => [c.id as string, c.commonName]));
            for (const row of rows) {
                await inventory.setPageSize(25);
                const [f] = row.filters(plan);
                // the row's own STARTS_WITH on Common Name is the narrowed isolation (a second one on the field is refused)
                const narrows = f.fieldIdentifier === 'COMMON_NAME' && f.condition === 'STARTS_WITH';
                const filters = narrows ? [f] : [isolation(plan.prefix), f];
                let seen!: Awaited<ReturnType<FilterWidget['add']>>;
                for (const x of filters) seen = await filter.addFilter(widgetSpecOf(x, catalogue, labels));
                await filter.assertBadges(filters.map((x) => badgeOfFilter(x, catalogue, labels)));
                expect(filtersDifference(seen.body.filters, filters.map((x) => ({ ...x }))), row.id).toBeUndefined();
                const want = row.expect(plan).map((id) => byId.get(id)!).sort();
                await expect.poll(async () => (await inventory.commonNames()).sort(), { message: row.id }).toEqual(want);
                expect(seen.json?.totalItems, row.id).toBe(want.length);
                await filter.reset();
            }
        } finally {
            await app.close();
        }
    };

    // One row per condition kind proves the page object's contract (choose, add, badge, request, rows). The other rows of the tables
    // (the remaining text, date, list and collection rows) repeat a kind and prove the fake engine, not the product: the table unit
    // tests and the live rows cover them.
    test('text conditions, one row per kind (contains, not contains, equals, empty, starts with, matches): badge text, request, rows; the equals row carries its own isolation, the starts-with row narrows the prefix', async ({ browser }) => {
        const rows = TEXT_ROWS.filter((r) => /^T-(1|2|3|5|7|9)$/.test(r.row)).map((r) => ({ id: r.row, filters: (plan: never) => r.filters(plan, {}), expect: (plan: never) => r.expect(plan) as string[] }));
        await flow(browser, rows as never);
    });

    test('list and collection rows L-1a, L-1c, L-3a, L-5c, G-1a: label picks, array on the wire, OR badge, rows', async ({ browser }) => {
        const pick = [['L-1a', LIST_ROWS], ['L-1c', LIST_ROWS], ['L-3a', LIST_ROWS], ['L-5c', LIST_ROWS], ['G-1a', COLLECTION_ROWS]] as const;
        const rows = pick.map(([id, table]) => {
            const r = table.find((x) => x.row === id)!;
            return { id, filters: (plan: never) => r.filters(plan, {}), expect: (plan: never) => r.expect(plan) as string[] };
        });
        await flow(browser, rows as never);
    });

    test('midWindowPick: 35 days after the anchor at 12:00:00 local, the instant of that local time, and the margin guard', async ({ browser }) => {
        for (const timezoneId of ['UTC', 'Pacific/Auckland', 'America/New_York']) {
            const { app, inventory } = await open(browser, { timezoneId });
            try {
                const expiries = app.data.plan.certificates.map((c) => c.notAfter);
                const { picked, instant } = await inventory.pickDateInsideWindow(app.data.plan.clock, 35, expiries);
                expect([picked.hours, picked.minutes, picked.seconds]).toEqual([12, 0, 0]);
                expect(formatDateTime(instant, timezoneId)).toBe(`${picked.year}-${String(picked.month).padStart(2, '0')}-${String(picked.day).padStart(2, '0')} 12:00:00`);
                expect(Math.abs(Date.parse(instant) - (Date.parse(app.data.plan.clock) + 35 * 86400000))).toBeLessThanOrEqual(13 * 3600 * 1000);
                await expect(inventory.pickDateInsideWindow(app.data.plan.clock, 25, expiries)).rejects.toThrow(/not a mid-window value/); // on top of C03's expiry
            } finally {
                await app.close();
            }
        }
    });
});

test('openCertificateList throws before the page is touched when only one of manifest / labels is given', async ({ page }) => {
    const env = {} as TestEnv;
    const m = { prefix: 'qa-reg-x-' } as unknown as SeedAManifest;
    await expect(openCertificateList(page, env, { manifest: m })).rejects.toThrow('labels missing');
    await expect(openCertificateList(page, env, { labels: {} as PlatformLabels })).rejects.toThrow('manifest missing');
    expect(page.url()).toBe('about:blank');
});
