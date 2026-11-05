/**
 * DashboardPage — the certificates dashboard: tiles, charts and legend items by test id or heading.
 * Opening it returns the statistics answer of the same page load, so a number is never compared with another user's data.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { openHashRoute } from './ui/openHashRoute';
import { actAndWaitForApi } from './ui/waitForResponse';

const logger = new Logger('DashboardPage');

export type DashboardCounts = Record<string, number>;

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

    tile(title: string): Locator {
        return this.topTiles.locator('section').filter({ has: this.page.getByRole('heading', { name: title, exact: true }) });
    }

    /** The count has no test id yet: it is the large-text block of the tile. */
    tileValue(title: string): Locator {
        return this.tile(title).locator('div.text-3xl');
    }

    chart(title: string): Locator {
        return this.bottomTiles.locator('section').filter({ has: this.page.getByRole('heading', { name: title, exact: true }) });
    }

    legendItem(chart: string, item: string): Locator {
        return this.chart(chart).getByRole('button', { name: item, exact: true });
    }

    async goToCertificatesDashboard(): Promise<DashboardStatistics> {
        logger.info('Opening the certificates dashboard');
        const answer = await actAndWaitForApi(this.page, { method: 'GET', path: /\/api\/v1\/statistics/ }, () => openHashRoute(this.page, 'dashboard/certificates'));
        const statistics = (await answer.json()) as DashboardStatistics;
        await expect(this.chart('Certificates by State')).toBeVisible();
        return statistics;
    }

    async readTile(title: string): Promise<number> {
        const text = await this.tileValue(title).innerText();
        return Number(text.replace(/[^0-9]/g, ''));
    }

    async assertChartShown(title: string): Promise<void> {
        await expect(this.chart(title), `the chart "${title}" is drawn`).toBeVisible();
    }

    /** Clicks a legend item and returns once the certificate inventory is shown. A legend item exists only for a non-zero count. */
    async openLegendItem(chart: string, item: string): Promise<void> {
        const button = this.legendItem(chart, item);
        await expect(button, `legend "${item}" is shown in "${chart}" (a legend item exists only for a non-zero count)`).toBeVisible();
        logger.info(`Clicking the legend "${item}" of "${chart}"`);
        await button.click();
        await expect(this.page).toHaveURL(/#\/certificates/);
    }
}
