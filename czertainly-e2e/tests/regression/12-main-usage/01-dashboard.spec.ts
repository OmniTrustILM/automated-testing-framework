/**
 * REG-USE-01 — The certificates dashboard (release checklist: Usage 1; ilm#428). The four count tiles equal the
 * statistics the page loaded itself, and a legend click opens the inventory with the matching filter badge.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { DashboardCounts, DashboardPage, DashboardStatistics } from '../../../pages/DashboardPage';
import { addInventoryTextFilter, filterBadges, waitForListRows } from '../../../pages/ui/list';
import { ownName } from '../../../utils/regression/ledger/runState';
import { revalidate } from '../../../utils/regression/lifecycle/preRegistration';
import { patchOwnCertificateOk } from '../../../utils/regression/inventory/seedOwnedObjects';
import { selfSignedPem } from '../../../utils/regression/pkiBuilders';
import { testMeta, tags } from '../../../utils/regression/tags';

const DRILL_DOWNS: ReadonlyArray<{ chart: string; item: string; counts: (s: DashboardStatistics) => DashboardCounts | undefined; key: RegExp }> = [
    { chart: 'Certificates by State', item: 'Issued', counts: (s) => s.certificateStatByState, key: /^issued$/i },
    { chart: 'Certificates by Validation', item: 'Expired', counts: (s) => s.certificateStatByValidationStatus, key: /^expired$/i },
    { chart: 'Certificates by Expiration in Days', item: '30', counts: (s) => s.certificateStatByExpiry, key: /^30$/ },
];

const DAY_MS = 24 * 3600 * 1000;

const legendsWithoutData = (stats: DashboardStatistics, legends: typeof DRILL_DOWNS): string[] =>
    legends
        .filter((d) => !Object.entries(d.counts(stats) ?? {}).some(([key, n]) => d.key.test(key) && n > 0))
        .map((d) => `"${d.item}" of "${d.chart}" (statistics: ${Object.keys(d.counts(stats) ?? {}).join('/') || 'none'})`);

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
            rule: [
                'release checklist Usage 1: a legend item opens the inventory filtered on it (State, Validation status, an Expires At window for the expiration buckets)',
                'the statistics are counted live, so after the uploads "Issued" and "30" always have a legend; "Expired" only while validation is on',
            ],
        }),
        async ({ signedIn: page, api, own }, testInfo) => {
            const dashboard = new DashboardPage(page);
            const drillDown = async (chart: string, item: string): Promise<void> => {
                await dashboard.goToCertificatesDashboard();
                await dashboard.openLegendItem(chart, item);
                await waitForListRows(page);
            };
            const showsOwn = async (badge: string, cn: string): Promise<void> => {
                await addInventoryTextFilter(page, 'Common Name', 'contains', cn);
                await expect.poll(() => filterBadges(page)).toContain(`Property 'Common Name' contains '${cn}'`);
                expect(await filterBadges(page), 'the legend filter is still applied').toContain(badge);
                await expect(page.locator('main table tbody tr').filter({ hasText: cn }), 'the own certificate is shown by the legend filter').toHaveCount(1, { timeout: 30_000 });
            };
            const now = new Date();
            const expiredCn = ownName('legend-expired');
            const soonCn = ownName('legend-soon');
            const expired = await test.step('Data: upload an own certificate that expired 30 days ago', async () =>
                own.certificate.upload(selfSignedPem(expiredCn, 10, new Date(now.getTime() - 40 * DAY_MS)).pem, expiredCn, 'uploaded already expired (dashboard legend)'));
            const soon = await test.step('Data: upload an own certificate that expires in 25 days', async () =>
                own.certificate.upload(selfSignedPem(soonCn, 25, now).pem, soonCn, 'uploaded expiring in 25 days (dashboard legend)'));
            const validation = await test.step('Mark the expired certificate trusted and re-validate both', async () => {
                // Self-signed and untrusted, it validates as invalid: core checks the chain before the validity.
                await patchOwnCertificateOk(api, expired, { trustedCa: true });
                await revalidate(api, soon);
                return revalidate(api, expired);
            });
            const validationOff = validation.resultStatus === 'not_checked';
            if (validationOff) {
                testInfo.annotations.push({ type: 'skipped-step', description: `Validation 'Expired': ${String(validation.message ?? 'validation is off on this tier')}` });
            } else {
                expect(validation.resultStatus, 'the own expired certificate, marked trusted, validates as expired').toBe('expired');
            }
            const wanted = DRILL_DOWNS.filter((d) => !(validationOff && d.item === 'Expired'));
            await expect.poll(async () => legendsWithoutData(await dashboard.goToCertificatesDashboard(), wanted), {
                message: 'a legend for each own upload (a legend exists only for a non-zero count)', timeout: 60_000, intervals: [5_000],
            }).toEqual([]);
            await test.step("State 'Issued'", async () => {
                await drillDown('Certificates by State', 'Issued');
                await expect.poll(() => filterBadges(page)).toContain("Property 'State' equals 'Issued'");
            });
            await test.step("Validation 'Expired'", async (step) => {
                step.skip(validationOff, 'validation is off on this tier');
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
