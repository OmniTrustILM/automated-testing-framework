/**
 * EventsAssociationWidget — the object-level "Associated Events" widget (the `EventsTable` component) on the Events tab of an
 * RA profile (`#/raprofiles/detail/<authority>/<ra profile>?tab=events`) and of a group (`#/groups/detail/<uuid>?tab=events`).
 *
 * Only the OBJECT-level mode is driven here: the platform page (`#/events`) replaces the platform-wide list for every user and
 * is reachable by `@local` specs only (phase-05 B4: `EventsAssociationWidget.platform`), not implemented in this class.
 *
 * Flow (fe-administrator `EventsTable`, read in the source): the widget's `plus-button` opens the dialog "Associate Event
 * Triggers"; the Event select `select-event-trigger` offers the events the object can override (option `data-value` = the event
 * code), the read-only Resource select follows; the trigger picker (`select-newRowWidgetSelect-trigger`, multi, immediate add)
 * APPENDS each chosen trigger to the list and removes it from the options, so the order of the clicks is the stored order
 * (ignore triggers are sorted first by the platform); the footer's `progress-button` "Associate" saves (a full REPLACE of the
 * list, `POST /v1/workflows/events`). The table rows are `tr[data-id=<event code>]` with the trigger COUNT in the third cell;
 * the stored order is read by opening the row's Edit button (title "Edit", icon only) and reading the trigger rows
 * `tr[data-id=<trigger uuid>]` of the dialog in order.
 *
 * Source facts (fe-administrator origin/main): an event that already has triggers is NOT offered by the Add dialog's Event select
 * (`EventsTable/index.tsx` `eventOptions` filters used events unless it is the edited one), so a second association on the same event goes
 * through Edit (`associate` does that on its own; the dialog's Event select is disabled there and its footer button reads "Save", not
 * "Associate"). The trigger table of the dialog is filled by the `listTriggers` request the widget mounts with, so it is empty for a moment
 * after the dialog opens: reads wait for the row count the table reports. Inside the dialog every Select opens a MODAL popover
 * (`Select/index.tsx:194-198`): a popover is closed with Escape, never with a click on the heading or the trigger.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';

const logger = new Logger('EventsAssociationWidget');

export class EventsAssociationWidget {
    readonly page: Page;
    readonly widget: Locator;

    constructor(page: Page) {
        this.page = page;
        this.widget = page.locator('main section').filter({ has: page.getByRole('heading', { name: 'Associated Events', exact: true }) }).last();
    }

    static async openRaProfile(page: Page, authorityUuid: string, raProfileUuid: string): Promise<EventsAssociationWidget> {
        await page.goto(`/administrator/#/raprofiles/detail/${authorityUuid}/${raProfileUuid}?tab=events`);
        const w = new EventsAssociationWidget(page);
        await expect(w.widget).toBeVisible();
        return w;
    }

    static async openGroup(page: Page, groupUuid: string): Promise<EventsAssociationWidget> {
        await page.goto(`/administrator/#/groups/detail/${groupUuid}?tab=events`);
        const w = new EventsAssociationWidget(page);
        await expect(w.widget).toBeVisible();
        return w;
    }

    get dialog(): Locator {
        return this.page.getByRole('dialog', { name: 'Associate Event Triggers' });
    }

    private get plusButton(): Locator {
        return this.widget.getByTestId('plus-button');
    }

    async openAssociateDialog(): Promise<void> {
        await expect(this.plusButton).toBeEnabled();
        await this.plusButton.click();
        await expect(this.dialog).toBeVisible();
    }

    /**
     * The event codes the open ADD dialog's Event select offers: the events the object can override (T14 W1) that have no trigger yet.
     * Call it before the first association (an associated event leaves the list).
     */
    async eventsOffered(): Promise<string[]> {
        const trigger = this.dialog.getByTestId('select-event-trigger');
        await trigger.click();
        const content = this.page.getByTestId('select-event-content');
        const options = content.getByRole('option');
        await expect(options.first()).toBeVisible();
        const values = await options.evaluateAll((els) => els.map((e) => e.getAttribute('data-value') ?? ''));
        await this.page.keyboard.press('Escape');
        await expect(content).toBeHidden();
        return values.filter(Boolean);
    }

    /** Waits until the widget's table has loaded (the busy overlay of the widget is gone). */
    private async settled(): Promise<void> {
        await expect(this.widget.getByTestId('widget-busy-overlay')).toHaveCount(0);
    }

    private editButton(event: string): Locator {
        // The icon-only Edit button has a `title` but no accessible name (suspected defect): the row's last cell holds the single button.
        return this.row(event).locator('td').last().getByRole('button');
    }

    /** Picks triggers (by name, in order) in the open dialog's trigger picker: each is appended and leaves the options. */
    private async pickTriggers(event: string, triggerNames: string[]): Promise<void> {
        const picker = this.dialog.getByTestId('select-newRowWidgetSelect-trigger');
        const content = this.page.getByTestId('select-newRowWidgetSelect-content');
        for (const name of triggerNames) {
            await expect(picker, 'the trigger picker has options (the trigger list is loaded)').toBeEnabled();
            await picker.click();
            const option = content.getByRole('option', { name, exact: true });
            await expect(option, `trigger ${name} is offered for ${event}`).toBeVisible();
            await option.click();
            // The pick is added at once and leaves the options; Escape closes the (modal) popover before the next one.
            await this.page.keyboard.press('Escape');
            await expect(content).toBeHidden();
            await expect(this.dialog.locator('tr[data-id]').filter({ hasText: name })).toHaveCount(1);
        }
    }

    /**
     * Associates the triggers (by NAME, in the order they must run) with an event. A new event: Add dialog, Event select, one pick per
     * trigger (each is appended), "Associate". An event that already has triggers: Edit, the picks are APPENDED to the stored list (the
     * platform sorts ignore triggers first), "Save". Returns once the dialog closed.
     */
    async associate(event: string, triggerNames: string[]): Promise<void> {
        logger.info(`associating ${triggerNames.length} trigger(s) with ${event}`);
        await this.settled();
        const existing = (await this.row(event).count()) > 0;
        if (existing) {
            await this.editButton(event).click();
            await expect(this.dialog).toBeVisible();
        } else {
            await this.openAssociateDialog();
            await this.dialog.getByTestId('select-event-trigger').click();
            await this.page.getByTestId('select-event-content').locator(`[role=option][data-value="${event}"]`).click();
        }
        await this.pickTriggers(event, triggerNames);
        const save = this.dialog.getByTestId('progress-button');
        await expect(save).toBeEnabled();
        const stored = this.page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/v1/workflows/events'));
        await save.click();
        expect((await stored).ok(), 'the association was stored').toBe(true);
        await expect(this.dialog).toHaveCount(0);
    }

    /** The row of an event in the table: `tr[data-id=<event code>]`. */
    row(event: string): Locator {
        return this.widget.locator(`tr[data-id="${event}"]`);
    }

    /** The trigger count shown for the event (third cell). */
    async count(event: string): Promise<number> {
        return Number((await this.row(event).locator('td').nth(2).innerText()).trim());
    }

    /**
     * The stored order of the triggers of an event, read as the trigger uuids of the edit dialog's table in row order (the UI
     * keeps the order of the stored `triggerUuids`; ignore triggers first). Closes the dialog without saving.
     */
    async readOrder(event: string): Promise<string[]> {
        await this.settled();
        const expected = await this.count(event);
        await this.editButton(event).click();
        await expect(this.dialog).toBeVisible();
        // The trigger table is filled by the dialog's own list request: wait for the number of rows the widget's table reported.
        await expect(this.dialog.locator('tr[data-id]'), 'the dialog lists the stored triggers (its list request resolved)').toHaveCount(expected);
        const ids = await this.dialog.locator('tr[data-id]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-id') ?? ''));
        await this.dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(this.dialog).toHaveCount(0);
        return ids.filter(Boolean);
    }

    /** `assertAssociation(event, uuids)`: the table lists the event with that many triggers, in that order. */
    async assertAssociation(event: string, triggerUuids: string[]): Promise<void> {
        await expect(this.row(event)).toBeVisible();
        expect(await this.count(event)).toBe(triggerUuids.length);
        expect(await this.readOrder(event)).toEqual(triggerUuids);
    }
}
