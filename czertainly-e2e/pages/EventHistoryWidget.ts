/**
 * EventHistoryWidget — the "Event History" widget of the admin UI, in its three shapes:
 * - the PLATFORM event page (`#/events/detail/<event>`): one row per firing (Started At, Finished At, Status, Resource,
 *   Obj. Evaluated, Obj. Matched, Obj. Ignored, Details);
 * - the OBJECT widget on a group, certificate or discovery detail page (Event History tab): one row per (event, trigger)
 *   evaluated on the object (Event, Trigger, Conditions, Actions, Triggered at, Message, Details);
 * - the "Event firing details" dialog a firing's Details button opens (Object, Trigger, Conditions, Actions, Triggered at,
 *   Message, Details), and the "Evaluation details" dialog behind it ("Notification sent" Yes / No, records).
 *
 * Hooks (fe-administrator `EventHistoryWidget`, `ObjectEventHistoryWidget`, `CustomTable`, read in the source): the table is a
 * `paged-custom-table` inside the widget titled "Event History"; paging is the shared `pagination` (`pagination-prev|next|
 * page-N`, shown when more than one page) and the page-size select `select-pageSize-trigger` (options 10, 25, 50, 100; it
 * appears once there are rows); the Details button of a row has the title "Details" (icon only); the Conditions and
 * Actions cells hold `svg.lucide-check` (met) or `svg.lucide-x`. The recommendation of the Phase 4 hooks table (R1: names for
 * icon-only buttons) would replace the structural scope of the icon cells.
 *
 * Which page has which dialog (fe-administrator origin/main): the PLATFORM page (`#/events/detail/<event>`, `EventHistoryWidget/index.tsx`)
 * lists FIRINGS of the platform-level scope and its Details opens "Event firing details" (`openFiring`), whose rows open "Evaluation
 * details". The OBJECT widget (certificate, group, discovery detail; `ObjectEventHistoryWidget/index.tsx`) lists one row per (event, trigger)
 * of that object and its Details opens "Evaluation details" DIRECTLY (`openEvaluation`): there is no firing dialog there, and an RA profile
 * has no Event History tab at all. The detail pages read `?tab=event-history` (the tab layout's slug).
 */
import { expect, Locator, Page } from '@playwright/test';

export type HistoryColumn = 'startedAt' | 'finishedAt' | 'status' | 'resource' | 'evaluated' | 'matched' | 'ignored';

const FIRING_COLUMNS: Record<HistoryColumn, number> = { startedAt: 0, finishedAt: 1, status: 2, resource: 3, evaluated: 4, matched: 5, ignored: 6 };

export class EventHistoryWidget {
    readonly page: Page;
    readonly widget: Locator;

    /** `scope` narrows the page when it holds several widgets (a detail page has one Event History tab). */
    constructor(page: Page, scope?: Locator) {
        this.page = page;
        this.widget = (scope ?? page.locator('main')).locator('section').filter({ has: page.getByRole('heading', { name: 'Event History', exact: true }) }).last();
    }

    /** The Event History tab of a detail page (`?tab=event-history`), then the widget. */
    static async onTab(page: Page, detailUrl: string): Promise<EventHistoryWidget> {
        await page.goto(`${detailUrl}${detailUrl.includes('?') ? '&' : '?'}tab=event-history`);
        const w = new EventHistoryWidget(page);
        await expect(w.widget).toBeVisible();
        return w;
    }

    get table(): Locator {
        return this.widget.getByTestId('paged-custom-table');
    }

    /** The data rows (the header row has `th` cells only). */
    get rows(): Locator {
        return this.table.locator('tbody tr[data-id]');
    }

    async rowCount(): Promise<number> {
        return this.rows.count();
    }

    async cellTexts(columnIndex: number): Promise<string[]> {
        const n = await this.rows.count();
        const out: string[] = [];
        for (let i = 0; i < n; i++) out.push((await this.rows.nth(i).locator('td').nth(columnIndex).innerText()).replace(/\s+/g, ' ').trim());
        return out;
    }

