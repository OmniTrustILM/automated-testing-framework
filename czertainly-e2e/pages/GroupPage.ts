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
import { FormDialog } from './FormDialog';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { customAttributesDefined, fillRequiredCustomAttributes } from './ui/form';
import { dismissToasts, toast } from './ui/toast';
import { toolbarButton } from './ui/toolbar';

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
    readonly createDialog: FormDialog;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.createDialog = new FormDialog(page, 'Create Group');
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/groups');
        await expect(this.main).toBeVisible();
    }

    /** The detail page of one group. */
    async goToDetail(uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/groups/detail/${uuid}`);
        await expect(this.main).toBeVisible();
    }

    /** The list's "+" → the Create Group dialog is open. */
    async openCreateDialog(): Promise<void> {
        await toolbarButton(this.page, 'plus').click();
        await expect(this.createDialog.dialog).toBeVisible();
    }

    /** Fills the open dialog (and any required custom attribute) without submitting. */
    async fillCreateForm(fields: GroupFields): Promise<void> {
        await this.createDialog.fillTexts({ name: fields.name, description: fields.description, email: fields.email });
        await fillRequiredCustomAttributes(this.page, this.createDialog.dialog, 'qa-reg', await customAttributesDefined(this.page, 'groups'));
    }

    /** Clicks Create and returns the answer of `POST /api/v1/groups` (status, new uuid, request body); the dialog is not waited for. */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createDialog.dialog, { endpoint: '/api/v1/groups' });
    }

    /** The detail page shows the group's name. */
    async assertDetailShows(name: string): Promise<void> {
        await expect(this.main).toContainText(name);
    }

    async openTab(tab: GroupTab): Promise<void> {
        await this.main.getByRole('tab', { name: tab, exact: true }).click();
    }

    /** The page shows no error text (a tab that failed to load shows the platform's error); it never clicks a tab. */
    async assertNoErrorShown(tab: GroupTab): Promise<void> {
        await expect(this.main, `the ${tab} tab shows no error`).not.toContainText(ERROR_TEXT);
    }

    /** A refusal toast says that the name exists already. */
    async assertDuplicateNameRefused(): Promise<void> {
        await expect(toast(this.page, /already exist/i)).toBeVisible();
    }

    /** Clears the toasts and closes the dialog when a refused create left it open. */
    async closeCreateDialog(): Promise<void> {
        await dismissToasts(this.page);
        await this.createDialog.cancel();
    }
}
