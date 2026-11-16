/**
 * AssociatedEventsWidget — the Associated Events widget on an RA profile's Events tab and its Associate Event Triggers dialog (REG-WFL-04).
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import type { ApiAnswer } from '../utils/regression/apiReads';
import type { OwnRef } from '../utils/regression/ledger/ledger';
import type { OwnRaProfile } from '../utils/regression/ownRaProfiles';
import { chooseOption, chooseOptions, readSelectOptions, selectById, SelectHandle } from './ui/select';
import { cellByHeader } from './ui/table';
import { actAndWaitForApi, answerFrom } from './ui/waitForResponse';
import { widgetTitled } from './ui/widget';

const logger = new Logger('AssociatedEventsWidget');

export class AssociatedEventsWidget {
    readonly page: Page;

    // Associated Events widget
    readonly widget: Locator;
    readonly addButton: Locator;
    readonly busyOverlay: Locator;

    // Associate Event Triggers dialog
    readonly dialog: Locator;
    readonly eventSelect: SelectHandle;
    readonly triggerPicker: SelectHandle;
    readonly triggerRows: Locator;
    readonly saveButton: Locator;
    readonly cancelButton: Locator;

    constructor(page: Page) {
        this.page = page;

        this.widget = widgetTitled(page.locator('main'), 'Associated Events');
        this.addButton = this.widget.getByTestId('plus-button');
        this.busyOverlay = this.widget.getByTestId('widget-busy-overlay');

        this.dialog = page.getByRole('dialog', { name: 'Associate Event Triggers' });
        this.eventSelect = selectById(page, this.dialog, 'event');
        this.triggerPicker = selectById(page, this.dialog, 'newRowWidgetSelect');
        this.triggerRows = this.dialog.locator('tr[data-id]');
        this.saveButton = this.dialog.getByTestId('progress-button');
        this.cancelButton = this.dialog.getByRole('button', { name: 'Cancel' });
    }

    /** The row of an event: `tr[data-id=<event code>]`. */
    private eventRow(event: string): Locator {
        return this.widget.locator(`tr[data-id="${event}"]`);
    }

    /** The icon-only Edit button has a `title` but no accessible name: the row's last cell holds the single button. */
    private editButton(event: string): Locator {
        return this.eventRow(event).locator('td').last().getByRole('button');
    }

    private triggerRow(triggerName: string): Locator {
        return this.triggerRows.filter({ hasText: triggerName });
    }

    /** Only the run's own RA profile: the widget changes its associations. */
    async goToRaProfileEvents(ra: OwnRaProfile): Promise<void> {
        await this.page.goto(`/administrator/#/raprofiles/detail/${ra.authorityUuid}/${ra.uuid}?tab=events`);
        await expect(this.widget).toBeVisible();
    }

    async openAssociateDialog(): Promise<void> {
        await expect(this.addButton).toBeEnabled();
        await this.addButton.click();
        await expect(this.dialog).toBeVisible();
    }

    async cancelDialog(): Promise<void> {
        await this.cancelButton.click();
        await expect(this.dialog, 'the dialog closes without saving').toHaveCount(0);
    }

    /** The event codes the open Add dialog offers: the events the object can override that have no trigger yet. */
    async offeredEvents(): Promise<string[]> {
        return readSelectOptions(this.page, this.eventSelect, { as: 'value' });
    }

    /** Add, Event, one pick per own trigger (by name, in run order), Associate; returns the save's answer, unasserted. A new event only. */
    async associateTriggers(event: string, triggers: OwnRef[]): Promise<ApiAnswer> {
        logger.info(`associating ${triggers.length} trigger(s) with ${event}`);
        await expect(this.busyOverlay).toHaveCount(0);
        await expect(this.eventRow(event), `${event} has no association yet`).toHaveCount(0);
        await this.openAssociateDialog();
        await chooseOption(this.page, this.eventSelect, { value: event });
        for (const { name } of triggers) {
            await expect(this.triggerPicker.trigger, 'the trigger picker has options (the trigger list is loaded)').toBeEnabled();
            // The pick is added at once and leaves the options; the (modal) popover is closed before the next one.
            await chooseOptions(this.page, this.triggerPicker, [name]);
            await expect(this.triggerRow(name)).toHaveCount(1);
        }
        await expect(this.saveButton).toBeEnabled();
        const startedAt = Date.now();
        const stored = await actAndWaitForApi(this.page, { method: 'POST', path: '/v1/workflows/events' }, () => this.saveButton.click());
        if (stored.ok()) await expect(this.dialog).toHaveCount(0);
        return answerFrom(stored, startedAt);
    }

    /** The "Triggers Count" column, found by its header id. */
    async readTriggerCount(event: string): Promise<number> {
        const cell = await cellByHeader(this.widget, this.eventRow(event), 'triggersCount', 'the associated events table');
        return Number((await cell.innerText()).trim());
    }

    /** The stored order: the trigger uuids of the Edit dialog's table in row order. Closes the dialog without saving. */
    async readTriggerOrder(event: string): Promise<string[]> {
        await expect(this.busyOverlay).toHaveCount(0);
        const expected = await this.readTriggerCount(event);
        await this.editButton(event).click();
        await expect(this.dialog).toBeVisible();
        // The dialog's own list request fills the table: wait for the number of rows the widget reported.
        await expect(this.triggerRows, 'the dialog lists the stored triggers (its list request resolved)').toHaveCount(expected);
        const ids = await this.triggerRows.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-id') ?? ''));
        await this.cancelDialog();
        return ids.filter(Boolean);
    }
}
