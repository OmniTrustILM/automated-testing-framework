/**
 * RolePage — the roles list, detail and the Create / Edit / Delete Role dialogs (REG-CFG-07).
 * Edit and Delete are used only on roles this run created. The form resets when the detail refetch lands, so typing waits for that request.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { ApiAnswer } from '../utils/regression/apiReads';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { cancelIfOpen, customAttributesDefined, fillRequiredCustomAttributes, fillText } from './ui/form';
import { assertToast } from './ui/toast';
import { widgetTitled } from './ui/widget';
import { actAndReadAnswer, actAndWaitForApi, UUID } from './ui/waitForResponse';

const logger = new Logger('RolePage');

const ROLE_PATH = new RegExp(`/api/v1/roles/${UUID}$`);

export interface RoleFields {
    name: string;
    description?: string;
    email?: string;
}

export class RolePage {
    readonly page: Page;
    readonly main: Locator;

    // List of Roles
    readonly rolesList: Locator;
    readonly addRoleButton: Locator;
    readonly searchInput: Locator;
    readonly rowLinks: Locator;

    // Role Details
    readonly roleDetails: Locator;
    readonly editRoleButton: Locator;
    readonly deleteRoleButton: Locator;
    readonly roleNameRow: Locator;
    readonly descriptionRow: Locator;

    // Create Role dialog
    readonly createRoleDialog: Locator;
    readonly nameInput: Locator;
    readonly descriptionInput: Locator;
    readonly emailInput: Locator;
    readonly createButton: Locator;
    readonly cancelCreateButton: Locator;

    // Edit Role dialog
    readonly editRoleDialog: Locator;
    readonly editDialogSpinner: Locator;
    readonly editNameInput: Locator;
    readonly editDescriptionInput: Locator;
    readonly editEmailInput: Locator;
    readonly saveButton: Locator;
    readonly cancelEditButton: Locator;

    // Delete Role dialog
    readonly deleteRoleDialog: Locator;
    readonly confirmDeleteButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.rolesList = widgetTitled(this.main, 'List of Roles');
        this.addRoleButton = this.rolesList.getByTestId('plus-button');
        this.searchInput = this.rolesList.getByRole('textbox', { name: 'Search' });
        this.rowLinks = this.rolesList.locator('tbody tr a[href*="/detail/"]');

        this.roleDetails = widgetTitled(this.main, 'Role Details');
        this.editRoleButton = this.roleDetails.getByTestId('pencil-button');
        this.deleteRoleButton = this.roleDetails.getByTestId('trash-button');
        this.roleNameRow = this.roleDetails.locator('tr[data-id="roleName"]');
        this.descriptionRow = this.roleDetails.locator('tr[data-id="description"]');

        this.createRoleDialog = page.getByRole('dialog', { name: 'Create Role' });
        this.nameInput = this.createRoleDialog.getByTestId('text-input-name');
        this.descriptionInput = this.createRoleDialog.getByTestId('text-input-description');
        this.emailInput = this.createRoleDialog.getByTestId('text-input-email');
        this.createButton = this.createRoleDialog.getByTestId('progress-button').last();
        this.cancelCreateButton = this.createRoleDialog.getByRole('button', { name: 'Cancel', exact: true });

        this.editRoleDialog = page.getByRole('dialog', { name: 'Edit Role' });
        this.editDialogSpinner = this.editRoleDialog.getByTestId('spinner');
        this.editNameInput = this.editRoleDialog.getByTestId('text-input-name');
        this.editDescriptionInput = this.editRoleDialog.getByTestId('text-input-description');
        this.editEmailInput = this.editRoleDialog.getByTestId('text-input-email');
        this.saveButton = this.editRoleDialog.getByTestId('progress-button').last();
        this.cancelEditButton = this.editRoleDialog.getByRole('button', { name: 'Cancel', exact: true });

        this.deleteRoleDialog = page.getByRole('dialog', { name: 'Delete Role' });
        this.confirmDeleteButton = this.deleteRoleDialog.getByRole('button', { name: 'Delete', exact: true });
    }

    roleLink(name: string): Locator {
        return this.rolesList.getByRole('link', { name, exact: true });
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/roles');
        await expect(this.rolesList).toBeVisible();
    }

    /** A `goto` that only repeats the hash is no navigation, so the list is reloaded before the widget wait. */
    async reloadList(): Promise<void> {
        await this.page.goto('/administrator/#/roles');
        await this.page.reload();
        await expect(this.rolesList).toBeVisible();
    }

    async goToDetail(uuid: string): Promise<void> {
        logger.info(`Opening role ${uuid}`);
        await this.page.goto(`/administrator/#/roles/detail/${uuid}`);
        await expect(this.roleDetails).toBeVisible();
    }

    async openCreateDialog(): Promise<void> {
        await this.addRoleButton.click();
        await expect(this.createRoleDialog).toBeVisible();
    }

    async fillCreateForm(fields: RoleFields): Promise<void> {
        await fillText(this.nameInput, fields.name);
        if (fields.description !== undefined) await fillText(this.descriptionInput, fields.description);
        if (fields.email !== undefined) await fillText(this.emailInput, fields.email);
        await fillRequiredCustomAttributes(this.page, this.createRoleDialog, 'qa-reg', await customAttributesDefined(this.page, 'roles'));
    }

    /** Submits the Create Role dialog; returns the create answer. */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createButton, { endpoint: /\/api\/v1\/roles$/ });
    }

    async closeCreateDialog(): Promise<void> {
        await cancelIfOpen(this.createRoleDialog, this.cancelCreateButton);
    }

    async openEditDialog(): Promise<void> {
        await this.editRoleButton.click();
        await expect(this.editRoleDialog).toBeVisible();
    }

    async closeEditDialog(): Promise<void> {
        await cancelIfOpen(this.editRoleDialog, this.cancelEditButton);
    }

    /** RoleForm resets its fields on every detail refetch, so the form must show every stored value before the new ones are typed. */
    async editRole(fields: { description?: string; email?: string }): Promise<ApiAnswer> {
        const refetch = await actAndWaitForApi(this.page, { method: 'GET', path: ROLE_PATH }, () => this.openEditDialog());
        const stored = (await refetch.json()) as { name?: string; description?: string | null; email?: string | null };
        // The form's Widget has no busy overlay: the spinner gone means the reset has happened.
        await expect(this.editDialogSpinner, 'the role form has finished loading (detail and custom attributes)').toHaveCount(0);
        await expect(this.editNameInput, 'the form holds the stored role').toHaveValue(String(stored.name));
        await expect(this.editDescriptionInput, 'the form shows the stored description').toHaveValue(stored.description ?? '');
        await expect(this.editEmailInput, 'the form shows the stored e-mail').toHaveValue(stored.email ?? '');
        if (fields.description !== undefined) await fillText(this.editDescriptionInput, fields.description);
        if (fields.email !== undefined) await fillText(this.editEmailInput, fields.email);
        if (fields.description !== undefined) await expect(this.editDescriptionInput).toHaveValue(fields.description);
        if (fields.email !== undefined) await expect(this.editEmailInput).toHaveValue(fields.email);
        return actAndReadAnswer(this.page, { method: 'PUT', path: ROLE_PATH }, () => this.saveButton.click());
    }

    async deleteFromDetail(): Promise<ApiAnswer> {
        await this.deleteRoleButton.click();
        await expect(this.deleteRoleDialog).toBeVisible();
        return actAndReadAnswer(this.page, { method: 'DELETE', path: ROLE_PATH }, () => this.confirmDeleteButton.click());
    }

    async assertDuplicateRefused(name: string): Promise<void> {
        const card = await assertToast(this.page, /Failed to create role/i, { severity: 'danger' });
        await expect(card, 'the message names the role').toContainText(name);
        await expect(card, 'the message says it already exists').toContainText(/already exists/i);
    }

    async assertNameLockedInEdit(name: string): Promise<void> {
        await expect(this.editNameInput).toBeDisabled();
        await expect(this.editNameInput).toHaveValue(name);
    }

    /** Call it BEFORE opening a dialog: an open modal hides the page from the accessibility tree. */
    async assertDetailRows(expected: { name: string; description: string }): Promise<void> {
        await expect(this.roleNameRow).toContainText(expected.name);
        await expect(this.descriptionRow).toContainText(expected.description);
    }

    async assertEditFormValues(expected: { name: string; description: string; email: string }): Promise<void> {
        await expect(this.editDescriptionInput).toHaveValue(expected.description);
        await expect(this.editEmailInput).toHaveValue(expected.email);
        await expect(this.editNameInput).toHaveValue(expected.name);
    }

    /** Absence needs a positive marker first: the list shows rows (system roles), so an empty, still-loading table cannot pass. */
    async assertNotListed(name: string, options: { loadTimeout?: number } = {}): Promise<void> {
        await expect(this.rowLinks.first(), 'the list has loaded its rows').toBeVisible({ timeout: options.loadTimeout ?? 30_000 });
        await this.searchInput.fill(name);
        await expect(this.roleLink(name)).toHaveCount(0);
        await this.searchInput.fill('');
    }
}
