/**
 * CertificateListPage — the certificate list (REG-USE-02).
 *
 * Encapsulates:
 *   - the filter badges above the table, and the removal of one
 *   - the table, its loaded state and a row by its Common Name
 *
 * Nothing here creates or deletes anything on the tier. Columns are found by the header's data id, never by position. A
 * row is found by the Common Name link in its own column, because a CA's name is also the issuer link of every row.
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
    /** The data rows (`tr[data-id=<uuid>]`). */
    readonly rows: Locator;
    readonly columnHeaders: Locator;

    // Loading state: the skeleton, and the busy overlay of a refetch
    readonly tableSkeleton: Locator;
    readonly tableSkeletonRows: Locator;
    readonly busyOverlay: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        // Filter badges above the table (each with its "Remove badge" button)
        this.filterBadges = this.main.getByTestId('badge').filter({ has: page.getByRole('button', { name: 'Remove badge' }) });

        // Certificate table
        this.table = this.main.getByTestId('custom-table');
        this.rows = this.table.locator('tbody tr[data-id]');
        this.columnHeaders = this.table.locator('thead th[data-id]');

        // Loading state: the skeleton, and the busy overlay of a refetch
        this.tableSkeleton = this.main.getByTestId('table-skeleton');
        this.tableSkeletonRows = this.main.getByTestId('table-skeleton-row');
        this.busyOverlay = this.main.getByTestId('widget-busy-overlay');
    }

    /** The "Remove badge" button of the filter badge at `index`. */
    removeBadgeButton(index: number): Locator {
        return this.filterBadges.nth(index).getByRole('button', { name: 'Remove badge' });
    }

    /**
     * The table is shown, no skeleton and no busy overlay (a refetch keeps the old rows under the overlay, so rows alone prove nothing).
     */
    async waitForTableLoaded(): Promise<void> {
        await expect(this.table).toBeVisible();
        await expect(this.tableSkeleton).toHaveCount(0);
        await expect(this.tableSkeletonRows).toHaveCount(0);
        await expect(this.busyOverlay).toHaveCount(0);
    }

    /**
     * A data row by its Common Name: the link with exactly that text in the row's own Common Name cell. A CA's name is also the
     * Issuer Common Name link of every certificate it issued (the certificate table helpers of the admin UI), so a row-wide link match is
     * not one row.
     */
    async rowByCommonName(commonName: string): Promise<Locator> {
        const index = await this.columnIndex('property:COMMON_NAME');
        return this.rows.filter({ has: this.page.locator(`td:nth-child(${index + 1})`).getByRole('link', { name: commonName, exact: true }) });
    }

    /** Removes one filter badge by its text; returns the list request that follows, once the table has loaded again. */
    async removeFilterBadge(text: string): Promise<ListObservation> {
        await expect.poll(() => this.filterBadgeTexts(), { message: `badge "${text}"` }).toContain(text);
        const index = (await this.filterBadgeTexts()).indexOf(text);
        const seen = await observeListRequest(this.page, () => this.removeBadgeButton(index).click());
        await this.waitForTableLoaded();
        return seen;
    }

    /** The badge texts in order, normalised (`Property 'Common Name' contains 'x'`). */
    private async filterBadgeTexts(): Promise<string[]> {
        return (await this.filterBadges.allTextContents()).map(badgeTextOf);
    }

    /** Every header id including the checkbox column, in order (a row's n-th `td` belongs to the n-th id). */
    private async allHeaderIds(): Promise<string[]> {
        return (await this.columnHeaders.evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''))).filter(Boolean);
    }

    private async columnIndex(columnId: string): Promise<number> {
        const index = (await this.allHeaderIds()).indexOf(columnId);
        if (index < 0) throw new Error(`the table has no column ${columnId}`);
        return index;
    }
}
