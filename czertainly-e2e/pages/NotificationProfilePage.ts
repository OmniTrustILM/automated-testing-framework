/**
 * NotificationProfilePage — the notification profiles list, the Create Notification Profile dialog and the profile detail.
 * WHAT: creates a profile with a user recipient, frequency and repetitions, and reads the detail table back.
 * WHY: Epic ilm#369 (repeated notifications) adds Frequency and Repetitions to the profile; the UI must save and show them.
 * HOW: locators were checked on the live UI; the switch input is sr-only, so the switch is toggled through its label,
 *      and the Repetitions input is readonly until focused (knowledge/automation/fe-playwright-patterns.md).
 */
import { expect, Locator, Page } from '@playwright/test';

export interface CreateProfileOptions {
    name: string;
    /** Name of the registered user who receives the notifications. */
    recipientUser: string;
    internal: boolean;
    /** The frequency as the form takes it, e.g. `1h`. */
    frequency?: string;
    repetitions?: number;
}

export class NotificationProfilePage {
    readonly page: Page;
    readonly main: Locator;
    readonly addButton: Locator;
    readonly dialog: Locator;
    readonly nameInput: Locator;
    readonly recipientTypeTrigger: Locator;
    readonly recipientsTrigger: Locator;
    readonly internalSwitchLabel: Locator;
    readonly internalSwitchInput: Locator;
    readonly frequencyInput: Locator;
    readonly repetitionsInput: Locator;
    readonly createButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.addButton = this.main.getByTestId('plus-button').first();
        this.dialog = page.getByRole('dialog', { name: 'Create Notification Profile' });
        this.nameInput = this.dialog.getByTestId('text-input-name');
        this.recipientTypeTrigger = this.dialog.getByTestId('select-recipientType-trigger');
        this.recipientsTrigger = this.dialog.getByTestId('select-recipients-trigger');
        // Two labels carry this test id: the text and the visible switch. The switch is the second.
        this.internalSwitchLabel = this.dialog.getByTestId('label-internalNotification').nth(1);
        this.internalSwitchInput = this.dialog.getByTestId('switch-internalNotification-input');
        this.frequencyInput = this.dialog.getByTestId('text-input-frequency');
        this.repetitionsInput = this.dialog.getByTestId('text-input-repetitions');
        this.createButton = this.dialog.getByRole('button', { name: 'Create', exact: true });
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/notificationprofiles');
        await expect(this.main.getByRole('heading', { name: 'List of Notification Profiles' })).toBeVisible();
    }

    /** Fills and submits the dialog; returns the uuid from the create answer once the detail route is open. */
    async create(opts: CreateProfileOptions): Promise<string> {
        await this.addButton.click();
        await expect(this.dialog).toBeVisible();
        await this.nameInput.click();
        await this.nameInput.fill(opts.name);

        await this.recipientTypeTrigger.click();
        await this.page.getByRole('option', { name: /^User/ }).click();
        await this.recipientsTrigger.click();
        await this.page.getByRole('option', { name: opts.recipientUser, exact: true }).click();
        await this.page.keyboard.press('Escape'); // the multi-select stays open

        if (opts.internal !== (await this.internalSwitchInput.isChecked())) {
            await this.internalSwitchLabel.click();
        }
        await expect(this.internalSwitchInput).toBeChecked({ checked: opts.internal });

        if (opts.frequency !== undefined) {
            await this.frequencyInput.click();
            await this.frequencyInput.fill(opts.frequency);
        }
        if (opts.repetitions !== undefined) {
            await this.repetitionsInput.click();
            await this.repetitionsInput.fill(String(opts.repetitions));
        }

        const [answer] = await Promise.all([
            this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/v1\/notificationProfiles$/.test(r.url())),
            this.createButton.click(),
        ]);
        expect(answer.status(), 'the create answer').toBe(201);
        const uuid = String((await answer.json()).uuid);
        await expect(this.page).toHaveURL(new RegExp(`/notificationprofiles/detail/${uuid}`));
        return uuid;
    }

    /** The value cell next to a property name of the detail table. */
    detailValue(property: string): Locator {
        return this.main
            .getByRole('row')
            .filter({ has: this.page.getByRole('cell', { name: property, exact: true }) })
            .getByRole('cell')
            .nth(1);
    }
}
