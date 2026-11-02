/**
 * Offline checks of pages/CertificateListPage.ts and the list helpers of pages/ui/list.ts against a stand-in of the admin
 * UI (tests/unit/helpers/fakeCertificateListApp.ts). Each assertion meant to catch a wrong page is shown failing on one.
 */
import { Browser, expect, test } from '@playwright/test';
import { CertificateListPage } from '../../pages/CertificateListPage';
import { Navigation } from '../../pages/Navigation';
import { addInventoryTextFilter, filterBadges, isCertificateListRequest, observeListRequest } from '../../pages/ui/list';
import { chooseOption } from '../../pages/ui/select';
import { Served, serveInventory } from './helpers/fakeCertificateListApp';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

/** The stand-in with the certificate list opened from the sidebar and loaded. */
async function open(browser: Browser, opts: Parameters<typeof serveInventory>[1] = {}): Promise<{ app: Served; inventory: CertificateListPage }> {
    const app = await serveInventory(browser, opts);
    const inventory = new CertificateListPage(app.page);
    await new Navigation(app.page).openViaSidebar('Certificates', /\/certificates/i);
    await inventory.waitForTableLoaded();
    return { app, inventory };
}

test.describe.configure({ timeout: 90_000 });

test('addInventoryTextFilter shows the badge; removeFilterBadge sends the list request without it and returns once the slow refetch has loaded', async ({ browser }) => {
    const { app, inventory } = await open(browser, { slowListMs: 150 });
    try {
        const prefix = app.data.plan.prefix;
        const startsWith = `Property 'Common Name' starts with '${prefix}'`;
        await addInventoryTextFilter(app.page, 'Common Name', 'starts with', prefix);
        await expect.poll(() => filterBadges(app.page)).toEqual([startsWith]);
        await inventory.waitForTableLoaded();
        await addInventoryTextFilter(app.page, 'Common Name', 'contains', 'web');
        await expect(inventory.rows).toHaveCount(4); // C01, C03, C06, C07

        const removed = await inventory.removeFilterBadge(`Property 'Common Name' contains 'web'`);
        expect(removed.body.filters).toEqual([{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: prefix }]);
        // no poll: the table had loaded again before removeFilterBadge returned (24 rows, 10 on the page)
        expect(await inventory.rows.count()).toBe(10);
        expect(await filterBadges(app.page)).toEqual([startsWith]);
        expect(await failsFast(inventory.removeFilterBadge(`Property 'Common Name' contains 'web'`)), 'a badge that is not shown fails').toBe(true);
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
    const { app } = await open(browser);
    try {
        const sourceTrigger = app.page.locator('main').getByTestId('select-group-trigger');
        const seen = await observeListRequest(app.page, () => sourceTrigger.click().then(() => app.page.keyboard.press('Escape')).then(() => app.page.evaluate(() => fetch('/api/v1/certificates', { method: 'POST', body: '{"itemsPerPage":7}' }).then(() => undefined))));
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

test('rowByCommonName: a CA whose name is also the Issuer Common Name link of the rows it issued resolves to its own row only', async ({ browser }) => {
    const { app, inventory } = await open(browser);
    try {
        await addInventoryTextFilter(app.page, 'Common Name', 'starts with', app.data.plan.prefix);
        await expect.poll(() => filterBadges(app.page)).toHaveLength(1);
        await inventory.waitForTableLoaded();
        await chooseOption(app.page, app.page.getByTestId('select-pageSize-trigger'), '25');
        await expect(inventory.rows).toHaveCount(24);
        const ca = app.data.rows.find((r) => r.commonName.endsWith('ca-root'))!;
        const issued = app.data.rows.filter((r) => r.issuerCertificateUuid === ca.uuid);
        expect(issued.length, 'the stand-in links the CA from the rows it issued').toBe(3);
        // the row-wide link match: the CA row plus the three it issued
        await expect(inventory.rows.filter({ has: app.page.getByRole('link', { name: ca.commonName, exact: true }) })).toHaveCount(4);
        const row = await inventory.rowByCommonName(ca.commonName);
        await expect(row).toHaveCount(1);
        await expect(row).toHaveAttribute('data-id', ca.uuid);
        await expect(await inventory.rowByCommonName(issued[0].commonName)).toHaveAttribute('data-id', issued[0].uuid);
    } finally {
        await app.close();
    }
});