    /** `Finished`, `In Progress` or `Failed` per firing row (platform / object-defined firing table). */
    firingStatuses(): Promise<string[]> {
        return this.cellTexts(FIRING_COLUMNS.status);
    }

    /** A firing row's counters: Obj. Evaluated / Matched / Ignored. */
    async firingCounts(rowIndex: number): Promise<{ evaluated: number; matched: number; ignored: number }> {
        const row = this.rows.nth(rowIndex);
        const num = async (c: HistoryColumn) => Number((await row.locator('td').nth(FIRING_COLUMNS[c]).innerText()).trim());
        return { evaluated: await num('evaluated'), matched: await num('matched'), ignored: await num('ignored') };
    }

    async setPageSize(size: 10 | 25 | 50 | 100): Promise<void> {
        const trigger = this.widget.getByTestId('select-pageSize-trigger');
        await expect(trigger).toBeVisible();
        await trigger.click();
        await this.page.getByTestId('select-pageSize-content').locator(`[role=option][data-value="${size}"]`).click();
    }

    async goToPage(n: number): Promise<void> {
        await this.widget.getByTestId(`pagination-page-${n}`).click();
    }

    /** The "Showing X to Y items of N" summary: the total the table reports. */
    async reportedTotal(): Promise<number> {
        const text = await this.widget.getByText(/Showing \d+ to \d+ items of \d+/).first().innerText();
        return Number(/of (\d+)/.exec(text)![1]);
    }

    /** The Details button of a row (title "Details"). */
    detailsButton(rowIndex: number): Locator {
        return this.rows.nth(rowIndex).getByRole('button', { name: 'Details' });
    }

    get firingDialog(): Locator {
        return this.page.getByRole('dialog', { name: 'Event firing details' });
    }

    get evaluationDialog(): Locator {
        return this.page.getByRole('dialog', { name: 'Evaluation details' });
    }

    /** PLATFORM page only (`#/events/detail/<event>`): Details of a firing row opens "Event firing details". */
    async openFiring(rowIndex: number): Promise<void> {
        expect(this.page.url(), 'openFiring is for the platform event page; object pages use openEvaluation').toMatch(/#\/events\/detail\//);
        await this.detailsButton(rowIndex).click();
        await expect(this.firingDialog).toBeVisible();
    }

    /** OBJECT widget (a certificate / group / discovery detail page): Details of a trigger row opens "Evaluation details" directly. */
    async openEvaluation(rowIndex: number): Promise<void> {
        expect(this.page.url(), 'openEvaluation is for an object page; the platform page opens a firing dialog first').not.toMatch(/#\/events\/detail\//);
        await this.detailsButton(rowIndex).click();
        await expect(this.evaluationDialog).toBeVisible();
    }

    async closeDialog(dialog: Locator): Promise<void> {
        await dialog.getByRole('button', { name: 'Close' }).last().click();
        await expect(dialog).toHaveCount(0);
    }

    /** In the open firing dialog: the (object, trigger) rows' trigger names. */
    async firingTriggerNames(): Promise<string[]> {
        const rows = this.firingDialog.locator('tbody tr');
        const n = await rows.count();
        const out: string[] = [];
        for (let i = 0; i < n; i++) out.push((await rows.nth(i).locator('td').nth(1).innerText()).trim());
        return out;
    }

    /** Object-history row of a trigger: its Conditions / Actions icons (`true` = met / performed). */
    async objectRowFlags(triggerName: string): Promise<{ conditions: boolean; actions: boolean }> {
        const row = this.rows.filter({ hasText: triggerName }).first();
        await expect(row, `an object history row for ${triggerName}`).toBeVisible();
        const met = async (col: number) => (await row.locator('td').nth(col).locator('svg.lucide-check').count()) > 0;
        return { conditions: await met(2), actions: await met(3) };
    }

    /** In the open evaluation dialog: the value next to a label ("Notification sent" → "Yes" / "No"), or undefined when absent. */
    async evaluationValue(label: string): Promise<string | undefined> {
        const l = this.evaluationDialog.getByText(label, { exact: true });
        if (!(await l.count())) return undefined;
        return (await l.first().locator('xpath=following-sibling::div[1]').innerText()).trim();
    }
}
