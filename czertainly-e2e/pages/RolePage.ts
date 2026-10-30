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
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
import { FormDialog } from './FormDialog';
import { SearchableListWidget } from './SearchableListWidget';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { entityScreens, type EntityScreens } from './ui/entityScreens';
import { customAttributesDefined, fillRequiredCustomAttributes, fillText } from './ui/form';
import { assertToast } from './ui/toast';
import { actAndWaitForApi, UUID } from './ui/waitForResponse';

const logger = new Logger('RolePage');

export interface RoleFields {
    name: string;
    description?: string;
    email?: string;
}

export class RolePage {
    readonly page: Page;
    readonly main: Locator;
    readonly list: SearchableListWidget;
    readonly createDialog: FormDialog;
    readonly editDialog: FormDialog;
    readonly deleteDialog: ConfirmDeleteDialog;
    /** The Role Details widget. */
    readonly detailsWidget: Locator;
    private readonly screens: EntityScreens;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.screens = entityScreens(page, { route: 'roles', listTitle: 'List of Roles', detailTitle: 'Role Details', caption: 'Role' });
        this.list = this.screens.list;
        this.createDialog = this.screens.createDialog;
        this.editDialog = this.screens.editDialog;
        this.deleteDialog = this.screens.deleteDialog;
        this.detailsWidget = this.screens.detailsWidget;
    }

    async goToList(): Promise<void> {
        await this.screens.goToList();
    }

    /**
     * The list as the server serves it NOW: the hash route, a reload, and only then the widget wait (a `goto` that only repeats
     * the hash is no navigation, so waiting first would judge the old render).
     */
    async reloadList(): Promise<void> {
        await this.screens.reloadList();
    }

    async goToDetail(uuid: string): Promise<void> {
        logger.info(`Opening role ${uuid}`);
        await this.screens.goToDetail(uuid);
    }

    /** The list's "+" → the Create Role dialog is open; returns it. */
    async openCreateDialog(): Promise<Locator> {
        return this.screens.openCreateDialog();
    }

    /** Fills the Create Role dialog (and any required custom attribute) without submitting. */
    async fillCreateForm(fields: RoleFields): Promise<void> {
        await this.createDialog.fillTexts({ name: fields.name, description: fields.description, email: fields.email });
        await fillRequiredCustomAttributes(this.page, this.createDialog.dialog, 'qa-reg', await customAttributesDefined(this.page, 'roles'));
    }

    /** Submits the Create Role dialog; returns the answer of `POST /api/v1/roles` (status, new uuid, text), registered before the click. */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createDialog.dialog, { endpoint: /\/api\/v1\/roles$/ });
    }

    /** The detail's pencil → the Edit Role dialog is open; returns it. */
    async openEditDialog(): Promise<Locator> {
        return this.screens.openEditDialog();
    }

    /**
     * Detail → Edit → change description / e-mail → Save; returns the answer of `PUT /api/v1/roles/{uuid}`.
     * RoleForm resets its fields from the role detail whenever the detail refetch finishes, which overwrote typed values on a
     * live tier. So the dialog is opened with the wait for that refetch registered, the form must show every stored value (the
     * state the reset produces), and only then the values are typed and checked before Save.
     */
    async editRole(fields: { description?: string; email?: string }): Promise<ApiAnswer> {
        const form = this.editDialog;
        const refetch = await actAndWaitForApi(this.page, { method: 'GET', path: new RegExp(`/api/v1/roles/${UUID}$`) }, () => this.openEditDialog());
        const stored = (await refetch.json()) as { name?: string; description?: string | null; email?: string | null };
        // RoleForm resets its fields in an effect that runs once the detail fetch and the custom attribute fetch are both done (its
        // Widget shows its Spinner while either runs, `busy`): when the answer is in and the spinner is gone, the reset has happened.
        // The form's Widget has no busy overlay, so the spinner is the signal; then the stored values are shown.
        await expect(form.dialog.getByTestId('spinner'), 'the role form has finished loading (detail and custom attributes)').toHaveCount(0);
        await expect(form.input('name'), 'the form holds the stored role').toHaveValue(String(stored.name));
        await expect(form.input('description'), 'the form shows the stored description').toHaveValue(stored.description ?? '');
        await expect(form.input('email'), 'the form shows the stored e-mail').toHaveValue(stored.email ?? '');
        if (fields.description !== undefined) await fillText(form.input('description'), fields.description);
        if (fields.email !== undefined) await fillText(form.input('email'), fields.email);
        if (fields.description !== undefined) await expect(form.input('description')).toHaveValue(fields.description);
        if (fields.email !== undefined) await expect(form.input('email')).toHaveValue(fields.email);
        return form.submit({ method: 'PUT', path: new RegExp(`/api/v1/roles/${UUID}$`) });
    }

    /** Detail → Delete → "Delete Role" → Delete; returns the answer of `DELETE /api/v1/roles/{uuid}`. */
    async deleteFromDetail(): Promise<ApiAnswer> {
        return this.screens.deleteFromDetail({ method: 'DELETE', path: new RegExp(`/api/v1/roles/${UUID}$`) });
    }

    /** The refusal names the collision: a danger toast that names the role and says it exists. */
    async assertDuplicateRefused(name: string): Promise<void> {
        const card = await assertToast(this.page, /Failed to create role/i, { severity: 'danger' });
        await expect(card, 'the message names the role').toContainText(name);
        await expect(card, 'the message says it already exists').toContainText(/already exists/i);
    }

    /** In the Edit Role dialog the name field is disabled (RoleForm `disabled={editMode}`) and shows the name. */
    async assertNameLockedInEdit(name: string): Promise<void> {
        await expect(this.editDialog.input('name')).toBeDisabled();
        await expect(this.editDialog.input('name')).toHaveValue(name);
    }

    /**
     * The detail rows show the saved values. Call it BEFORE opening a dialog: an open modal hides the page from the
     * accessibility tree, and the widget is found by its heading's role.
     */
    async assertDetailRows(expected: { name: string; description: string }): Promise<void> {
        await expect(this.detailsWidget.locator('tr[data-id="roleName"]')).toContainText(expected.name);
        await expect(this.detailsWidget.locator('tr[data-id="description"]')).toContainText(expected.description);
    }

    /** The open Edit Role dialog shows the saved values. */
    async assertEditFormValues(expected: { name: string; description: string; email: string }): Promise<void> {
        const form = this.editDialog;
        await expect(form.input('description')).toHaveValue(expected.description);
        await expect(form.input('email')).toHaveValue(expected.email);
        await expect(form.input('name')).toHaveValue(expected.name);
    }

    /** The roles list (searched by name) has no row of that name, after the list showed its rows. */
    async assertNotListed(name: string, options: { loadTimeout?: number } = {}): Promise<void> {
        await this.screens.assertNotListed(name, options);
    }
}
