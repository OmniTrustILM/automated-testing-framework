/**
 * RolePage — Roles list, detail and the Create / Edit Role dialog (B1: REG-CFG-07 and REG-CFG-07.a / .b / .c; the
 * permission editor stays in REG-CFG-08 until B5).
 *
 * List: widget `List of Roles` (toolbar `plus-button` = Create Role; the table searches client-side through its
 * `Search` box). Detail: widget `Role Details` (toolbar `pencil-button` = Edit, `trash-button` = Delete,
 * `user-cog-button`, `lock-button`), rows `roleName`, `description`, `email`, `systemRole`. Dialogs by caption:
 * `Create Role`, `Edit Role`, `Delete Role` (buttons Cancel / Delete). The RoleForm fields are `text-input-name`
 * (disabled in edit: a role name cannot change), `text-input-description`, `text-input-email`; submit is the form's
 * ProgressButton (Create / Save). TextInputs are readonly until focused: click, then fill (RegressionUi.fillText).
 *
 * Edit and Delete are only called on a role the run created: the spec checks it first with `assertOwnLive` (the browser
 * is not behind the API guard; decision Q1).
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { assertToast, fillRequiredCustomAttributes, fillText, iconButton, submitButton, widget } from './RegressionUi';

const logger = new Logger('RolePage');

export interface RoleFields {
    name: string;
    description?: string;
    email?: string;
}

export class RolePage {
    readonly page: Page;
    readonly main: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
    }

    get listWidget(): Locator {
        return widget(this.main, 'List of Roles');
    }

    get detailsWidget(): Locator {
        return widget(this.main, 'Role Details');
    }

    get createDialog(): Locator {
        return this.page.getByRole('dialog', { name: 'Create Role' });
    }

    get editDialog(): Locator {
        return this.page.getByRole('dialog', { name: 'Edit Role' });
    }

    async goToList(): Promise<void> {
        await this.page.goto('administrator/#/roles');
        await expect(this.listWidget).toBeVisible();
    }

    /**
     * The list as the server serves it NOW: the hash route, a reload, and only then the widget wait. A `goto` that only
     * repeats or changes the hash is no navigation (the document stays, and with it an earlier, possibly stale render),
     * so the reload comes before the wait: waiting first would wait on the old render.
     */
    async goToFreshList(): Promise<void> {
        await this.page.goto('administrator/#/roles');
        await this.page.reload();
        await expect(this.listWidget).toBeVisible();
    }

    async openDetail(uuid: string): Promise<void> {
        logger.info(`Opening role ${uuid}`);
        await this.page.goto(`administrator/#/roles/detail/${uuid}`);
        await expect(this.detailsWidget).toBeVisible();
    }

    async openCreateDialog(): Promise<Locator> {
        await iconButton(this.listWidget, 'plus').click();
        await expect(this.createDialog).toBeVisible();
        return this.createDialog;
    }

    /** Fill the Create Role dialog (and any required custom attribute) without submitting. */
    async fillCreate(fields: RoleFields): Promise<void> {
        const dialog = this.createDialog;
        await fillText(dialog.getByTestId('text-input-name'), fields.name);
        if (fields.description !== undefined) await fillText(dialog.getByTestId('text-input-description'), fields.description);
        if (fields.email !== undefined) await fillText(dialog.getByTestId('text-input-email'), fields.email);
        await fillRequiredCustomAttributes(this.page, dialog, 'qa-reg');
    }

    /** Submit the Create Role dialog; returns the platform's answer to `POST /api/v1/roles` (registered before the click). */
    async submitCreate(): Promise<{ status: number }> {
        const answer = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/v1\/roles$/.test(new URL(r.url()).pathname));
        await submitButton(this.createDialog).click();
        const res = await answer;
        return { status: res.status() };
    }

    /** Roles → "+" → Create Role → fields → Create → the dialog closes. */
    async create(fields: RoleFields): Promise<void> {
        await this.openCreateDialog();
        await this.fillCreate(fields);
        const { status } = await this.submitCreate();
        expect(status, 'POST /api/v1/roles').toBeLessThan(300);
        await expect(this.createDialog).toBeHidden();
    }

    /** Close a dialog that stayed open after a refused submit. */
    async cancelDialog(dialog: Locator): Promise<void> {
        if (await dialog.isVisible()) {
            await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
            await expect(dialog).toBeHidden();
        }
    }

    async openEditDialog(): Promise<Locator> {
        await iconButton(this.detailsWidget, 'pencil').click();
        await expect(this.editDialog).toBeVisible();
        return this.editDialog;
    }

    /** Detail → Edit → change description / e-mail → Save → the dialog closes. */
    async edit(fields: { description?: string; email?: string }): Promise<void> {
        const dialog = await this.openEditDialog();
        // RoleForm resets its fields from the role detail whenever the detail refetch finishes (live run 2, REG-CFG-07.b: the typed
        // values were overwritten and the PUT carried the old ones). Wait for the stored values to be in the form, type, let the
        // network settle, and type again if the reset came after the first fill; the PUT is the proof of what was sent.
        await expect(dialog.getByTestId('text-input-name'), 'the form holds the stored role').not.toHaveValue('');
        const typed = async (): Promise<void> => {
            if (fields.description !== undefined) await fillText(dialog.getByTestId('text-input-description'), fields.description);
            if (fields.email !== undefined) await fillText(dialog.getByTestId('text-input-email'), fields.email);
        };
        await typed();
        await this.page.waitForLoadState('networkidle');
        const holds = async (): Promise<boolean> =>
            (fields.description === undefined || (await dialog.getByTestId('text-input-description').inputValue()) === fields.description)
            && (fields.email === undefined || (await dialog.getByTestId('text-input-email').inputValue()) === fields.email);
        if (!(await holds())) await typed();
        if (fields.description !== undefined) await expect(dialog.getByTestId('text-input-description')).toHaveValue(fields.description);
        if (fields.email !== undefined) await expect(dialog.getByTestId('text-input-email')).toHaveValue(fields.email);
        const answer = this.page.waitForResponse((r) => r.request().method() === 'PUT' && /\/api\/v1\/roles\/[0-9a-f-]{36}$/.test(new URL(r.url()).pathname));
        await submitButton(dialog).click();
        expect((await answer).status(), 'PUT /api/v1/roles/{uuid}').toBeLessThan(300);
        await expect(dialog).toBeHidden();
    }

    /** Detail → Delete → "Delete Role" → Delete; the page returns to the list. */
    async deleteFromDetail(): Promise<void> {
        await iconButton(this.detailsWidget, 'trash').click();
        const dialog = this.page.getByRole('dialog', { name: 'Delete Role' });
        await expect(dialog).toBeVisible();
        const answer = this.page.waitForResponse((r) => r.request().method() === 'DELETE' && /\/api\/v1\/roles\/[0-9a-f-]{36}$/.test(new URL(r.url()).pathname));
        await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
        expect((await answer).status(), 'DELETE /api/v1/roles/{uuid}').toBeLessThan(300);
        await expect(dialog).toBeHidden();
    }

    /** Type into the list's Search box (client-side filter over every page of the table). */
    async searchList(text: string): Promise<void> {
        const box = this.listWidget.getByRole('textbox', { name: 'Search' });
        await box.fill(text);
    }

    /** The list row (link) of a role name, after `searchList`. */
    rowLink(name: string): Locator {
        return this.listWidget.getByRole('link', { name, exact: true });
    }

    /** The refusal names the collision (REG-CFG-07.a): a danger toast that names the role and says it exists. */
    async assertDuplicateRefused(name: string): Promise<void> {
        const card = await assertToast(this.page, /Failed to create role/i, { severity: 'danger' });
        await expect(card, 'the message names the role').toContainText(name);
        await expect(card, 'the message says it already exists').toContainText(/already exists/i);
    }

    /** In the Edit Role dialog the name field is disabled (REG-CFG-07.b; RoleForm `disabled={editMode}`). */
    async assertNameLockedInEdit(name: string): Promise<void> {
        const dialog = this.editDialog;
        await expect(dialog.getByTestId('text-input-name')).toBeDisabled();
        await expect(dialog.getByTestId('text-input-name')).toHaveValue(name);
    }

    /** After a reload the Edit Role dialog shows the saved values (REG-CFG-07.b), then is cancelled. */
    async assertEdited(expected: { name: string; description: string; email: string }): Promise<void> {
        await this.page.reload();
        await expect(this.detailsWidget).toBeVisible();
        await expect(this.detailsWidget.locator('tr[data-id="roleName"]')).toContainText(expected.name);
        await expect(this.detailsWidget.locator('tr[data-id="description"]')).toContainText(expected.description);
        const dialog = await this.openEditDialog();
        await expect(dialog.getByTestId('text-input-description')).toHaveValue(expected.description);
        await expect(dialog.getByTestId('text-input-email')).toHaveValue(expected.email);
        await expect(dialog.getByTestId('text-input-name')).toHaveValue(expected.name);
        await this.cancelDialog(dialog);
    }

    /**
     * The roles list (searched by name) has no row of that name (REG-CFG-07.c). Absence needs a positive marker (phase-05
     * §6.1 rule 4): the list first shows its rows (every tier has system roles), so an empty, still-loading table cannot
     * pass for "gone". The list is read fresh (`goToFreshList`); `loadTimeout` is how long the rows may take to show.
     */
    async assertGone(name: string, opts: { loadTimeout?: number } = {}): Promise<void> {
        await this.goToFreshList();
        await expect(this.listWidget.locator('tbody tr a[href*="/detail/"]').first(), 'the roles list has loaded its rows').toBeVisible({ timeout: opts.loadTimeout ?? 30_000 });
        await this.searchList(name);
        await expect(this.rowLink(name)).toHaveCount(0);
        await this.searchList('');
    }

    /** The roles list (searched by name) shows that role. */
    async assertListed(name: string): Promise<void> {
        await this.goToList();
        await this.searchList(name);
        await expect(this.rowLink(name)).toHaveCount(1);
        await this.searchList('');
    }
}
