/**
 * DiscoveryDetailPage — the detail page of one discovery.
 *
 * WHAT: the detail page of one discovery: the details table and its status badge, the header controls (stop,
 *       resume, cancel, delete), the progress caption and the Results tab with the discovered certificates.
 * WHY: REG-DISC-01 / 02 / 03 compare what the page shows with the API: status, which controls a v1 and a v2 run
 *       offer, the fingerprints of the result rows; stop and resume return the answer of their request.
 * HOW: rows by data id (`status`, `kind`, `connectorInterface`); controls by test id (`pause-button`, `play-button`,
 *       `cancel-button`, `trash-button`); the progress caption by `targets-caption`; the result column by its header id
 *       (`fingerprint`); the table is read only after its busy overlay is gone and the expected row count is shown.
 *       `assert…` methods never navigate or switch a tab: `goToDetail` and `openTab` do.
 */
import { expect, Locator, Page } from '@playwright/test';
import type { ApiAnswer } from '../utils/regression/apiReads';
import { headerColumnIndex } from './ui/table';
import { actAndWaitForApi, answerFrom, UUID } from './ui/waitForResponse';

/** A discovery's status code (`DiscoveryStatus`). */
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

/** Which header controls the page offers. */
export interface OfferedControls {
    stop: boolean;
    resume: boolean;
    cancel: boolean;
    delete: boolean;
}

export class DiscoveryDetailPage {
    readonly page: Page;
    readonly main: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
    }

    /** Detail URL (hash route) of a discovery. */
    static detailUrl(uuid: string): string {
        return `/administrator/#/discoveries/detail/${uuid}`;
    }

    async goToDetail(uuid: string): Promise<void> {
        await this.page.goto(DiscoveryDetailPage.detailUrl(uuid));
        await expect(this.main.locator('tr[data-id="status"]')).toBeVisible();
    }

    /** The value cell of a details-table row (a two-cell property row: label, value). */
    async readDetail(row: string): Promise<string> {
        return (await this.main.locator(`tr[data-id="${row}"] td`).nth(1).innerText()).replace(/\s+/g, ' ').trim();
    }

    /** How many rows of that id the details table has (0 for the `connectorInterface` row of a v1 discovery). */
    async countDetailRows(row: string): Promise<number> {
        return this.main.locator(`tr[data-id="${row}"]`).count();
    }

    /** The status badge text as shown ("Completed", "In Progress", …), after the badge rendered. */
    async readStatusLabel(): Promise<string> {
        const badge = this.main.locator('tr[data-id="status"] [data-testid="badge"]');
        await expect(badge).toBeVisible();
        return (await badge.innerText()).trim();
    }

    /** The overall status badge on the details table. */
    async assertStatus(status: DiscoveryStatus): Promise<void> {
        await expect(this.main.locator('tr[data-id="status"] [data-testid="badge"]')).toHaveText(STATUS_LABEL[status]);
    }

    /** Which of stop / resume / cancel / delete the page offers right now (a v1 discovery offers delete only). */
    async offeredControls(): Promise<OfferedControls> {
        const has = async (id: string) => (await this.main.getByTestId(id).count()) > 0;
        return { stop: await has('pause-button'), resume: await has('play-button'), cancel: await has('cancel-button'), delete: await has('trash-button') };
    }

    /** Stop (`PATCH …/stop`); returns its answer. */
    async stopDiscovery(): Promise<ApiAnswer> {
        const startedAt = Date.now();
        return answerFrom(await actAndWaitForApi(this.page, { method: 'PATCH', path: new RegExp(`/v1/discoveries/${UUID}/stop$`) }, () => this.main.getByTestId('pause-button').click()), startedAt);
    }

    /** Resume (`PATCH …/resume`); returns its answer. */
    async resumeDiscovery(): Promise<ApiAnswer> {
        const startedAt = Date.now();
        return answerFrom(await actAndWaitForApi(this.page, { method: 'PATCH', path: new RegExp(`/v1/discoveries/${UUID}/resume$`) }, () => this.main.getByTestId('play-button').click()), startedAt);
    }

    /** The progress widget: "<processed> / <total> targets" (v2 discoveries), or undefined when it is not shown. */
    async readProgress(): Promise<{ processed: number; total: number } | undefined> {
        const caption = this.main.getByTestId('targets-caption');
        if (!(await caption.count())) return undefined;
        const m = /(\d[\d,.]*)\s*\/\s*(\d[\d,.]*)/.exec(await caption.first().innerText());
        return m ? { processed: Number(m[1].replace(/[,.]/g, '')), total: Number(m[2].replace(/[,.]/g, '')) } : undefined;
    }

    /** Opens a tab of the detail page (`Details`, `Results`) and waits until it is the selected one. */
    async openTab(name: string): Promise<void> {
        const tab = this.main.getByRole('tab', { name, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
    }

    /**
     * The fingerprints of the "Discovered Certificates" rows (the Fingerprint column, found by its header id), colon separators
     * and case ignored, sorted. The table is filled by its own request: the read waits for the busy overlay to go and for the
     * rows (`expectedCount` pins their number), so an empty table is never read as an answer.
     */
    async readResultFingerprints(expectedCount?: number): Promise<string[]> {
        const widget = this.main.locator('section').filter({ has: this.page.getByRole('heading', { name: 'Discovered Certificates', exact: true }) }).last();
        await expect(widget).toBeVisible();
        const table = widget.getByTestId('paged-custom-table');
        const rows = table.locator('tbody tr[data-id]');
        await expect(widget.getByTestId('widget-busy-overlay')).toHaveCount(0);
        if (expectedCount === undefined) await expect(rows.first()).toBeVisible();
        else await expect(rows).toHaveCount(expectedCount);
        const column = await headerColumnIndex(table, 'fingerprint', 'the Discovered Certificates table');
        const n = await rows.count();
        const out: string[] = [];
        for (let i = 0; i < n; i++) out.push((await rows.nth(i).locator('td').nth(column).innerText()).replace(/[:\s]/g, '').toLowerCase());
        return out.filter(Boolean).sort();
    }
}
