/**
 * NotificationProfilePage — the notification profiles list, the Create Notification Profile dialog and the profile detail.
 */
import { expect, Locator, Page } from '@playwright/test';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { fillText, setSwitch } from './ui/form';
import { openHashRoute } from './ui/openHashRoute';
import { chooseOption, chooseOptions } from './ui/select';
import { widgetTitled } from './ui/widget';

export interface CreateProfileOptions {
    name: string;
    /** Name of the registered user who receives the notifications. */
    recipientUser: string;
    internal: boolean;
    /** As the form takes it, e.g. `1h`. */
    frequency?: string;
    repetitions?: number;
}

export class NotificationProfilePage {
    readonly page: Page;
    readonly main: Locator;

    // List of Notification Profiles
    readonly profilesList: Locator;
    readonly addProfileButton: Locator;

    // Create Notification Profile dialog
    readonly createProfileDialog: Locator;
    readonly nameInput: Locator;
    readonly recipientTypeTrigger: Locator;
    readonly recipientsTrigger: Locator;
    readonly internalNotificationSwitch: Locator;
    readonly frequencyInput: Locator;
    readonly repetitionsInput: Locator;
    readonly createButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.profilesList = widgetTitled(this.main, 'List of Notification Profiles');
        this.addProfileButton = this.profilesList.getByTestId('plus-button');

        this.createProfileDialog = page.getByRole('dialog', { name: 'Create Notification Profile' });
        this.nameInput = this.createProfileDialog.getByTestId('text-input-name');
        this.recipientTypeTrigger = this.createProfileDialog.getByTestId('select-recipientType-trigger');
        this.recipientsTrigger = this.createProfileDialog.getByTestId('select-recipients-trigger');
        this.internalNotificationSwitch = this.createProfileDialog.getByTestId('switch-internalNotification-input');
        this.frequencyInput = this.createProfileDialog.getByTestId('text-input-frequency');
        this.repetitionsInput = this.createProfileDialog.getByTestId('text-input-repetitions');
        this.createButton = this.createProfileDialog.getByRole('button', { name: 'Create', exact: true });
    }

    /** The value cell next to a property name in the detail table. */
    detailValue(property: string): Locator {
        return this.main.getByRole('row').filter({ has: this.page.getByRole('cell', { name: property, exact: true }) }).getByRole('cell').nth(1);
    }

    async goToList(): Promise<void> {
        await openHashRoute(this.page, 'notificationprofiles');
        await expect(this.profilesList).toBeVisible();
    }

    /** Fills and submits the dialog and returns the create answer; the redirect to the detail is not waited for. */
    async create(opts: CreateProfileOptions): Promise<CreateAnswer> {
        await this.addProfileButton.click();
        await expect(this.createProfileDialog).toBeVisible();
        await fillText(this.nameInput, opts.name);
        await chooseOption(this.page, this.recipientTypeTrigger, /^User/);
        await chooseOptions(this.page, this.recipientsTrigger, [opts.recipientUser]);
        await setSwitch(this.createProfileDialog, this.internalNotificationSwitch, opts.internal);
        if (opts.frequency !== undefined) await fillText(this.frequencyInput, opts.frequency);
        if (opts.repetitions !== undefined) await fillText(this.repetitionsInput, String(opts.repetitions));
        return submitCreate(this.page, this.createButton, { endpoint: '/api/v1/notificationProfiles' });
    }
}
