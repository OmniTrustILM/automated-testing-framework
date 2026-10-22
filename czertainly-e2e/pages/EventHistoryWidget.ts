/**
 * EventHistoryWidget — the "Event History" widget.
 *
 * WHAT: the "Event History" widget in its two modes: the platform event page (one row per firing) and an object's Event History tab (one
 *       row per trigger evaluated on it).
 * WHY: specs read whether a trigger's conditions were met and its actions performed on a certificate.
 * HOW: the widget by its heading; cells by their column's header id; paging is `PagerWidget`; the met / performed cells draw an icon with
 *      no name, so the icon's class is the only hook (no test id in the FE yet). `goToObjectHistory` opens the tab of an object's detail
 *      page; the read methods only read.
 */
import { expect, Locator, Page } from '@playwright/test';
import { PagerWidget } from './PagerWidget';
import { cellByHeader } from './ui/table';

export type EventHistoryMode = 'platform' | 'object';

export class EventHistoryWidget {
    readonly widget: Locator;
    readonly pager: PagerWidget;
    readonly table: Locator;
    /** The data rows (the header row has `th` cells only). */
    readonly rows: Locator;
    readonly firingDialog: Locator;
    readonly evaluationDialog: Locator;

    /** `scope` narrows the page when it holds several widgets (a detail page has one Event History tab). */
    constructor(page: Page, private readonly mode: EventHistoryMode, scope?: Locator) {
        this.widget = (scope ?? page.locator('main')).locator('section').filter({ has: page.getByRole('heading', { name: 'Event History', exact: true }) }).last();
        this.pager = new PagerWidget(page, this.widget);
        this.table = this.widget.getByTestId('paged-custom-table');
        this.rows = this.table.locator('tbody tr[data-id]');
        this.firingDialog = page.getByRole('dialog', { name: 'Event firing details' });
        this.evaluationDialog = page.getByRole('dialog', { name: 'Evaluation details' });
    }

    /** The Event History tab of an object's detail page (`?tab=event-history`), then the widget (object mode). */
    static async goToObjectHistory(page: Page, detailUrl: string): Promise<EventHistoryWidget> {
        await page.goto(`${detailUrl}${detailUrl.includes('?') ? '&' : '?'}tab=event-history`);
        const w = new EventHistoryWidget(page, 'object');
        await expect(w.widget).toBeVisible();
        return w;
    }

    /** The Details button of a row (title "Details"). */
    private detailsButton(rowIndex: number): Locator {
        return this.rows.nth(rowIndex).getByRole('button', { name: 'Details' });
    }

    /** Platform mode: Details of a firing row opens "Event firing details". */
    async openFiringDialog(rowIndex: number): Promise<void> {
        if (this.mode !== 'platform') throw new Error('openFiringDialog is for the platform event page; an object widget opens the evaluation directly');
        await this.detailsButton(rowIndex).click();
        await expect(this.firingDialog).toBeVisible();
    }

    /** Object mode: Details of a trigger row opens "Evaluation details" directly. */
    async openEvaluationDialog(rowIndex: number): Promise<void> {
        if (this.mode !== 'object') throw new Error('openEvaluationDialog is for an object widget; the platform page opens a firing dialog first');
        await this.detailsButton(rowIndex).click();
        await expect(this.evaluationDialog).toBeVisible();
    }

    /**
     * Object mode: the Conditions / Actions cells of a trigger's row (`true` = met / performed). The cells hold an icon only
     * (the FE draws lucide `check` / `x` with no accessible name), so the check icon's class is the one hook there is.
     */
    async readObjectRowFlags(triggerName: string): Promise<{ conditions: boolean; actions: boolean }> {
        const row = this.rows.filter({ hasText: triggerName }).first();
        await expect(row, `an object history row for ${triggerName}`).toBeVisible();
        const met = async (headerId: string) => (await (await cellByHeader(this.table, row, headerId, 'the Event History table')).locator('svg.lucide-check').count()) > 0;
        return { conditions: await met('conditions'), actions: await met('actions') };
    }
}
