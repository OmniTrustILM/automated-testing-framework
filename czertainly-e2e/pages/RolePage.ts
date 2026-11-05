/**
 * RolePage — Page Object Model for Roles (REG-CFG-07).
 *
 * Encapsulates:
 *   - the Roles list and the role detail
 *   - the Create / Edit / Delete Role dialogs
 *
 * Actions return the platform's answer; the spec asserts. Edit and Delete are used only on roles this run created. The
 * form resets when the detail refetch lands, so typing waits for that request.
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

/** `GET`, `PUT` and `DELETE` of one role. */
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

        // List of Roles
        this.rolesList = widgetTitled(this.main, 'List of Roles');
        this.addRoleButton = this.rolesList.getByTestId('plus-button');
        this.searchInput = this.rolesList.getByRole('textbox', { name: 'Search' });
        this.rowLinks = this.rolesList.locator('tbody tr a[href*="/detail/"]');

        // Role Details
        this.roleDetails = widgetTitled(this.main, 'Role Details');
        this.editRoleButton = this.roleDetails.getByTestId('pencil-button');
        this.deleteRoleButton = this.roleDetails.getByTestId('trash-button');
        this.roleNameRow = this.roleDetails.locator('tr[data-id="roleName"]');
        this.descriptionRow = this.roleDetails.locator('tr[data-id="description"]');

        // Create Role dialog
        this.createRoleDialog = page.getByRole('dialog', { name: 'Create Role' });
        this.nameInput = this.createRoleDialog.getByTestId('text-input-name');
        this.descriptionInput = this.createRoleDialog.getByTestId('text-input-description');
        this.emailInput = this.createRoleDialog.getByTestId('text-input-email');
        this.createButton = this.createRoleDialog.getByTestId('progress-button').last();
        this.cancelCreateButton = this.createRoleDialog.getByRole('button', { name: 'Cancel', exact: true });

        // Edit Role dialog
        this.editRoleDialog = page.getByRole('dialog', { name: 'Edit Role' });
        this.editDialogSpinner = this.editRoleDialog.getByTestId('spinner');
        this.editNameInput = this.editRoleDialog.getByTestId('text-input-name');
        this.editDescriptionInput = this.editRoleDialog.getByTestId('text-input-description');
        this.editEmailInput = this.editRoleDialog.getByTestId('text-input-email');
        this.saveButton = this.editRoleDialog.getByTestId('progress-button').last();
        this.cancelEditButton = this.editRoleDialog.getByRole('button', { name: 'Cancel', exact: true });

        // Delete Role dialog
        this.deleteRoleDialog = page.getByRole('dialog', { name: 'Delete Role' });
        this.confirmDeleteButton = this.deleteRoleDialog.getByRole('button', { name: 'Delete', exact: true });
    }

    /** The link of a role in the list (exact name). */
    roleLink(name: string): Locator {
        return this.rolesList.getByRole('link', { name, exact: true });
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/roles');
        await expect(this.rolesList).toBeVisible();
    }

    /**
     * The list as the server serves it NOW: the hash route, a reload, and only then the widget wait (a `goto` that only repeats
     * the hash is no navigation, so waiting first would judge the old render).
     */
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

    /** Fills the Create Role dialog (and any required custom attribute) without submitting. */
    async fillCreateForm(fields: RoleFields): Promise<void> {
        await fillText(this.nameInput, fields.name);
        if (fields.description !== undefined) await fillText(this.descriptionInput, fields.description);
        if (fields.email !== undefined) await fillText(this.emailInput, fields.email);
        await fillRequiredCustomAttributes(this.page, this.createRoleDialog, 'qa-reg', await customAttributesDefined(this.page, 'roles'));
    }

    /** Submits the Create Role dialog; returns the answer of `POST /api/v1/roles` (status, new uuid, text), registered before the click. */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createButton, { endpoint: /\/api\/v1\/roles$/ });
    }

    /** Closes the Create Role dialog with Cancel when a refused create left it open. */
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

    /**
     * Detail → Edit → change description / e-mail → Save; returns the answer of `PUT /api/v1/roles/{uuid}`.
     * RoleForm resets its fields from the role detail whenever the detail refetch finishes, which overwrote typed values on a
     * live tier. So the dialog is opened with the wait for that refetch registered, the form must show every stored value (the
     * state the reset produces), and only then the values are typed and checked before Save.
     */
    async editRole(fields: { description?: string; email?: string }): Promise<ApiAnswer> {
        const refetch = await actAndWaitForApi(this.page, { method: 'GET', path: ROLE_PATH }, () => this.openEditDialog());
        const stored = (await refetch.json()) as { name?: string; description?: string | null; email?: string | null };
        // RoleForm resets its fields in an effect that runs once the detail fetch and the custom attribute fetch are both done (its
        // Widget shows its Spinner while either runs, `busy`): when the answer is in and the spinner is gone, the reset has happened.
        // The form's Widget has no busy overlay, so the spinner is the signal; then the stored values are shown.
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

    /** Detail → Delete → "Delete Role" → Delete; returns the answer of `DELETE /api/v1/roles/{uuid}`. */
    async deleteFromDetail(): Promise<ApiAnswer> {
        await this.deleteRoleButton.click();
        await expect(this.deleteRoleDialog).toBeVisible();
        return actAndReadAnswer(this.page, { method: 'DELETE', path: ROLE_PATH }, () => this.confirmDeleteButton.click());
    }

    /** The refusal names the collision: a danger toast that names the role and says it exists. */
    async assertDuplicateRefused(name: string): Promise<void> {
        const card = await assertToast(this.page, /Failed to create role/i, { severity: 'danger' });
        await expect(card, 'the message names the role').toContainText(name);
        await expect(card, 'the message says it already exists').toContainText(/already exists/i);
    }

    /** In the Edit Role dialog the name field is disabled (RoleForm `disabled={editMode}`) and shows the name. */
    async assertNameLockedInEdit(name: string): Promise<void> {
        await expect(this.editNameInput).toBeDisabled();
        await expect(this.editNameInput).toHaveValue(name);
    }

    /**
     * The detail rows show the saved values. Call it BEFORE opening a dialog: an open modal hides the page from the
     * accessibility tree, and the widget is found by its heading's role.
     */
    async assertDetailRows(expected: { name: string; description: string }): Promise<void> {
        await expect(this.roleNameRow).toContainText(expected.name);
        await expect(this.descriptionRow).toContainText(expected.description);
    }

    /** The open Edit Role dialog shows the saved values. */
    async assertEditFormValues(expected: { name: string; description: string; email: string }): Promise<void> {
        await expect(this.editDescriptionInput).toHaveValue(expected.description);
        await expect(this.editEmailInput).toHaveValue(expected.email);
        await expect(this.editNameInput).toHaveValue(expected.name);
    }

    /**
     * Searched by name, the list has no row of that name. Absence needs a positive marker first: the list shows rows (every tier
     * has system roles), so an empty, still-loading table cannot pass for "not listed". The search box is cleared afterwards.
     */
    async assertNotListed(name: string, options: { loadTimeout?: number } = {}): Promise<void> {
        await expect(this.rowLinks.first(), 'the list has loaded its rows').toBeVisible({ timeout: options.loadTimeout ?? 30_000 });
        await this.searchInput.fill(name);
        await expect(this.roleLink(name)).toHaveCount(0);
        await this.searchInput.fill('');
    }
}
