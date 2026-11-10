/**
 * GroupPage — the groups list, Create Group dialog and group detail tabs (REG-CFG-06).
 * A tab that failed to load shows the platform's error text, which `assertNoErrorShown` looks for.
 */
import { expect, Locator, Page } from '@playwright/test';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { cancelIfOpen, customAttributesDefined, fillRequiredCustomAttributes, fillText } from './ui/form';
import { dismissToasts, toast } from './ui/toast';

export type GroupTab = 'Users' | 'Events' | 'Event History';

export interface GroupFields {
    name: string;
    description: string;
    email: string;
}

const ERROR_TEXT = /unexpected error|internal server error/i;

export class GroupPage {
    readonly page: Page;
    readonly main: Locator;

    // Groups list
    readonly addGroupButton: Locator;

    // Create Group dialog
    readonly createGroupDialog: Locator;
    readonly nameInput: Locator;
    readonly descriptionInput: Locator;
    readonly emailInput: Locator;
    readonly createButton: Locator;
    readonly cancelButton: Locator;

    // Toasts
    readonly nameExistsToast: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.addGroupButton = this.main.getByTestId('plus-button').first();

        this.createGroupDialog = page.getByRole('dialog', { name: 'Create Group' });
        this.nameInput = this.createGroupDialog.getByTestId('text-input-name');
        this.descriptionInput = this.createGroupDialog.getByTestId('text-input-description');
        this.emailInput = this.createGroupDialog.getByTestId('text-input-email');
        this.createButton = this.createGroupDialog.getByTestId('progress-button').last();
        this.cancelButton = this.createGroupDialog.getByRole('button', { name: 'Cancel', exact: true });

        this.nameExistsToast = toast(page, /already exist/i);
    }

    tab(name: GroupTab): Locator {
        return this.main.getByRole('tab', { name, exact: true });
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/groups');
        await expect(this.main).toBeVisible();
    }

    async goToDetail(uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/groups/detail/${uuid}`);
        await expect(this.main).toBeVisible();
    }

    async openCreateDialog(): Promise<void> {
        await this.addGroupButton.click();
        await expect(this.createGroupDialog).toBeVisible();
    }

    async fillCreateForm(fields: GroupFields): Promise<void> {
        await fillText(this.nameInput, fields.name);
        await fillText(this.descriptionInput, fields.description);
        await fillText(this.emailInput, fields.email);
        await fillRequiredCustomAttributes(this.page, this.createGroupDialog, 'qa-reg', await customAttributesDefined(this.page, 'groups'));
    }

    /** Clicks Create and returns the create answer; the dialog is not waited for. */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createButton, { endpoint: '/api/v1/groups' });
    }

    async assertDetailShows(name: string): Promise<void> {
        await expect(this.main).toContainText(name);
    }

    async openTab(name: GroupTab): Promise<void> {
        await this.tab(name).click();
    }

    /** The page shows no error text; it never clicks a tab. */
    async assertNoErrorShown(tab: GroupTab): Promise<void> {
        await expect(this.main, `the ${tab} tab shows no error`).not.toContainText(ERROR_TEXT);
    }

    async assertDuplicateNameRefused(): Promise<void> {
        await expect(this.nameExistsToast).toBeVisible();
    }

    async closeCreateDialog(): Promise<void> {
        await dismissToasts(this.page);
        await cancelIfOpen(this.createGroupDialog, this.cancelButton);
    }
}
