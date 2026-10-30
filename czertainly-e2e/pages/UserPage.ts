/**
 * UserPage — Page Object Model for users (REG-CFG-09).
 *
 * Encapsulates:
 *   - the Users list and the user detail
 *   - the Create / Edit / Delete User dialogs
 *
 * Actions return the platform's answers; the spec asserts. `createUser` returns the create answer as soon as it arrives,
 * so the spec writes the ledger line before it waits for the roles request. Edit and Delete are used only on users this
 * run created.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
import { FormDialog } from './FormDialog';
import { SearchableListWidget } from './SearchableListWidget';
import { ApiAnswer } from '../utils/regression/apiReads';
import { CreateAnswer, createAnswerOf } from './ui/createAnswer';
import { entityScreens, type EntityScreens } from './ui/entityScreens';
import { customAttributeEditor, customAttributesDefined, fillRequiredCustomAttributes, fillText } from './ui/form';
import { actAndWaitForApi, answerFrom, UUID, watchApiCall } from './ui/waitForResponse';
import { FORM_READY_MS } from '../utils/regression/timeouts';

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
    /** The User Details widget. */
    readonly detailsWidget: Locator;
    private readonly screens: EntityScreens;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.screens = entityScreens(page, { route: 'users', listTitle: 'List of Users', detailTitle: 'User Details', caption: 'User' });
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
        logger.info(`Opening user ${uuid}`);
        await this.screens.goToDetail(uuid);
    }

    /** The list's "+" → the Create User dialog is open; returns it. */
    async openCreateDialog(): Promise<Locator> {
        return this.screens.openCreateDialog();
    }

    /**
     * Tick a role in the dialog's "Assigned User Roles" table: the row that has the role's name cell, then THAT row's
     * checkbox (CustomTable's row checkbox is a plain, visible `<input type=checkbox>`: no `force`, so a covered or
     * disabled box fails here instead of being clicked through).
     */
    private async tickRole(dialog: Locator, roleName: string): Promise<void> {
        const row = dialog.getByRole('row').filter({ has: this.page.getByRole('cell', { name: roleName, exact: true }) });
        await expect(row).toHaveCount(1);
        const box = row.getByRole('checkbox');
        await box.scrollIntoViewIfNeeded();
        await expect(box).toBeEnabled();
        await box.check();
        await expect(box).toBeChecked();
    }

    /**
     * Users → "+" → Create User → fields (+ required custom attributes) → roles → Create. Returns as soon as the create
     * POST is answered (`status`, `uuid`, `text`, like every create answer), so the spec records the user BEFORE the
     * roles PATCH the form sends after it; a slow PATCH can no longer lose the created user. `rolesStatus()` then waits
     * for that PATCH (undefined when no roles were ticked or the create was refused). It asserts nothing after the click.
     */
    async createUser(fields: UserFields): Promise<CreateAnswer & { rolesStatus: () => Promise<number | undefined> }> {
        const dialog = await this.openCreateDialog();
        await this.createDialog.fillTexts({
            username: fields.username,
            firstName: fields.firstName ?? 'QA',
            lastName: fields.lastName ?? 'Regression',
            email: fields.email ?? `${fields.username}@example.test`,
        });
        await expect(dialog.getByTestId('switch-enabled-input')).toBeChecked();
        await fillRequiredCustomAttributes(this.page, dialog, 'qa-reg', await customAttributesDefined(this.page, 'users'));
        for (const r of fields.roleNames ?? []) await this.tickRole(dialog, r);
        const createCall = watchApiCall(this.page, { method: 'POST', path: /\/api\/v1\/users$/ });
        const rolesCall = (fields.roleNames ?? []).length
            ? watchApiCall(this.page, { method: 'PATCH', path: new RegExp(`/api/v1/users/${UUID}/roles$`) })
            : undefined;
        rolesCall?.catch(() => undefined); // an unawaited wait that times out must not become an unhandled rejection
        const startedAt = Date.now();
        await this.createDialog.submitButton.click();
        const answer = await createAnswerOf(await createCall, startedAt);
        return {
            ...answer,
            rolesStatus: async () => (rolesCall && answer.status < 300 ? (await rolesCall).status() : undefined),
        };
    }

    /** The detail's pencil → the Edit User dialog is open; returns it. */
    async openEditDialog(): Promise<Locator> {
        return this.screens.openEditDialog();
    }

    /**
     * Waits until the dialog's custom-attribute editor holds the stored values (seen on a live tier: Save pressed about 240 ms
     * after the dialog opened sent `customAttributes: []` and core answered 422 "Content for required Custom attribute
     * ... is not provided").
     * The busy overlay is gone, the "Custom attributes" tab (when the tier has custom attributes) shows its editor, and every
     * REQUIRED list attribute shows a value (not the "Select ..." placeholder); then the tab that was active is selected again.
     * If a required value stays empty after the wait, the form did not take it from the user: unexpected behaviour (the error says so).
     * A tier that defines no custom attributes for users (read from the definitions of the Users resource, a session read) has
     * no editor: the tab is always shown, but the "Show custom attribute" select exists only when there are definitions to
     * offer, so there is nothing to wait for and the method returns once the busy overlay is gone.
     */
    async waitForCustomAttributeEditor(dialog: Locator): Promise<void> {
        await expect(dialog.getByTestId('widget-busy-overlay')).toHaveCount(0);
        const tab = dialog.getByRole('tab', { name: /^Custom attributes$/i }).first();
        if (!(await tab.isVisible())) return;
        if (!(await customAttributesDefined(this.page, 'users'))) return;
        const active = dialog.getByRole('tab', { selected: true }).first();
        // No selected tab is fine: then no tab is re-selected afterwards, so a failed read is ignored.
        const activeName = ((await active.textContent().catch(() => '')) ?? '').trim();
        await tab.click();
        await expect(customAttributeEditor(dialog), 'the custom attribute editor is rendered').toBeAttached();
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
        }).toPass({ timeout: FORM_READY_MS });
        if (activeName && !/^Custom attributes$/i.test(activeName)) await dialog.getByRole('tab', { name: activeName, exact: true }).click();
    }

    /**
     * Detail → Edit → change names / e-mail → Save; returns the answer of `PUT /api/v1/users/{uuid}` and the body the form sent.
     * UserForm resets its fields in an effect that runs once the user detail is loaded, and its Widget shows the spinner (`busy`)
     * while that fetch or any other of the form runs: when the detail answer is in and the spinner is gone, the reset has happened.
     * Typing earlier would be overwritten by the stored values, so the form is waited for, typed into, and read back before Save.
     */
    async editUser(fields: { firstName?: string; lastName?: string; email?: string }): Promise<ApiAnswer & { sent: Record<string, unknown> }> {
        const form = this.editDialog;
        const refetch = await actAndWaitForApi(this.page, { method: 'GET', path: new RegExp(`/api/v1/users/${UUID}$`) }, () => this.openEditDialog());
        const stored = (await refetch.json()) as { firstName?: string | null; lastName?: string | null; email?: string | null };
        const dialog = form.dialog;
        await expect(dialog.getByTestId('spinner'), 'the user form has finished loading').toHaveCount(0);
        await expect(form.input('firstName'), 'the form shows the stored first name').toHaveValue(stored.firstName ?? '');
        await expect(form.input('lastName'), 'the form shows the stored last name').toHaveValue(stored.lastName ?? '');
        await expect(form.input('email'), 'the form shows the stored e-mail').toHaveValue(stored.email ?? '');
        await this.waitForCustomAttributeEditor(dialog);
        for (const field of ['firstName', 'lastName', 'email'] as const) {
            if (fields[field] !== undefined) await fillText(form.input(field), fields[field]!);
        }
        for (const field of ['firstName', 'lastName', 'email'] as const) {
            if (fields[field] !== undefined) await expect(form.input(field), `${field} still holds the typed value before Save`).toHaveValue(fields[field]!);
        }
        const startedAt = Date.now();
        const response = await actAndWaitForApi(this.page, { method: 'PUT', path: new RegExp(`/api/v1/users/${UUID}$`) }, () => form.submitButton.click());
        const sent = (response.request().postDataJSON() ?? {}) as Record<string, unknown>;
        return { ...(await answerFrom(response, startedAt)), sent };
    }

    /** Detail → Delete → "Delete User" → Delete; returns the answer of `DELETE /api/v1/users/{uuid}`. */
    async deleteFromDetail(): Promise<ApiAnswer> {
        return this.screens.deleteFromDetail({ method: 'DELETE', path: new RegExp(`/api/v1/users/${UUID}$`) });
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
    async assertNotListed(username: string, options: { loadTimeout?: number } = {}): Promise<void> {
        await this.screens.assertNotListed(username, options);
    }
}
