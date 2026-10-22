/**
 * REG-USE-01 — The certificates dashboard (release checklist: Usage 1). ilm#428.
 *
 * WHAT: 1. Open the certificates dashboard → the four count tiles (Certificates, Groups, Discoveries, RA Profiles) equal the statistics
 *          the page loaded itself; the State and Validation charts render.
 *       2. Click a legend item → the inventory opens with the matching filter badge: State 'Issued', Validation status 'Expired', and
 *          for the expiration bucket "30" a window of two Expires At badges.
 * WHY: the dashboard is the first page of an operator; its numbers must be those of the statistics API and its legends must lead to the
 *      same objects. The Type chart's legend opens the inventory unfiltered by design (fe-administrator#1136), so it is not checked.
 * HOW: read-only; the page signs in through the `signedIn` fixture. The tiles are compared with the statistics response of the same page
 *      load, so other users cannot cause a race. A legend item exists only for a non-zero count: a tier without data behind one skips with
 *      the named reason, a tier with data and no legend fails.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { DashboardCounts, DashboardPage, DashboardStatistics } from '../../../pages/DashboardPage';
import { filterBadges, waitForListRows } from '../../../pages/ui/list';
import { testMeta, tags } from '../../../utils/regression/tags';

/** A legend the second test clicks, and the statistic that says whether the tier has data behind it (a legend item exists only for a non-zero count). */
const DRILL_DOWNS: ReadonlyArray<{ chart: string; item: string; counts: (s: DashboardStatistics) => DashboardCounts | undefined; key: RegExp }> = [
    { chart: 'Certificates by State', item: 'Issued', counts: (s) => s.certificateStatByState, key: /^issued$/i },
    { chart: 'Certificates by Validation', item: 'Expired', counts: (s) => s.certificateStatByValidationStatus, key: /^expired$/i },
    { chart: 'Certificates by Expiration in Days', item: '30', counts: (s) => s.certificateStatByExpiry, key: /^30$/ },
];

test.describe('Certificates dashboard', { tag: tags.regression }, () => {
    test('the count tiles equal the statistics the page loaded and the charts render',
        testMeta({
            id: 'REG-USE-01', prio: 'P1', issue: 'ilm#428',
            rule: ['release checklist Usage 1: the dashboard tiles show the totals of GET /v1/statistics; the State and Validation charts render'],
        }),
        async ({ signedIn: page }) => {
            const dashboard = new DashboardPage(page);
            const stats = await test.step('Open the certificates dashboard', async () => dashboard.goToCertificatesDashboard());

            await test.step('The 4 count tiles equal GET /api/v1/statistics', async () => {
                const expected: Record<string, number> = {
                    Certificates: stats.totalCertificates,
                    Groups: stats.totalGroups,
                    Discoveries: stats.totalDiscoveries,
                    'RA Profiles': stats.totalRaProfiles,
                };
                for (const [title, value] of Object.entries(expected)) {
                    expect(await dashboard.readTile(title), `tile ${title}`).toBe(value);
                }
            });

            await test.step('State and Validation charts render', async () => {
                for (const chart of ['Certificates by State', 'Certificates by Validation']) await dashboard.assertChartShown(chart);
            });
        });

    test('a chart legend click opens the inventory with the matching filter',
        testMeta({
            id: 'REG-USE-01', prio: 'P1', issue: 'ilm#428',
            rule: ['release checklist Usage 1: a legend item opens the inventory filtered on it (State, Validation status, an Expires At window for the expiration buckets)'],
        }),
        async ({ signedIn: page }) => {
            const dashboard = new DashboardPage(page);
            /** Dashboard, click a legend item, the inventory opens with its rows. */
            const drillDown = async (chart: string, item: string): Promise<void> => {
                await dashboard.goToCertificatesDashboard();
                await dashboard.openLegendItem(chart, item);
                await waitForListRows(page);
            };
            // The gate is a read of the statistics the dashboard loads, before the first assertion: a legend item exists only for a
            // non-zero count, so a tier without data for one is a named skip, and a tier WITH data and no legend fails below.
            const stats = await dashboard.goToCertificatesDashboard();
            const noData = DRILL_DOWNS.filter((d) => !Object.entries(d.counts(stats) ?? {}).some(([key, n]) => d.key.test(key) && n > 0));
            test.skip(noData.length > 0, `no certificates behind the legend ${noData.map((d) => `"${d.item}" of "${d.chart}"`).join(', ')} on this tier (statistics: ${noData.map((d) => Object.keys(d.counts(stats) ?? {}).join('/') || 'none').join('; ')})`);
            await test.step("State 'Issued'", async () => {
                await drillDown('Certificates by State', 'Issued');
                await expect.poll(() => filterBadges(page)).toContain("Property 'State' equals 'Issued'");
            });
            await test.step("Validation 'Expired'", async () => {
                await drillDown('Certificates by Validation', 'Expired');
                await expect.poll(() => filterBadges(page)).toContain("Property 'Validation status' equals 'Expired'");
            });
            await test.step('Expiration "30" is a window: > now+20d and < now+30d', async () => {
                await drillDown('Certificates by Expiration in Days', '30');
                await expect.poll(async () => (await filterBadges(page)).filter((b) => /Expires At' (greater|lesser) than/.test(b)).length).toBe(2);
            });
        });
});
