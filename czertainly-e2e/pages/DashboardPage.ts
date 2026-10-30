/**
 * DashboardPage — the certificates dashboard.
 *
 * Provides the five regions by test id (sidebar, count tiles, charts, header, footer), a tile by its heading and a
 * legend item by its button. The smoke suite asserts the sidebar, header, footer and tiles after sign-in through the
 * same regions. Opening the dashboard returns the statistics answer of the same page load, so a number is never
 * compared with another user's data.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { openHashRoute } from './ui/openHashRoute';
import { actAndWaitForApi } from './ui/waitForResponse';

const logger = new Logger('DashboardPage');

/** A statistic by name: the number of certificates behind each legend item of one chart. */
export type DashboardCounts = Record<string, number>;

/** The part of `GET /v1/statistics` the dashboard shows. */
export interface DashboardStatistics {
    totalCertificates: number;
    totalGroups: number;
    totalDiscoveries: number;
    totalRaProfiles: number;
    certificateStatByState?: DashboardCounts;
    certificateStatByValidationStatus?: DashboardCounts;
    certificateStatByExpiry?: DashboardCounts;
}

export class DashboardPage {
    readonly sidebarNav: Locator;
    readonly topTiles: Locator;
    readonly bottomTiles: Locator;
    readonly header: Locator;
    readonly footer: Locator;

    constructor(private readonly page: Page) {
        this.sidebarNav = this.page.getByTestId('sidebar-sticky');
        this.topTiles = this.page.getByTestId('dashboard-counts');
        this.bottomTiles = this.page.getByTestId('dashboard-charts');
        this.header = this.page.getByTestId('header');
        this.footer = this.page.getByTestId('footer');
    }

    /** Opens the certificates dashboard by its route; returns the statistics the page loaded, once the first chart is drawn. */
    async goToCertificatesDashboard(): Promise<DashboardStatistics> {
        logger.info('Opening the certificates dashboard');
        const answer = await actAndWaitForApi(this.page, { method: 'GET', path: /\/api\/v1\/statistics/ }, () => openHashRoute(this.page, 'dashboard/certificates'));
        const statistics = (await answer.json()) as DashboardStatistics;
        await expect(this.chart('Certificates by State')).toBeVisible();
        return statistics;
    }

    /** The section of one count tile, found by its heading. */
    private tile(title: string): Locator {
        return this.topTiles.locator('section').filter({ has: this.page.getByRole('heading', { name: title, exact: true }) });
    }

    /** The section of one chart, found by its heading. */
    private chart(title: string): Locator {
        return this.bottomTiles.locator('section').filter({ has: this.page.getByRole('heading', { name: title, exact: true }) });
    }

    /** The number a count tile shows (every non-digit, such as a thousands separator, is dropped). */
    async readTile(title: string): Promise<number> {
        // The number has no test id yet (FE test-id request): it is the large-text block of the tile.
        const text = await this.tile(title).locator('div.text-3xl').innerText();
        return Number(text.replace(/[^0-9]/g, ''));
    }

    /** The chart with this heading is drawn. */
    async assertChartShown(title: string): Promise<void> {
        await expect(this.chart(title), `the chart "${title}" is drawn`).toBeVisible();
    }

    /**
     * Clicks one legend item of a chart and returns once the certificate inventory is the page. A legend item exists only for a
     * non-zero count, so a missing one fails: the caller has read the statistics and knows the tier has data behind it.
     */
    async openLegendItem(chart: string, item: string): Promise<void> {
        const button = this.chart(chart).getByRole('button', { name: item, exact: true });
        await expect(button, `legend "${item}" is shown in "${chart}" (a legend item exists only for a non-zero count)`).toBeVisible();
        logger.info(`Clicking the legend "${item}" of "${chart}"`);
        await button.click();
        await expect(this.page).toHaveURL(/#\/certificates/);
    }
}
