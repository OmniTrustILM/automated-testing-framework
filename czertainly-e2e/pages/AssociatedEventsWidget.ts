/**
 * AssociatedEventsWidget — the "Associated Events" widget on the Events tab of an RA profile.
 *
 * Encapsulates:
 *   - the Add / Edit dialog that associates triggers with an event
 *   - the trigger count column and the stored order
 *
 * The UI must keep the order the user picked and offer only the events an RA profile can override. The FE gives the Edit
 * button no accessible name or test id yet, so it is the row's last-cell button.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { chooseOption, chooseOptions, readSelectOptions, selectById } from './ui/select';
import { cellByHeader } from './ui/table';
import { actAndWaitForApi, answerFrom } from './ui/waitForResponse';
import type { ApiAnswer } from '../utils/regression/apiReads';

const logger = new Logger('AssociatedEventsWidget');

export class AssociatedEventsWidget {
    private readonly page: Page;
    readonly widget: Locator;
    /** The Add / Edit dialog "Associate Event Triggers". */
    readonly dialog: Locator;
    private readonly plusButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.widget = page.locator('main section').filter({ has: page.getByRole('heading', { name: 'Associated Events', exact: true }) }).last();
        this.dialog = page.getByRole('dialog', { name: 'Associate Event Triggers' });
        this.plusButton = this.widget.getByTestId('plus-button');
    }

    /** Opens the Events tab of an RA profile and returns its Associated Events widget. */
    static async goToRaProfileEvents(page: Page, authorityUuid: string, raProfileUuid: string): Promise<AssociatedEventsWidget> {
        await page.goto(`/administrator/#/raprofiles/detail/${authorityUuid}/${raProfileUuid}?tab=events`);
        const w = new AssociatedEventsWidget(page);
        await expect(w.widget).toBeVisible();
        return w;
    }

    async openAssociateDialog(): Promise<void> {
        await expect(this.plusButton).toBeEnabled();
        await this.plusButton.click();
        await expect(this.dialog).toBeVisible();
    }

    /** Closes the open dialog with Cancel; nothing is saved. */
    async cancelDialog(): Promise<void> {
        await this.dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(this.dialog, 'the dialog closes without saving').toHaveCount(0);
    }

    /**
     * The event codes the open ADD dialog's Event select offers: the events the object can override that have no trigger yet.
     * Call it before the first association (an associated event leaves the list).
     */
    async offeredEvents(): Promise<string[]> {
        return readSelectOptions(this.page, selectById(this.page, this.dialog, 'event'), { as: 'value' });
    }

    /** Waits until the widget's table has loaded (the busy overlay of the widget is gone). */
    private async waitForTableLoaded(): Promise<void> {
        await expect(this.widget.getByTestId('widget-busy-overlay')).toHaveCount(0);
    }

    private editButton(event: string): Locator {
        // The icon-only Edit button has a `title` but no accessible name (unexpected behaviour): the row's last cell holds the single
        // button.
        return this.row(event).locator('td').last().getByRole('button');
    }

    /** Picks triggers (by name, in order) in the open dialog's trigger picker: each is appended and leaves the options. */
    private async pickTriggers(triggerNames: string[]): Promise<void> {
        const picker = selectById(this.page, this.dialog, 'newRowWidgetSelect');
        for (const name of triggerNames) {
            await expect(picker.trigger, 'the trigger picker has options (the trigger list is loaded)').toBeEnabled();
            // The pick is added at once and leaves the options; the (modal) popover is closed before the next one.
            await chooseOptions(this.page, picker, [name]);
            await expect(this.dialog.locator('tr[data-id]').filter({ hasText: name })).toHaveCount(1);
        }
    }

    /**
     * Associates the triggers (by NAME, in the order they must run) with an event and returns the status of the save. A new
     * event: Add dialog, Event select, one pick per trigger, "Associate". An event that already has triggers: Edit, the picks
     * are APPENDED to the stored list, "Save". The dialog closes on success; the spec asserts the status of the answer.
     */
    async associateTriggers(event: string, triggerNames: string[]): Promise<ApiAnswer> {
        logger.info(`associating ${triggerNames.length} trigger(s) with ${event}`);
        await this.waitForTableLoaded();
        const existing = (await this.row(event).count()) > 0;
        if (existing) {
            await this.editButton(event).click();
            await expect(this.dialog).toBeVisible();
        } else {
            await this.openAssociateDialog();
            await chooseOption(this.page, selectById(this.page, this.dialog, 'event'), { value: event });
        }
        await this.pickTriggers(triggerNames);
        const save = this.dialog.getByTestId('progress-button');
        await expect(save).toBeEnabled();
        const startedAt = Date.now();
        const stored = await actAndWaitForApi(this.page, { method: 'POST', path: '/v1/workflows/events' }, () => save.click());
        if (stored.ok()) await expect(this.dialog).toHaveCount(0);
        return answerFrom(stored, startedAt);
    }

    /** The row of an event in the table: `tr[data-id=<event code>]`. */
    private row(event: string): Locator {
        return this.widget.locator(`tr[data-id="${event}"]`);
    }

    /** The trigger count shown for the event (the "Triggers Count" column, found by its header id). */
    async readTriggerCount(event: string): Promise<number> {
        const cell = await cellByHeader(this.widget, this.row(event), 'triggersCount', 'the associated events table');
        return Number((await cell.innerText()).trim());
    }

    /**
     * The stored order of the triggers of an event, read as the trigger uuids of the edit dialog's table in row order (the UI
     * keeps the order of the stored `triggerUuids`; ignore triggers first). Closes the dialog without saving.
     */
    async readTriggerOrder(event: string): Promise<string[]> {
        await this.waitForTableLoaded();
        const expected = await this.readTriggerCount(event);
        await this.editButton(event).click();
        await expect(this.dialog).toBeVisible();
        // The trigger table is filled by the dialog's own list request: wait for the number of rows the widget's table reported.
        await expect(this.dialog.locator('tr[data-id]'), 'the dialog lists the stored triggers (its list request resolved)').toHaveCount(expected);
        const ids = await this.dialog.locator('tr[data-id]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-id') ?? ''));
        await this.cancelDialog();
        return ids.filter(Boolean);
    }
}
