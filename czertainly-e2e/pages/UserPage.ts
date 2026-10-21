/**
 * UserPage — the Users list, the user detail and the Create / Edit / Delete User dialogs (REG-CFG-09). Built on
 * SearchableListWidget (`List of Users`), FormDialog (`Create User`, `Edit User`: `text-input-username`, disabled in
 * edit, `-firstName`, `-lastName`, `-email`, `switch-enabled-input`; the "Assigned User Roles" table ticks a role by its
 * row) and ConfirmDeleteDialog (`Delete User`). Detail: widget `User Details` (toolbar `pencil-button` = Edit,
 * `trash-button` = Delete), rows `username`, `email`, `roles`. Create sends POST /users then PATCH /users/{uuid}/roles;
 * Edit sends PUT /users/{uuid}. Actions return the platform's answers; the spec asserts them.
 *
 * Edit and Delete are only called on a user the run created: the spec checks it first with `assertOwnLive` (own objects only).
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
import { FormDialog } from './FormDialog';
import { SearchableListWidget } from './SearchableListWidget';
import { fillRequiredCustomAttributes } from './ui/form';
import { UUID, watchApiCall } from './ui/waitForResponse';
import { iconButton, widgetTitled } from './ui/widget';

const logger = new Logger('UserPage');

export interface UserFields {
    username: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    roleNames?: string[];
}

export class UserPage {
    readonly page: Page;
    readonly main: Locator;
    readonly list: SearchableListWidget;
    readonly createDialog: FormDialog;
    readonly editDialog: FormDialog;
    readonly deleteDialog: ConfirmDeleteDialog;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.list = new SearchableListWidget(page, 'List of Users');
        this.createDialog = new FormDialog(page, 'Create User');
        this.editDialog = new FormDialog(page, 'Edit User');
        this.deleteDialog = new ConfirmDeleteDialog(page, 'Delete User');
    }

    get detailsWidget(): Locator {
        return widgetTitled(this.main, 'User Details');
    }

    async goToList(): Promise<void> {
        await this.page.goto('administrator/#/users');
        await expect(this.list.root).toBeVisible();
    }

    /**
     * The list as the server serves it NOW: the hash route, a reload, and only then the widget wait. A `goto` that only
     * repeats or changes the hash is no navigation (the document stays, and with it an earlier, possibly stale render),
     * so the reload comes before the wait: waiting first would wait on the old render.
     */
    async reloadList(): Promise<void> {
        await this.page.goto('administrator/#/users');
        await this.page.reload();
        await expect(this.list.root).toBeVisible();
    }

    async goToDetail(uuid: string): Promise<void> {
        logger.info(`Opening user ${uuid}`);
        await this.page.goto(`administrator/#/users/detail/${uuid}`);
        await expect(this.detailsWidget).toBeVisible();
    }

    async openCreateDialog(): Promise<Locator> {
        await iconButton(this.list.root, 'plus').click();
        await expect(this.createDialog.dialog).toBeVisible();
        return this.createDialog.dialog;
    }

    /**
     * Tick a role in the dialog's "Assigned User Roles" table: the row that has the role's name cell, then THAT row's
     * checkbox (CustomTable's row checkbox is a plain, visible `<input type=checkbox>`: no `force`, so a covered or
     * disabled box fails here instead of being clicked through).
     */
    async tickRole(dialog: Locator, roleName: string): Promise<void> {
        const row = dialog.getByRole('row').filter({ has: this.page.getByRole('cell', { name: roleName, exact: true }) });
        await expect(row).toHaveCount(1);
        const box = row.getByRole('checkbox');
        await box.scrollIntoViewIfNeeded();
        await expect(box).toBeEnabled();
        await box.check();
        await expect(box).toBeChecked();
    }

    /**
     * Users → "+" → Create User → fields (+ required custom attributes) → roles → Create. Waits for the create POST and
     * the roles PATCH the form sends after it and returns their statuses; it asserts nothing after the click, so the spec
     * records what was created before any assertion and then checks the dialog closed.
     */
    async createUser(fields: UserFields): Promise<{ createStatus: number; rolesStatus?: number }> {
        const dialog = await this.openCreateDialog();
        await this.createDialog.fillTexts({
            username: fields.username,
            firstName: fields.firstName ?? 'QA',
            lastName: fields.lastName ?? 'Regression',
            email: fields.email ?? `${fields.username}@example.test`,
        });
        await expect(dialog.getByTestId('switch-enabled-input')).toBeChecked();
        await fillRequiredCustomAttributes(this.page, dialog, 'qa-reg');
        for (const r of fields.roleNames ?? []) await this.tickRole(dialog, r);
        const createCall = watchApiCall(this.page, { method: 'POST', path: /\/api\/v1\/users$/ });
        const rolesCall = (fields.roleNames ?? []).length
            ? watchApiCall(this.page, { method: 'PATCH', path: new RegExp(`/api/v1/users/${UUID}/roles$`) })
            : undefined;
        await this.createDialog.submitButton.click();
        const createStatus = (await createCall).status();
        const rolesStatus = rolesCall && createStatus < 300 ? (await rolesCall).status() : undefined;
        return { createStatus, rolesStatus };
    }

    async openEditDialog(): Promise<Locator> {
        await iconButton(this.detailsWidget, 'pencil').click();
        await expect(this.editDialog.dialog).toBeVisible();
        return this.editDialog.dialog;
    }

    /**
     * Waits until the dialog's custom-attribute editor holds the stored values (seen on a live tier: Save pressed about 240 ms
     * after the dialog opened sent `customAttributes: []` and core answered 422 "Content for required Custom attribute ... is not provided").
     * The busy overlay is gone, the "Custom attributes" tab (when the tier has custom attributes) shows its editor, and every
     * REQUIRED list attribute shows a value (not the "Select ..." placeholder); then the tab that was active is selected again.
     * If a required value stays empty after the wait, the form did not take it from the user: suspected defect (the error says so).
     */
    private async waitForCustomAttributeEditor(dialog: Locator): Promise<void> {
        await expect(dialog.getByTestId('widget-busy-overlay')).toHaveCount(0);
        const tab = dialog.getByRole('tab', { name: /^Custom attributes$/i }).first();
        if (!(await tab.isVisible())) return;
        const active = dialog.getByRole('tab', { selected: true }).first();
        // No selected tab is fine: then no tab is re-selected afterwards, so a failed read is ignored.
        const activeName = ((await active.textContent().catch(() => '')) ?? '').trim();
        await tab.click();
        await expect(dialog.getByTestId('select-selectAddCustomAttribute-trigger').first(), 'the custom attribute editor is rendered').toBeAttached();
        const labels = dialog.locator('label[for^="__attributes__custom"]').filter({ hasText: /\*\s*$/ });
        await expect(async () => {
            for (const label of await labels.all()) {
                const forId = (await label.getAttribute('for'))!;
                const trigger = this.page.getByTestId(`select-${forId}-trigger`).or(this.page.getByTestId(`select-${forId}Select-trigger`)).first();
                if (await trigger.count()) expect((await trigger.innerText()).trim(), `required attribute ${(await label.innerText()).trim()} holds its stored value (else suspected defect)`).not.toMatch(/^Select /);
                else {
                    const input = dialog.locator(`[id="${forId}"]`);
                    if (await input.count()) expect(await input.inputValue(), `required attribute ${(await label.innerText()).trim()} holds its stored value (else suspected defect)`).not.toBe('');
                }
            }
        }).toPass({ timeout: 15_000 });
        if (activeName && !/^Custom attributes$/i.test(activeName)) await dialog.getByRole('tab', { name: activeName, exact: true }).click();
    }

    /** Detail → Edit → change names / e-mail → Save; returns the status of `PUT /api/v1/users/{uuid}`. */
    async editUser(fields: { firstName?: string; lastName?: string; email?: string }): Promise<{ status: number }> {
        const dialog = await this.openEditDialog();
        await this.waitForCustomAttributeEditor(dialog);
        await this.editDialog.fillTexts({ firstName: fields.firstName, lastName: fields.lastName, email: fields.email });
        const answer = await this.editDialog.submit({ method: 'PUT', path: new RegExp(`/api/v1/users/${UUID}$`) });
        return { status: answer.status() };
    }

    /** Detail → Delete → "Delete User" → Delete; returns the status of `DELETE /api/v1/users/{uuid}`. */
    async deleteUserFromDetail(): Promise<{ status: number }> {
        await iconButton(this.detailsWidget, 'trash').click();
        return this.deleteDialog.confirm({ method: 'DELETE', path: new RegExp(`/api/v1/users/${UUID}$`) });
    }

    /** In the Edit User dialog the username field is disabled and shows the username. */
    async assertUsernameLockedInEdit(username: string): Promise<void> {
        await expect(this.editDialog.input('username')).toBeDisabled();
        await expect(this.editDialog.input('username')).toHaveValue(username);
    }

    /**
     * The detail rows show the saved values. Call it BEFORE opening a dialog: an open modal hides the page from the
     * accessibility tree, and the widget is found by its heading's role.
     */
    async assertDetailRows(expected: { username: string; email: string }): Promise<void> {
        await expect(this.detailsWidget.locator('tr[data-id="username"]')).toContainText(expected.username);
        await expect(this.detailsWidget.locator('tr[data-id="email"]')).toContainText(expected.email);
    }

    /** The open Edit User dialog shows the saved values. */
    async assertEditFormValues(expected: { username: string; firstName: string; lastName: string; email: string }): Promise<void> {
        const form = this.editDialog;
        await expect(form.input('firstName')).toHaveValue(expected.firstName);
        await expect(form.input('lastName')).toHaveValue(expected.lastName);
        await expect(form.input('email')).toHaveValue(expected.email);
        await expect(form.input('username')).toHaveValue(expected.username);
    }

    /** The detail's Roles row lists exactly these role names (order-insensitive). */
    async assertRoles(names: string[]): Promise<void> {
        const text = (await this.detailsWidget.locator('tr[data-id="roles"]').locator('td').last().innerText()).trim();
        const shown = text ? text.split(/,\s*/).map((s) => s.trim()).sort() : [];
        expect(shown).toEqual([...names].sort());
    }

    /** The users list (searched by username) has no row of that name, after the list showed its rows. */
    async assertNotListed(username: string, opts: { loadTimeout?: number } = {}): Promise<void> {
        await this.list.assertNotListed(username, opts);
    }
}
