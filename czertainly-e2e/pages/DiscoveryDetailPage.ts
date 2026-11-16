/**
 * DiscoveryDetailPage — the detail page of one discovery: status, header controls, progress and the Results tab (REG-DISC-01 … 03).
 * Stop and resume return the answer of their request; the result table is read only once its busy overlay is gone.
 */
import { expect, Locator, Page } from '@playwright/test';
import type { ApiAnswer } from '../utils/regression/apiReads';
import { headerColumnIndex } from './ui/table';
import { actAndReadAnswer, UUID } from './ui/waitForResponse';

export type DiscoveryStatus = 'inProgress' | 'processing' | 'completed' | 'failed' | 'warning' | 'stopped' | 'cancelled';

/** The badge text the detail page shows for each status. */
export const STATUS_LABEL: Record<DiscoveryStatus, string> = {
    inProgress: 'In Progress',
    processing: 'Processing',
    completed: 'Completed',
    failed: 'Failed',
    warning: 'Warning',
    stopped: 'Stopped',
    cancelled: 'Cancelled',
};

export interface OfferedControls {
    stop: boolean;
    resume: boolean;
    cancel: boolean;
    delete: boolean;
}

export class DiscoveryDetailPage {
    readonly page: Page;
    readonly main: Locator;

    // Header controls
    readonly stopButton: Locator;
    readonly resumeButton: Locator;
    readonly cancelButton: Locator;
    readonly deleteButton: Locator;

    // Discovery details
    readonly statusRow: Locator;
    readonly statusBadge: Locator;
    readonly targetsCaption: Locator;

    // Results tab: Discovered Certificates
    readonly discoveredCertificates: Locator;
    readonly resultsBusyOverlay: Locator;
    readonly resultsTable: Locator;
    readonly resultRows: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        // Header controls
        this.stopButton = this.main.getByTestId('pause-button');
        this.resumeButton = this.main.getByTestId('play-button');
        this.cancelButton = this.main.getByTestId('cancel-button');
        this.deleteButton = this.main.getByTestId('trash-button');

        // Discovery details
        this.statusRow = this.main.locator('tr[data-id="status"]');
        this.statusBadge = this.main.locator('tr[data-id="status"] [data-testid="badge"]');
        this.targetsCaption = this.main.getByTestId('targets-caption');

        // Results tab: Discovered Certificates
        this.discoveredCertificates = this.main
            .locator('section')
            .filter({ has: page.getByRole('heading', { name: 'Discovered Certificates', exact: true }) })
            .last();
        this.resultsBusyOverlay = this.discoveredCertificates.getByTestId('widget-busy-overlay');
        this.resultsTable = this.discoveredCertificates.getByTestId('paged-custom-table');
        this.resultRows = this.resultsTable.locator('tbody tr[data-id]');
    }

    /** A row of the details table by its data id. */
    detailRow(row: string): Locator {
        return this.main.locator(`tr[data-id="${row}"]`);
    }

    /** The value cell of a two-cell details row (label, value). */
    detailValue(row: string): Locator {
        return this.main.locator(`tr[data-id="${row}"] td`).nth(1);
    }

    tab(name: string): Locator {
        return this.main.getByRole('tab', { name, exact: true });
    }

    async goToDetail(uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/discoveries/detail/${uuid}`);
        await expect(this.statusRow).toBeVisible();
    }

    async readDetail(row: string): Promise<string> {
        return (await this.detailValue(row).innerText()).replace(/\s+/g, ' ').trim();
    }

    /** 0 for the `connectorInterface` row of a v1 discovery. */
    async countDetailRows(row: string): Promise<number> {
        return this.detailRow(row).count();
    }

    async readStatusLabel(): Promise<string> {
        await expect(this.statusBadge).toBeVisible();
        return (await this.statusBadge.innerText()).trim();
    }

    async assertStatus(status: DiscoveryStatus): Promise<void> {
        await expect(this.statusBadge).toHaveText(STATUS_LABEL[status]);
    }

    /** A v1 discovery offers delete only. */
    async offeredControls(): Promise<OfferedControls> {
        const has = async (button: Locator) => (await button.count()) > 0;
        return { stop: await has(this.stopButton), resume: await has(this.resumeButton), cancel: await has(this.cancelButton), delete: await has(this.deleteButton) };
    }

    async stopDiscovery(): Promise<ApiAnswer> {
        return actAndReadAnswer(this.page, { method: 'PATCH', path: new RegExp(`/v1/discoveries/${UUID}/stop$`) }, () => this.stopButton.click());
    }

    async resumeDiscovery(): Promise<ApiAnswer> {
        return actAndReadAnswer(this.page, { method: 'PATCH', path: new RegExp(`/v1/discoveries/${UUID}/resume$`) }, () => this.resumeButton.click());
    }

    /** "<processed> / <total> targets" (v2 discoveries), or undefined when the caption is not shown. */
    async readProgress(): Promise<{ processed: number; total: number } | undefined> {
        if (!(await this.targetsCaption.count())) return undefined;
        const m = /(\d[\d,.]*)\s*\/\s*(\d[\d,.]*)/.exec(await this.targetsCaption.first().innerText());
        return m ? { processed: Number(m[1].replace(/[,.]/g, '')), total: Number(m[2].replace(/[,.]/g, '')) } : undefined;
    }

    async openTab(name: string): Promise<void> {
        await this.tab(name).click();
        await expect(this.tab(name)).toHaveAttribute('aria-selected', 'true');
    }

    /**
     * The Fingerprint column (by its header id) of the result rows, colons and case ignored, sorted. The read waits for the busy overlay
     * and for the rows (`expectedCount` pins their number), so an empty table is never read as an answer.
     */
    async readResultFingerprints(expectedCount?: number): Promise<string[]> {
        await expect(this.discoveredCertificates).toBeVisible();
        await expect(this.resultsBusyOverlay).toHaveCount(0);
        if (expectedCount === undefined) await expect(this.resultRows.first()).toBeVisible();
        else await expect(this.resultRows).toHaveCount(expectedCount);
        const column = await headerColumnIndex(this.resultsTable, 'fingerprint', 'the Discovered Certificates table');
        const n = await this.resultRows.count();
        const out: string[] = [];
        for (let i = 0; i < n; i++) out.push((await this.resultRows.nth(i).locator('td').nth(column).innerText()).replace(/[:\s]/g, '').toLowerCase());
        return out.filter(Boolean).sort();
    }
}
