/**
 * GroupPage — Page Object Model for certificate groups (REG-CFG-06).
 *
 * Encapsulates:
 *   - the Groups list and the Create Group dialog
 *   - the group detail with its Users, Events and Event History tabs
 *
 * The create answer goes back to the spec before the dialog closes, so the group is on the ledger first. A tab that
 * failed to load shows the platform's error text, which `assertNoErrorShown` looks for.
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

/** The text a tab shows when the page failed to load it. */
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

        // Groups list
        this.addGroupButton = this.main.getByTestId('plus-button').first();

        // Create Group dialog
        this.createGroupDialog = page.getByRole('dialog', { name: 'Create Group' });
        this.nameInput = this.createGroupDialog.getByTestId('text-input-name');
        this.descriptionInput = this.createGroupDialog.getByTestId('text-input-description');
        this.emailInput = this.createGroupDialog.getByTestId('text-input-email');
        this.createButton = this.createGroupDialog.getByTestId('progress-button').last();
        this.cancelButton = this.createGroupDialog.getByRole('button', { name: 'Cancel', exact: true });

        // Toasts
        this.nameExistsToast = toast(page, /already exist/i);
    }

    /** A tab of the group detail. */
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

    /** Fills the open dialog (and any required custom attribute) without submitting. */
    async fillCreateForm(fields: GroupFields): Promise<void> {
        await fillText(this.nameInput, fields.name);
        await fillText(this.descriptionInput, fields.description);
        await fillText(this.emailInput, fields.email);
        await fillRequiredCustomAttributes(this.page, this.createGroupDialog, 'qa-reg', await customAttributesDefined(this.page, 'groups'));
    }

    /** Clicks Create and returns the answer of `POST /api/v1/groups` (status, new uuid, request body); the dialog is not waited for. */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createButton, { endpoint: '/api/v1/groups' });
    }

    async assertDetailShows(name: string): Promise<void> {
        await expect(this.main).toContainText(name);
    }

    async openTab(name: GroupTab): Promise<void> {
        await this.tab(name).click();
    }

    /** The page shows no error text (a tab that failed to load shows the platform's error); it never clicks a tab. */
    async assertNoErrorShown(tab: GroupTab): Promise<void> {
        await expect(this.main, `the ${tab} tab shows no error`).not.toContainText(ERROR_TEXT);
    }

    async assertDuplicateNameRefused(): Promise<void> {
        await expect(this.nameExistsToast).toBeVisible();
    }

    /** Clears the toasts and closes the dialog when a refused create left it open. */
    async closeCreateDialog(): Promise<void> {
        await dismissToasts(this.page);
        await cancelIfOpen(this.createGroupDialog, this.cancelButton);
    }
}
