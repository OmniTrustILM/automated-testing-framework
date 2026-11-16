/**
 * EventHistoryWidget — the Event History tab of an object's detail page: one row per trigger evaluated on the object (REG-WFL-05, 07, 17).
 */
import { expect, Locator, Page } from '@playwright/test';
import { CertificateDetailPage } from './CertificateDetailPage';
import { cellByHeader } from './ui/table';
import { widgetTitled } from './ui/widget';

export class EventHistoryWidget {
    readonly page: Page;

    // Event History widget
    readonly widget: Locator;
    readonly table: Locator;
    readonly rows: Locator;

    constructor(page: Page) {
        this.page = page;

        this.widget = widgetTitled(page.locator('main'), 'Event History');
        this.table = this.widget.getByTestId('paged-custom-table');
        this.rows = this.table.locator('tbody tr[data-id]');
    }

    private triggerRow(triggerName: string): Locator {
        return this.rows.filter({ hasText: triggerName }).first();
    }

    async goToCertificateHistory(uuid: string): Promise<void> {
        await new CertificateDetailPage(this.page).goToDetail(uuid, { tab: 'Event History' });
        await expect(this.widget).toBeVisible();
    }

    /** `true` = met / performed. The cells hold an unnamed lucide icon only, so the check icon's class is the one hook there is. */
    async readObjectRowFlags(triggerName: string): Promise<{ conditions: boolean; actions: boolean }> {
        const row = this.triggerRow(triggerName);
        await expect(row, `an object history row for ${triggerName}`).toBeVisible();
        const met = async (headerId: string) => (await (await cellByHeader(this.table, row, headerId, 'the Event History table')).locator('svg.lucide-check').count()) > 0;
        return { conditions: await met('conditions'), actions: await met('actions') };
    }
}
