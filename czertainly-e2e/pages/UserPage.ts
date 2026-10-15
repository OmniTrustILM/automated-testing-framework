/**
 * UserPage — Users list, detail and the Create / Edit User dialog (B1: REG-CFG-09 and REG-CFG-09.b / .c; enable /
 * disable and the account guards REG-AUTH-14 / 15 extend it in B5).
 *
 * List: widget `List of Users` (toolbar `plus-button` = Create User; client-side `Search` box). Detail: widget
 * `User Details` (toolbar `pencil-button` = Edit, `trash-button` = Delete, `check-button` / `times-button` = Enable /
 * Disable), rows `username`, `description`, `firstName`, `lastName`, `email`, `enabled` (Status), `roles`. Dialogs by
 * caption: `Create User`, `Edit User`, `Delete User` (Cancel / Delete). UserForm fields: `text-input-username`
 * (disabled in edit), `text-input-firstName`, `text-input-lastName`, `text-input-email`, `switch-enabled-input`; the
 * "Assigned User Roles" table ticks a role by its row. Create sends POST /users then PATCH /users/{uuid}/roles; Edit
 * sends PUT /users/{uuid} (and the roles PATCH).
 *
 * Edit and Delete are only called on a user the run created: the spec checks it first with `assertOwnLive` (decision Q1).
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { fillRequiredCustomAttributes, fillText, iconButton, submitButton, widget } from './RegressionUi';

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

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
    }

    get listWidget(): Locator {
        return widget(this.main, 'List of Users');
    }

    get detailsWidget(): Locator {
        return widget(this.main, 'User Details');
    }

    get createDialog(): Locator {
        return this.page.getByRole('dialog', { name: 'Create User' });
    }

    get editDialog(): Locator {
        return this.page.getByRole('dialog', { name: 'Edit User' });
    }

    async goToList(): Promise<void> {
        await this.page.goto('administrator/#/users');
        await expect(this.listWidget).toBeVisible();
    }

    /**
     * The list as the server serves it NOW: the hash route, a reload, and only then the widget wait. A `goto` that only
     * repeats or changes the hash is no navigation (the document stays, and with it an earlier, possibly stale render),
     * so the reload comes before the wait: waiting first would wait on the old render.
     */
    async goToFreshList(): Promise<void> {
        await this.page.goto('administrator/#/users');
        await this.page.reload();
        await expect(this.listWidget).toBeVisible();
    }

    async openDetail(uuid: string): Promise<void> {
        logger.info(`Opening user ${uuid}`);
        await this.page.goto(`administrator/#/users/detail/${uuid}`);
        await expect(this.detailsWidget).toBeVisible();
    }

    async openCreateDialog(): Promise<Locator> {
        await iconButton(this.listWidget, 'plus').click();
        await expect(this.createDialog).toBeVisible();
        return this.createDialog;
    }

    /**
     * Tick a role in the dialog's "Assigned User Roles" table: the row that has the role's name cell, then THAT row's
     * checkbox (CustomTable's row checkbox is a plain, visible `<input type=checkbox>`: no `force`, so a covered or
     * disabled box fails here instead of being clicked through; Fable F4).
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
     * records what was created before any assertion (phase-05 §6.1 rule 10) and then checks the dialog closed.
     */
    async create(fields: UserFields): Promise<{ createStatus: number; rolesStatus?: number }> {
        const dialog = await this.openCreateDialog();
        await fillText(dialog.getByTestId('text-input-username'), fields.username);
        await fillText(dialog.getByTestId('text-input-firstName'), fields.firstName ?? 'QA');
        await fillText(dialog.getByTestId('text-input-lastName'), fields.lastName ?? 'Regression');
        await fillText(dialog.getByTestId('text-input-email'), fields.email ?? `${fields.username}@example.test`);
        await expect(dialog.getByTestId('switch-enabled-input')).toBeChecked();
        await fillRequiredCustomAttributes(this.page, dialog, 'qa-reg');
        for (const r of fields.roleNames ?? []) await this.tickRole(dialog, r);
        const createCall = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/v1\/users$/.test(new URL(r.url()).pathname));
        const rolesCall = (fields.roleNames ?? []).length
            ? this.page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/api\/v1\/users\/[0-9a-f-]{36}\/roles$/.test(new URL(r.url()).pathname))
            : undefined;
        await submitButton(dialog).click();
        const createStatus = (await createCall).status();
        const rolesStatus = rolesCall && createStatus < 300 ? (await rolesCall).status() : undefined;
        return { createStatus, rolesStatus };
    }

    async openEditDialog(): Promise<Locator> {
        await iconButton(this.detailsWidget, 'pencil').click();
        await expect(this.editDialog).toBeVisible();
        return this.editDialog;
    }

    /**
     * Waits until the dialog's custom-attribute editor holds the stored values (live run 4, REG-CFG-09.b: Save pressed about 240 ms
     * after the dialog opened sent `customAttributes: []` and core answered 422 "Content for required Custom attribute ... is not provided").
     * The busy overlay is gone, the "Custom attributes" tab (when the tier has custom attributes) shows its editor, and every
     * REQUIRED list attribute shows a value (not the "Select ..." placeholder); then the tab that was active is selected again.
     * If a required value stays empty after the wait, the form did not take it from the user: candidate C15 (the error says so).
     */
    private async waitForCustomAttributeEditor(dialog: Locator): Promise<void> {
        await expect(dialog.getByTestId('widget-busy-overlay')).toHaveCount(0);
        const tab = dialog.getByRole('tab', { name: /^Custom attributes$/i }).first();
        if (!(await tab.isVisible().catch(() => false))) return;
        const active = dialog.getByRole('tab', { selected: true }).first();
        const activeName = ((await active.textContent().catch(() => '')) ?? '').trim();
        await tab.click();
        await expect(dialog.getByTestId('select-selectAddCustomAttribute-trigger').first(), 'the custom attribute editor is rendered').toBeAttached();
        const labels = dialog.locator('label[for^="__attributes__custom"]').filter({ hasText: /\*\s*$/ });
        await expect(async () => {
            for (const label of await labels.all()) {
                const forId = (await label.getAttribute('for'))!;
                const trigger = this.page.getByTestId(`select-${forId}-trigger`).or(this.page.getByTestId(`select-${forId}Select-trigger`)).first();
                if (await trigger.count()) expect((await trigger.innerText()).trim(), `required attribute ${(await label.innerText()).trim()} holds its stored value (else candidate C15)`).not.toMatch(/^Select /);
                else {
                    const input = dialog.locator(`[id="${forId}"]`);
                    if (await input.count()) expect(await input.inputValue(), `required attribute ${(await label.innerText()).trim()} holds its stored value (else candidate C15)`).not.toBe('');
                }
            }
        }).toPass({ timeout: 15_000 });
        if (activeName && !/^Custom attributes$/i.test(activeName)) await dialog.getByRole('tab', { name: activeName, exact: true }).click();
    }

    /** Detail → Edit → change names / e-mail → Save (PUT /users/{uuid}) → the dialog closes. */
    async edit(fields: { firstName?: string; lastName?: string; email?: string }): Promise<void> {
        const dialog = await this.openEditDialog();
        await this.waitForCustomAttributeEditor(dialog);
        if (fields.firstName !== undefined) await fillText(dialog.getByTestId('text-input-firstName'), fields.firstName);
        if (fields.lastName !== undefined) await fillText(dialog.getByTestId('text-input-lastName'), fields.lastName);
        if (fields.email !== undefined) await fillText(dialog.getByTestId('text-input-email'), fields.email);
        const answer = this.page.waitForResponse((r) => r.request().method() === 'PUT' && /\/api\/v1\/users\/[0-9a-f-]{36}$/.test(new URL(r.url()).pathname));
        await submitButton(dialog).click();
        expect((await answer).status(), 'PUT /api/v1/users/{uuid}').toBeLessThan(300);
        await expect(dialog).toBeHidden();
    }

    /** Detail → Delete → "Delete User" → Delete; the page returns to the list. */
    async deleteFromDetail(): Promise<void> {
        await iconButton(this.detailsWidget, 'trash').click();
        const dialog = this.page.getByRole('dialog', { name: 'Delete User' });
        await expect(dialog).toBeVisible();
        const answer = this.page.waitForResponse((r) => r.request().method() === 'DELETE' && /\/api\/v1\/users\/[0-9a-f-]{36}$/.test(new URL(r.url()).pathname));
        await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
        expect((await answer).status(), 'DELETE /api/v1/users/{uuid}').toBeLessThan(300);
        await expect(dialog).toBeHidden();
    }

    async cancelDialog(dialog: Locator): Promise<void> {
        if (await dialog.isVisible()) {
            await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
            await expect(dialog).toBeHidden();
        }
    }

    async searchList(text: string): Promise<void> {
        await this.listWidget.getByRole('textbox', { name: 'Search' }).fill(text);
    }

    rowLink(username: string): Locator {
        return this.listWidget.getByRole('link', { name: username, exact: true });
    }

    /** In the Edit User dialog the username field is disabled and shows the username (REG-CFG-09.b). */
    async assertUsernameLockedInEdit(username: string): Promise<void> {
        await expect(this.editDialog.getByTestId('text-input-username')).toBeDisabled();
        await expect(this.editDialog.getByTestId('text-input-username')).toHaveValue(username);
    }

    /** After a reload the detail rows and the reopened Edit User dialog show the saved values; the dialog is cancelled. */
    async assertEdited(expected: { username: string; firstName: string; lastName: string; email: string }): Promise<void> {
        await this.page.reload();
        await expect(this.detailsWidget).toBeVisible();
        await expect(this.detailsWidget.locator('tr[data-id="username"]')).toContainText(expected.username);
        await expect(this.detailsWidget.locator('tr[data-id="email"]')).toContainText(expected.email);
        const dialog = await this.openEditDialog();
        await expect(dialog.getByTestId('text-input-firstName')).toHaveValue(expected.firstName);
        await expect(dialog.getByTestId('text-input-lastName')).toHaveValue(expected.lastName);
        await expect(dialog.getByTestId('text-input-email')).toHaveValue(expected.email);
        await expect(dialog.getByTestId('text-input-username')).toHaveValue(expected.username);
        await this.cancelDialog(dialog);
    }

    /** The detail's Roles row lists exactly these role names (order-insensitive). */
    async assertRoles(names: string[]): Promise<void> {
        const text = (await this.detailsWidget.locator('tr[data-id="roles"]').locator('td').last().innerText()).trim();
        const shown = text ? text.split(/,\s*/).map((s) => s.trim()).sort() : [];
        expect(shown).toEqual([...names].sort());
    }

    /**
     * The users list (searched by username) has no row of that name (REG-CFG-09.c), after the list showed its rows
     * (a positive marker: an empty, loading table cannot pass for "gone"). The list is read fresh (`goToFreshList`);
     * `loadTimeout` is how long the rows may take to show.
     */
    async assertGone(username: string, opts: { loadTimeout?: number } = {}): Promise<void> {
        await this.goToFreshList();
        await expect(this.listWidget.locator('tbody tr a[href*="/detail/"]').first(), 'the users list has loaded its rows').toBeVisible({ timeout: opts.loadTimeout ?? 30_000 });
        await this.searchList(username);
        await expect(this.rowLink(username)).toHaveCount(0);
        await this.searchList('');
    }
}
