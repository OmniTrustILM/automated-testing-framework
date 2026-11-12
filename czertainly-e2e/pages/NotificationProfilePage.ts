/**
 * NotificationProfilePage — the notification profiles.
 *
 * WHAT: the notification profile list, its create dialog (recipient type and recipients, instance, internal switch, event data categories,
 *       frequency, repetitions) and the versioned profile detail.
 * WHY: a profile form must store what was typed, so request, stored object and detail are compared; the detail prints categories as labels,
 *      which the spec maps from codes.
 * HOW: selects through the helper; the switches are hidden inputs under their label (the label is clicked); `submitCreateForm` returns the
 *      answer of the create request and `waitForDetailRoute` reads the uuid from the route the UI opens afterwards; the detail widget is
 *      found by its heading, because its row ids collide with the instance table below it.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate, waitForDetailRoute } from './ui/detailRoute';
import { fillText, setSwitch, submitButtonOf } from './ui/form';
import { chooseOption, chooseOptions, selectById } from './ui/select';

const logger = new Logger('NotificationProfilePage');

export type RecipientType = 'none' | 'default' | 'user' | 'group' | 'role' | 'owner' | 'object';

export interface ProfileForm {
    name: string;
    description?: string;
    recipientType: RecipientType;
    /** Recipients by name (user / group / role only). */
    recipients?: string[];
    /** The instance by name. */
    instance?: string;
    internal?: boolean;
    /** Event data category codes (`eventDataCategory-<code>-input`). */
    categories?: string[];
    frequency?: string;
    repetitions?: number;
}

export class NotificationProfilePage {
    private readonly page: Page;
    readonly main: Locator;
    /** The create dialog, by its accessible name. */
    readonly createDialog: Locator;
    /** The "Notification Profile Details" widget (its row ids collide with the instance table below it). */
    readonly detailWidget: Locator;
    /** The "Notification Instance Details" widget shown under the profile details. */
    private readonly instanceDetailWidget: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.createDialog = page.getByRole('dialog', { name: 'Create Notification Profile' });
        this.detailWidget = this.main.locator('section').filter({ has: page.getByRole('heading', { name: 'Notification Profile Details', exact: true }) }).last();
        this.instanceDetailWidget = this.main.locator('section').filter({ has: page.getByRole('heading', { name: 'Notification Instance Details', exact: true }) }).last();
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/notificationprofiles');
        await expect(this.main.getByTestId('plus-button')).toBeVisible();
    }

    async openCreateDialog(): Promise<void> {
        await this.main.getByTestId('plus-button').click();
        await expect(this.createDialog).toBeVisible();
    }

    /**
     * Fills the open create dialog. The Internal switch and the category switches are hidden inputs under a label: each
     * is clicked through its label.
     */
    async fillCreateForm(o: ProfileForm): Promise<void> {
        const dialog = this.createDialog;
        await fillText(dialog.getByTestId('text-input-name'), o.name);
        if (o.description) await fillText(dialog.locator('#description'), o.description);
        await chooseOption(this.page, selectById(this.page, dialog, 'recipientType'), { value: o.recipientType });
        if (o.recipients?.length) await chooseOptions(this.page, selectById(this.page, dialog, 'recipients'), o.recipients);
        if (o.instance) await chooseOption(this.page, selectById(this.page, dialog, 'notificationInstance'), o.instance);
        if (o.internal) await setSwitch(dialog, 'internalNotification', true);
        for (const c of o.categories ?? []) await setSwitch(dialog, dialog.getByTestId(`eventDataCategory-${c}-input`), true);
        if (o.frequency) await fillText(dialog.getByTestId('text-input-frequency'), o.frequency);
        if (o.repetitions !== undefined) await fillText(dialog.getByTestId('text-input-repetitions'), String(o.repetitions));
    }

    /**
     * Clicks Create and returns the answer of the create request: status, the new uuid, the request it sent. It does not wait
     * for the redirect: record the uuid first, then `waitForDetailRoute()`.
     */
    async submitCreateForm(): Promise<CreateAnswer> {
        const submit = submitButtonOf(this.createDialog);
        await expect(submit, 'Create is enabled once the form is valid').toBeEnabled();
        return submitCreate(this.page, this.createDialog, { endpoint: '/v1/notificationProfiles' });
    }

    /** Waits for the redirect to the new profile's detail page (`…/detail/<uuid>/<version>`) and returns its uuid. */
    async waitForDetailRoute(): Promise<string> {
        return waitForDetailRoute(this.page, 'notificationprofiles', { version: true });
    }

    /** List → Create → fill → submit; returns the create answer (see `submitCreateForm`). */
    async createProfile(o: ProfileForm): Promise<CreateAnswer> {
        logger.info(`creating the ${o.recipientType} notification profile through the form`);
        await this.goToList();
        await this.openCreateDialog();
        await this.fillCreateForm(o);
        return this.submitCreateForm();
    }

    /** The detail page of a version; waits until the table shows THIS uuid (the previous route's table lingers otherwise). */
    async goToDetail(uuid: string, version = 1): Promise<void> {
        await this.page.goto(`/administrator/#/notificationprofiles/detail/${uuid}/${version}`);
        await expect(this.detailWidget.locator('tr[data-id="uuid"] td').nth(1)).toHaveText(uuid);
    }

    /** The open detail page shows the profile as expected; `categoryLabels` are the badge texts (labels, not codes). */
    async assertDetail(expected: { name: string; version?: number; internal: boolean; recipientType: string; categoryLabels?: string[]; frequency?: string; repetitions?: number; instanceName?: string }): Promise<void> {
        const widget = this.detailWidget;
        const cell = async (row: string) => (await widget.locator(`tr[data-id="${row}"] td`).nth(1).innerText()).replace(/\s+/g, ' ').trim();
        expect(await cell('name'), 'the detail shows the profile name').toBe(expected.name);
        expect(await cell('version'), 'the detail shows the profile version').toBe(String(expected.version ?? 1));
        expect(await cell('recipientType'), 'the detail shows the recipient type').toMatch(new RegExp(expected.recipientType, 'i'));
        expect(await cell('internalNotification'), 'the detail shows the internal switch').toBe(expected.internal ? 'Yes' : 'No');
        if (expected.categoryLabels) {
            const tags = await widget.getByTestId('eventDataCategories-tags').getByTestId('badge').allInnerTexts();
            expect(tags.map((t) => t.trim()).sort(), 'the detail lists the event data categories as labels').toEqual([...expected.categoryLabels].sort());
        }
        if (expected.frequency) expect(await cell('frequency'), 'the detail shows the frequency').toBe(expected.frequency);
        if (expected.repetitions !== undefined) expect(await cell('repetitions'), 'the detail shows the repetitions').toBe(String(expected.repetitions));
        if (expected.instanceName) {
            expect((await this.instanceDetailWidget.locator('tr[data-id="name"] td').nth(1).innerText()).trim(), 'the detail names the notification instance').toBe(expected.instanceName);
        }
    }
}
