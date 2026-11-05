/**
 * CertificateListPage — the certificate list: filter badges and rows by Common Name (REG-USE-02).
 * Nothing here creates or deletes anything. Columns are found by the header's data id, never by position.
 */
import { expect, Locator, Page } from '@playwright/test';
import { badgeTextOf } from '../utils/regression/inventory/fieldLabels';
import { ListObservation, observeListRequest } from './ui/list';

export class CertificateListPage {
    readonly page: Page;
    readonly main: Locator;

    // Filter badges above the table (each with its "Remove badge" button)
    readonly filterBadges: Locator;

    // Certificate table
    readonly table: Locator;
    readonly rows: Locator;
    readonly columnHeaders: Locator;

    // Loading state: the skeleton, and the busy overlay of a refetch
    readonly tableSkeleton: Locator;
    readonly tableSkeletonRows: Locator;
    readonly busyOverlay: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.filterBadges = this.main.getByTestId('badge').filter({ has: page.getByRole('button', { name: 'Remove badge' }) });

        this.table = this.main.getByTestId('custom-table');
        this.rows = this.table.locator('tbody tr[data-id]');
        this.columnHeaders = this.table.locator('thead th[data-id]');

        this.tableSkeleton = this.main.getByTestId('table-skeleton');
        this.tableSkeletonRows = this.main.getByTestId('table-skeleton-row');
        this.busyOverlay = this.main.getByTestId('widget-busy-overlay');
    }

    removeBadgeButton(index: number): Locator {
        return this.filterBadges.nth(index).getByRole('button', { name: 'Remove badge' });
    }

    /** A refetch keeps the old rows under the busy overlay, so rows alone prove nothing. */
    async waitForTableLoaded(): Promise<void> {
        await expect(this.table).toBeVisible();
        await expect(this.tableSkeleton).toHaveCount(0);
        await expect(this.tableSkeletonRows).toHaveCount(0);
        await expect(this.busyOverlay).toHaveCount(0);
    }

    /** A CA's name is also the issuer link of every row it issued, so the link is matched in the row's own Common Name cell. */
    async rowByCommonName(commonName: string): Promise<Locator> {
        const index = await this.columnIndex('property:COMMON_NAME');
        return this.rows.filter({ has: this.page.locator(`td:nth-child(${index + 1})`).getByRole('link', { name: commonName, exact: true }) });
    }

    async removeFilterBadge(text: string): Promise<ListObservation> {
        await expect.poll(() => this.filterBadgeTexts(), { message: `badge "${text}"` }).toContain(text);
        const index = (await this.filterBadgeTexts()).indexOf(text);
        const seen = await observeListRequest(this.page, () => this.removeBadgeButton(index).click());
        await this.waitForTableLoaded();
        return seen;
    }

    private async filterBadgeTexts(): Promise<string[]> {
        return (await this.filterBadges.allTextContents()).map(badgeTextOf);
    }

    private async allHeaderIds(): Promise<string[]> {
        return (await this.columnHeaders.evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''))).filter(Boolean);
    }

    private async columnIndex(columnId: string): Promise<number> {
        const index = (await this.allHeaderIds()).indexOf(columnId);
        if (index < 0) throw new Error(`the table has no column ${columnId}`);
        return index;
    }
}
