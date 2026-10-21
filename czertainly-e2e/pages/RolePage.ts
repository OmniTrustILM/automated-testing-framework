/**
 * RolePage — the Roles list, the role detail and the Create / Edit / Delete Role dialogs (REG-CFG-07; the permission
 * editor stays in REG-CFG-08). Built on SearchableListWidget (`List of Roles`), FormDialog (`Create Role`, `Edit Role`:
 * `text-input-name`, disabled in edit because a role name cannot change, `-description`, `-email`) and
 * ConfirmDeleteDialog (`Delete Role`). Detail: widget `Role Details` (toolbar `pencil-button` = Edit, `trash-button` =
 * Delete), rows `roleName`, `description`, `email`. Actions return the platform's answer; the spec asserts it.
 *
 * Edit and Delete are only called on a role the run created: the spec checks it first with `assertOwnLive` (the browser
 * is not behind the API guard; own objects only).
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
import { FormDialog } from './FormDialog';
import { SearchableListWidget } from './SearchableListWidget';
import { fillRequiredCustomAttributes, fillText } from './ui/form';
import { assertToast } from './ui/toast';
import { UUID } from './ui/waitForResponse';
import { iconButton, widgetTitled } from './ui/widget';

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

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.list = new SearchableListWidget(page, 'List of Roles');
        this.createDialog = new FormDialog(page, 'Create Role');
        this.editDialog = new FormDialog(page, 'Edit Role');
        this.deleteDialog = new ConfirmDeleteDialog(page, 'Delete Role');
    }

    get detailsWidget(): Locator {
        return widgetTitled(this.main, 'Role Details');
    }

    async goToList(): Promise<void> {
        await this.page.goto('administrator/#/roles');
        await expect(this.list.root).toBeVisible();
    }

    /**
     * The list as the server serves it NOW: the hash route, a reload, and only then the widget wait. A `goto` that only
     * repeats or changes the hash is no navigation (the document stays, and with it an earlier, possibly stale render),
     * so the reload comes before the wait: waiting first would wait on the old render.
     */
    async reloadList(): Promise<void> {
        await this.page.goto('administrator/#/roles');
        await this.page.reload();
        await expect(this.list.root).toBeVisible();
    }

    async goToDetail(uuid: string): Promise<void> {
        logger.info(`Opening role ${uuid}`);
        await this.page.goto(`administrator/#/roles/detail/${uuid}`);
        await expect(this.detailsWidget).toBeVisible();
    }

    async openCreateDialog(): Promise<Locator> {
        await iconButton(this.list.root, 'plus').click();
        await expect(this.createDialog.dialog).toBeVisible();
        return this.createDialog.dialog;
    }

    /** Fills the Create Role dialog (and any required custom attribute) without submitting. */
    async fillCreateForm(fields: RoleFields): Promise<void> {
        await this.createDialog.fillTexts({ name: fields.name, description: fields.description, email: fields.email });
        await fillRequiredCustomAttributes(this.page, this.createDialog.dialog, 'qa-reg');
    }

    /** Submits the Create Role dialog; returns the status of `POST /api/v1/roles` (registered before the click). */
    async submitCreateForm(): Promise<{ status: number }> {
        const res = await this.createDialog.submit({ method: 'POST', path: /\/api\/v1\/roles$/ });
        return { status: res.status() };
    }

    async openEditDialog(): Promise<Locator> {
        await iconButton(this.detailsWidget, 'pencil').click();
        await expect(this.editDialog.dialog).toBeVisible();
        return this.editDialog.dialog;
    }

    /**
     * Detail → Edit → change description / e-mail → Save; returns the status of `PUT /api/v1/roles/{uuid}`.
     * RoleForm resets its fields from the role detail whenever the detail refetch finishes (seen on a live tier: the typed
     * values were overwritten and the PUT carried the old ones). So the stored role is awaited in the form first, and the
     * typed values must then hold for one second (typed again whenever the form reset them) before Save; the PUT is the
     * proof of what was sent.
     */
    async editRole(fields: { description?: string; email?: string }): Promise<{ status: number }> {
        await this.openEditDialog();
        const form = this.editDialog;
        await expect(form.input('name'), 'the form holds the stored role').not.toHaveValue('');
        const typed = async (): Promise<void> => {
            if (fields.description !== undefined) await fillText(form.input('description'), fields.description);
            if (fields.email !== undefined) await fillText(form.input('email'), fields.email);
        };
        const holds = async (): Promise<boolean> =>
            (fields.description === undefined || (await form.input('description').inputValue()) === fields.description)
            && (fields.email === undefined || (await form.input('email').inputValue()) === fields.email);
        await typed();
        let heldSince = Date.now();
        await expect(async () => {
            if (!(await holds())) {
                await typed();
                heldSince = Date.now();
            }
            expect(Date.now() - heldSince, 'the typed values held for 1 s (the form resets them when the role detail refetch lands)').toBeGreaterThanOrEqual(1_000);
        }).toPass({ intervals: [250], timeout: 15_000 });
        if (fields.description !== undefined) await expect(form.input('description')).toHaveValue(fields.description);
        if (fields.email !== undefined) await expect(form.input('email')).toHaveValue(fields.email);
        const answer = await form.submit({ method: 'PUT', path: new RegExp(`/api/v1/roles/${UUID}$`) });
        return { status: answer.status() };
    }

    /** Detail → Delete → "Delete Role" → Delete; returns the status of `DELETE /api/v1/roles/{uuid}`. */
    async deleteRoleFromDetail(): Promise<{ status: number }> {
        await iconButton(this.detailsWidget, 'trash').click();
        return this.deleteDialog.confirm({ method: 'DELETE', path: new RegExp(`/api/v1/roles/${UUID}$`) });
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
    async assertNotListed(name: string, opts: { loadTimeout?: number } = {}): Promise<void> {
        await this.list.assertNotListed(name, opts);
    }
}
