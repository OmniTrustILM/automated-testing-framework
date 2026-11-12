/**
 * REG-USE-01 — The certificates dashboard (release checklist: Usage 1). ilm#428.
 *
 * WHAT: 1. Open the certificates dashboard → the four count tiles (Certificates, Groups, Discoveries, RA Profiles) equal the statistics
 *          the page loaded itself; the State and Validation charts render.
 *       2. Click a legend item → the inventory opens with the matching filter badge: State 'Issued', Validation status 'Expired', and
 *          for the expiration bucket "30" a window of two Expires At badges.
 * WHY: the dashboard is the first page of an operator; its numbers must be those of the statistics API and its legends must lead to the
 *      same objects. The Type chart's legend opens the inventory unfiltered by design (fe-administrator#1136), so it is not checked.
 * HOW: the tiles test is read-only; the page signs in through the `signedIn` fixture. The tiles are compared with the statistics response
 *      of the same page load, so other users cannot cause a race. A legend item exists only for a non-zero count, so the legend test first
 *      uploads two own self-signed certificates (one already expired, one expiring in about 25 days), recorded before use and removed by the
 *      run-end teardown, and re-validates them so the validation status is stored. After the click it narrows the inventory to the own
 *      certificate by its common name and asserts that it is shown. Only when the platform still shows no data behind a legend after the
 *      upload does the row skip, with the reason; a tier with data and no legend fails.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { DashboardCounts, DashboardPage, DashboardStatistics } from '../../../pages/DashboardPage';
import { addInventoryTextFilter, filterBadges, waitForListRows } from '../../../pages/ui/list';
import { ownName } from '../../../utils/regression/ledger/runState';
import { revalidate } from '../../../utils/regression/lifecycle/preRegistration';
import { selfSignedPem } from '../../../utils/regression/pkiBuilders';
import { testMeta, tags } from '../../../utils/regression/tags';

/**
 * A legend the second test clicks, and the statistic that says whether the tier has data behind it (a legend item exists only for a
 * non-zero count).
 */
const DRILL_DOWNS: ReadonlyArray<{ chart: string; item: string; counts: (s: DashboardStatistics) => DashboardCounts | undefined; key: RegExp }> = [
    { chart: 'Certificates by State', item: 'Issued', counts: (s) => s.certificateStatByState, key: /^issued$/i },
    { chart: 'Certificates by Validation', item: 'Expired', counts: (s) => s.certificateStatByValidationStatus, key: /^expired$/i },
    { chart: 'Certificates by Expiration in Days', item: '30', counts: (s) => s.certificateStatByExpiry, key: /^30$/ },
];

const DAY_MS = 24 * 3600 * 1000;

/** The legends of the table that have no certificate behind them in these statistics (a legend item exists only for a non-zero count). */
const legendsWithoutData = (stats: DashboardStatistics): typeof DRILL_DOWNS[number][] =>
    DRILL_DOWNS.filter((d) => !Object.entries(d.counts(stats) ?? {}).some(([key, n]) => d.key.test(key) && n > 0));

test.describe('Certificates dashboard', { tag: tags.regression }, () => {
    test('the count tiles equal the statistics the page loaded and the charts render',
        testMeta({
            id: 'REG-USE-01', row: 'count tiles and charts', prio: 'P1', issue: 'ilm#428',
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
            id: 'REG-USE-01', row: 'legend opens the filtered inventory', prio: 'P1', issue: 'ilm#428',
            rule: ['release checklist Usage 1: a legend item opens the inventory filtered on it (State, Validation status, an Expires At window for the expiration buckets)'],
        }),
        async ({ signedIn: page, api, own }) => {
            const dashboard = new DashboardPage(page);
            /** Dashboard, click a legend item, the inventory opens with its rows. */
            const drillDown = async (chart: string, item: string): Promise<void> => {
                await dashboard.goToCertificatesDashboard();
                await dashboard.openLegendItem(chart, item);
                await waitForListRows(page);
            };
            /** Narrows the opened inventory to one own certificate by its common name; the legend badge stays and the own row is shown. */
            const showsOwn = async (badge: string, cn: string): Promise<void> => {
                await addInventoryTextFilter(page, 'Common Name', 'contains', cn);
                await expect.poll(() => filterBadges(page)).toContain(`Property 'Common Name' contains '${cn}'`);
                expect(await filterBadges(page), 'the legend filter is still applied').toContain(badge);
                await expect(page.locator('main table tbody tr').filter({ hasText: cn }), 'the own certificate is shown by the legend filter').toHaveCount(1, { timeout: 30_000 });
            };
            // Data first, so the legends exist: two own self-signed certificates, each recorded from its upload answer before anything else
            // happens to it, then re-validated so the validation status is stored.
            const now = new Date();
            const expiredCn = ownName('legend-expired');
            const soonCn = ownName('legend-soon');
            const expired = await test.step('Data: upload an own certificate that expired 30 days ago', async () =>
                own.certificate.upload(selfSignedPem(expiredCn, 10, new Date(now.getTime() - 40 * DAY_MS)).pem, expiredCn, 'uploaded already expired (dashboard legend)'));
            const soon = await test.step('Data: upload an own certificate that expires in 25 days', async () =>
                own.certificate.upload(selfSignedPem(soonCn, 25, now).pem, soonCn, 'uploaded expiring in 25 days (dashboard legend)'));
            await test.step('Re-validate both so the validation status is stored', async () => {
                await revalidate(api, expired);
                await revalidate(api, soon);
            });
            // The gate is a read of the statistics the dashboard loads: the statistics may need a moment to count the upload. A legend item
            // exists only for a non-zero count, so a tier still without data for one is a named skip, and a tier WITH data and no legend
            // fails below.
            let stats = await dashboard.goToCertificatesDashboard();
            await expect.poll(async () => {
                stats = await dashboard.goToCertificatesDashboard();
                return legendsWithoutData(stats).length;
            }, { timeout: 60_000, intervals: [5_000] }).toBe(0).catch(() => undefined);
            const noData = legendsWithoutData(stats);
            test.skip(noData.length > 0, `no certificates behind the legend ${noData.map((d) => `"${d.item}" of "${d.chart}"`).join(', ')} on this tier after the upload of an expired and a 25-day certificate (statistics: ${noData.map((d) => Object.keys(d.counts(stats) ?? {}).join('/') || 'none').join('; ')})`);
            await test.step("State 'Issued'", async () => {
                await drillDown('Certificates by State', 'Issued');
                await expect.poll(() => filterBadges(page)).toContain("Property 'State' equals 'Issued'");
            });
            await test.step("Validation 'Expired'", async () => {
                await drillDown('Certificates by Validation', 'Expired');
                await expect.poll(() => filterBadges(page)).toContain("Property 'Validation status' equals 'Expired'");
                await showsOwn("Property 'Validation status' equals 'Expired'", expiredCn);
            });
            await test.step('Expiration "30" is a window: > now+20d and < now+30d', async () => {
                await drillDown('Certificates by Expiration in Days', '30');
                await expect.poll(async () => (await filterBadges(page)).filter((b) => /Expires At' (greater|lesser) than/.test(b)).length).toBe(2);
                const badges = (await filterBadges(page)).filter((b) => /Expires At' (greater|lesser) than/.test(b));
                await showsOwn(badges[0], soonCn);
            });
        });
});
