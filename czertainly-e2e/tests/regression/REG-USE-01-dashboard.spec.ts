/**
 * REG-USE-01 — the certificates dashboard (release checklist: Usage 1), read-only: the four count tiles equal the
 * statistics the page loaded itself (no race with other users), the State and Validation charts render, and a legend
 * click opens the inventory with the matching filter badge. The Type chart's legend opens the inventory unfiltered by
 * design (fe-administrator#1136), so it is not checked.
 */
import { Page } from '@playwright/test';
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { filterBadges, waitForListRows } from '../../pages/ui/list';
import { actAndWaitForApi } from '../../pages/ui/waitForResponse';
import { testMeta, tags } from '../../utils/regression/tags';

type Stats = { totalCertificates: number; totalGroups: number; totalDiscoveries: number; totalRaProfiles: number };

async function openDashboard(page: Page): Promise<Stats> {
    const statsResponse = await actAndWaitForApi(page, { method: 'GET', path: /\/api\/v1\/statistics/ }, () => page.goto('administrator/#/dashboard/certificates'));
    const stats = (await statsResponse.json()) as Stats;
    await expect(page.getByTestId('dashboard-charts').getByRole('heading', { name: 'Certificates by State' })).toBeVisible();
    return stats;
}

const tileNumber = (page: Page, title: string) =>
    page.getByTestId('dashboard-counts').locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).locator('div.text-3xl');

const legend = (page: Page, chart: string, item: string) =>
    page.getByTestId('dashboard-charts').locator('section').filter({ has: page.getByRole('heading', { name: chart, exact: true }) }).getByRole('button', { name: item, exact: true });

/** Dashboard → click a legend item → the inventory opens; returns once a filter badge is shown. */
async function drillDown(page: Page, chart: string, item: string): Promise<void> {
    await openDashboard(page);
    const button = legend(page, chart, item);
    if (!(await button.isVisible())) test.skip(true, `legend "${item}" is not shown in "${chart}" on this tier (no data)`);
    await button.click();
    await expect(page).toHaveURL(/#\/certificates/);
    await waitForListRows(page);
}

test.describe('Certificates dashboard', { tag: tags.regression }, () => {
    test('the count tiles equal the statistics the page loaded and the charts render',
        testMeta({
            id: 'REG-USE-01', prio: 'P2', issue: 'ilm#428',
            rule: ['release checklist Usage 1: the dashboard tiles show the totals of GET /v1/statistics; the State and Validation charts render'],
        }),
        async ({ page, env }) => {
            await loginAsSmokeUser(page, env);
            const stats = await test.step('Open the certificates dashboard', async () => openDashboard(page));

            await test.step('The 4 count tiles equal GET /api/v1/statistics', async () => {
                const expected: Record<string, number> = {
                    Certificates: stats.totalCertificates,
                    Groups: stats.totalGroups,
                    Discoveries: stats.totalDiscoveries,
                    'RA Profiles': stats.totalRaProfiles,
                };
                for (const [title, value] of Object.entries(expected)) {
                    const text = (await tileNumber(page, title).innerText()).replace(/[^0-9]/g, '');
                    expect(Number(text), `tile ${title}`).toBe(value);
                }
            });

            await test.step('State and Validation charts render', async () => {
                for (const chart of ['Certificates by State', 'Certificates by Validation']) {
                    await expect(page.getByTestId('dashboard-charts').getByRole('heading', { name: chart })).toBeVisible();
                }
            });
        });

    test('a chart legend click opens the inventory with the matching filter',
        testMeta({
            id: 'REG-USE-01', prio: 'P2', issue: 'ilm#428',
            rule: ['release checklist Usage 1: a legend item opens the inventory filtered on it (State, Validation status, an Expires At window for the expiration buckets)'],
        }),
        async ({ page, env }) => {
            await loginAsSmokeUser(page, env);
            await test.step("State 'Issued'", async () => {
                await drillDown(page, 'Certificates by State', 'Issued');
                await expect.poll(() => filterBadges(page)).toContain("Property 'State' equals 'Issued'");
            });
            await test.step("Validation 'Expired'", async () => {
                await drillDown(page, 'Certificates by Validation', 'Expired');
                await expect.poll(() => filterBadges(page)).toContain("Property 'Validation status' equals 'Expired'");
            });
            await test.step('Expiration "30" is a window: > now+20d and < now+30d', async () => {
                await drillDown(page, 'Certificates by Expiration in Days', '30');
                await expect.poll(async () => (await filterBadges(page)).filter((b) => /Expires At' (greater|lesser) than/.test(b)).length).toBe(2);
            });
        });
});
