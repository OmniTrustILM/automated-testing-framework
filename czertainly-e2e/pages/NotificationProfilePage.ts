/**
 * NotificationProfilePage — the notification profiles list, the Create Notification Profile dialog and the profile detail.
 * The detail rows are read inside their widget: a profile with an instance shows the instance table below, with rows of the same names.
 */
import { expect, Locator, Page } from '@playwright/test';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate, waitForDetailRoute } from './ui/detailRoute';
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
    /** Event data category codes. */
    categories?: string[];
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
    readonly descriptionInput: Locator;
    readonly recipientTypeTrigger: Locator;
    readonly recipientsTrigger: Locator;
    readonly notificationInstanceTrigger: Locator;
    readonly internalNotificationSwitch: Locator;
    readonly frequencyInput: Locator;
    readonly repetitionsInput: Locator;
    readonly createButton: Locator;

    // Notification Profile Details
    readonly profileDetails: Locator;
    readonly categoryBadges: Locator;

    // Notification Instance Details
    readonly instanceDetails: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.profilesList = widgetTitled(this.main, 'List of Notification Profiles');
        this.addProfileButton = this.profilesList.getByTestId('plus-button');

        this.createProfileDialog = page.getByRole('dialog', { name: 'Create Notification Profile' });
        this.nameInput = this.createProfileDialog.getByTestId('text-input-name');
        this.descriptionInput = this.createProfileDialog.locator('#description');
        this.recipientTypeTrigger = this.createProfileDialog.getByTestId('select-recipientType-trigger');
        this.recipientsTrigger = this.createProfileDialog.getByTestId('select-recipients-trigger');
        this.notificationInstanceTrigger = this.createProfileDialog.getByTestId('select-notificationInstance-trigger');
        this.internalNotificationSwitch = this.createProfileDialog.getByTestId('switch-internalNotification-input');
        this.frequencyInput = this.createProfileDialog.getByTestId('text-input-frequency');
        this.repetitionsInput = this.createProfileDialog.getByTestId('text-input-repetitions');
        this.createButton = this.createProfileDialog.getByRole('button', { name: 'Create', exact: true });

        this.profileDetails = widgetTitled(this.main, 'Notification Profile Details');
        this.categoryBadges = this.profileDetails.getByTestId('eventDataCategories-tags').getByTestId('badge');

        this.instanceDetails = widgetTitled(this.main, 'Notification Instance Details');
    }

    private categorySwitch(code: string): Locator {
        return this.createProfileDialog.getByTestId(`eventDataCategory-${code}-input`);
    }

    /** The value cell next to a property name in the profile detail table. */
    detailValue(property: string): Locator {
        return valueCell(this.page, this.profileDetails, property);
    }

    /** The value cell next to a property name in the instance detail table. */
    private instanceDetailValue(property: string): Locator {
        return valueCell(this.page, this.instanceDetails, property);
    }

    async goToList(): Promise<void> {
        await openHashRoute(this.page, 'notificationprofiles');
        await expect(this.profilesList).toBeVisible();
    }

    /** Fills and submits the dialog for one user recipient; the redirect to the detail is not waited for. */
    async create(opts: CreateProfileOptions): Promise<CreateAnswer> {
        return this.createProfile({
            name: opts.name, recipientType: 'user', recipients: [opts.recipientUser], internal: opts.internal, frequency: opts.frequency, repetitions: opts.repetitions,
        });
    }

    /** From the list: fills and submits the dialog; the redirect is not waited for, so the uuid can be recorded first. */
    async createProfile(form: ProfileForm): Promise<CreateAnswer> {
        await this.addProfileButton.click();
        await expect(this.createProfileDialog).toBeVisible();
        await fillText(this.nameInput, form.name);
        if (form.description) await fillText(this.descriptionInput, form.description);
        await chooseOption(this.page, this.recipientTypeTrigger, { value: form.recipientType });
        if (form.recipients?.length) await chooseOptions(this.page, this.recipientsTrigger, form.recipients);
        if (form.instance) await chooseOption(this.page, this.notificationInstanceTrigger, form.instance);
        await setSwitch(this.createProfileDialog, this.internalNotificationSwitch, form.internal ?? false);
        for (const code of form.categories ?? []) await setSwitch(this.createProfileDialog, this.categorySwitch(code), true);
        if (form.frequency !== undefined) await fillText(this.frequencyInput, form.frequency);
        if (form.repetitions !== undefined) await fillText(this.repetitionsInput, String(form.repetitions));
        await expect(this.createButton, 'Create is enabled once the form is valid').toBeEnabled();
        return submitCreate(this.page, this.createButton, { endpoint: '/api/v1/notificationProfiles' });
    }

    /** The route is `…/detail/<uuid>/<version>`. */
    async waitForDetailRoute(): Promise<string> {
        return waitForDetailRoute(this.page, 'notificationprofiles', { version: true });
    }

    /** Waits until the table shows THIS uuid (the previous route's table lingers otherwise). */
    async goToDetail(uuid: string, version = 1): Promise<void> {
        await openHashRoute(this.page, `notificationprofiles/detail/${uuid}/${version}`);
        await expect(this.detailValue('UUID')).toHaveText(uuid);
    }

    /** `categoryLabels` are the badge texts (labels, not codes). */
    async assertDetail(expected: {
        name: string;
        version?: number;
        internal: boolean;
        recipientType: string;
        categoryLabels?: string[];
        frequency?: string;
        repetitions?: number;
        instanceName?: string;
    }): Promise<void> {
        const cell = async (property: string) => (await this.detailValue(property).innerText()).replace(/\s+/g, ' ').trim();
        expect(await cell('Name'), 'the detail shows the profile name').toBe(expected.name);
        expect(await cell('Profile Version'), 'the detail shows the profile version').toBe(String(expected.version ?? 1));
        expect(await cell('Recipient Type'), 'the detail shows the recipient type').toMatch(new RegExp(expected.recipientType, 'i'));
        expect(await cell('Internal Notification'), 'the detail shows the internal switch').toBe(expected.internal ? 'Yes' : 'No');
        if (expected.categoryLabels) {
            const tags = await this.categoryBadges.allInnerTexts();
            expect(tags.map((t) => t.trim()).sort(), 'the detail lists the event data categories as labels').toEqual([...expected.categoryLabels].sort());
        }
        if (expected.frequency) expect(await cell('Frequency'), 'the detail shows the frequency').toBe(expected.frequency);
        if (expected.repetitions !== undefined) expect(await cell('Max Repetitions'), 'the detail shows the repetitions').toBe(String(expected.repetitions));
        if (expected.instanceName) {
            expect((await this.instanceDetailValue('Name').innerText()).trim(), 'the detail names the notification instance').toBe(expected.instanceName);
        }
    }
}

const valueCell = (page: Page, table: Locator, property: string): Locator =>
    table.getByRole('row').filter({ has: page.getByRole('cell', { name: property, exact: true }) }).getByRole('cell').nth(1);
