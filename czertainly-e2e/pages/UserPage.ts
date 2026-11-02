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
import { ApiAnswer } from '../utils/regression/apiReads';
import { CreateAnswer, createAnswerOf } from './ui/createAnswer';
import { cancelIfOpen, customAttributeEditor, customAttributesDefined, fillRequiredCustomAttributes, fillText } from './ui/form';
import { widgetTitled } from './ui/widget';
import { actAndReadAnswer, actAndWaitForApi, answerFrom, UUID, watchApiCall } from './ui/waitForResponse';
import { FORM_READY_MS } from '../utils/regression/timeouts';

const logger = new Logger('UserPage');

/** `GET`, `PUT` and `DELETE` of one user. */
const USER_PATH = new RegExp(`/api/v1/users/${UUID}$`);

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

    // List of Users
    readonly usersList: Locator;
    readonly addUserButton: Locator;
    readonly searchInput: Locator;
    readonly rowLinks: Locator;

    // User Details
    readonly userDetails: Locator;
    readonly editUserButton: Locator;
    readonly deleteUserButton: Locator;
    readonly usernameRow: Locator;
    readonly emailRow: Locator;
    readonly rolesRow: Locator;

    // Create User dialog
    readonly createUserDialog: Locator;
    readonly usernameInput: Locator;
    readonly firstNameInput: Locator;
    readonly lastNameInput: Locator;
    readonly emailInput: Locator;
    readonly enabledSwitch: Locator;
    readonly createButton: Locator;

    // Edit User dialog
    readonly editUserDialog: Locator;
    readonly editDialogSpinner: Locator;
    readonly editDialogBusyOverlay: Locator;
    readonly editUsernameInput: Locator;
    readonly editFirstNameInput: Locator;
    readonly editLastNameInput: Locator;
    readonly editEmailInput: Locator;
    readonly editCustomAttributesTab: Locator;
    readonly editSelectedTab: Locator;
    /** The labels of the required custom attributes (their text ends with the asterisk). */
    readonly editRequiredAttributeLabels: Locator;
    readonly saveButton: Locator;
    readonly cancelEditButton: Locator;

    // Delete User dialog
    readonly deleteUserDialog: Locator;
    readonly confirmDeleteButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        // List of Users
        this.usersList = widgetTitled(this.main, 'List of Users');
        this.addUserButton = this.usersList.getByTestId('plus-button');
        this.searchInput = this.usersList.getByRole('textbox', { name: 'Search' });
        this.rowLinks = this.usersList.locator('tbody tr a[href*="/detail/"]');

        // User Details
        this.userDetails = widgetTitled(this.main, 'User Details');
        this.editUserButton = this.userDetails.getByTestId('pencil-button');
        this.deleteUserButton = this.userDetails.getByTestId('trash-button');
        this.usernameRow = this.userDetails.locator('tr[data-id="username"]');
        this.emailRow = this.userDetails.locator('tr[data-id="email"]');
        this.rolesRow = this.userDetails.locator('tr[data-id="roles"]');

        // Create User dialog
        this.createUserDialog = page.getByRole('dialog', { name: 'Create User' });
        this.usernameInput = this.createUserDialog.getByTestId('text-input-username');
        this.firstNameInput = this.createUserDialog.getByTestId('text-input-firstName');
        this.lastNameInput = this.createUserDialog.getByTestId('text-input-lastName');
        this.emailInput = this.createUserDialog.getByTestId('text-input-email');
        this.enabledSwitch = this.createUserDialog.getByTestId('switch-enabled-input');
        this.createButton = this.createUserDialog.getByTestId('progress-button').last();

        // Edit User dialog
        this.editUserDialog = page.getByRole('dialog', { name: 'Edit User' });
        this.editDialogSpinner = this.editUserDialog.getByTestId('spinner');
        this.editDialogBusyOverlay = this.editUserDialog.getByTestId('widget-busy-overlay');
        this.editUsernameInput = this.editUserDialog.getByTestId('text-input-username');
        this.editFirstNameInput = this.editUserDialog.getByTestId('text-input-firstName');
        this.editLastNameInput = this.editUserDialog.getByTestId('text-input-lastName');
        this.editEmailInput = this.editUserDialog.getByTestId('text-input-email');
        this.editCustomAttributesTab = this.editUserDialog.getByRole('tab', { name: /^Custom attributes$/i }).first();
        this.editSelectedTab = this.editUserDialog.getByRole('tab', { selected: true }).first();
        this.editRequiredAttributeLabels = this.editUserDialog.locator('label[for^="__attributes__custom"]').filter({ hasText: /\*\s*$/ });
        this.saveButton = this.editUserDialog.getByTestId('progress-button').last();
        this.cancelEditButton = this.editUserDialog.getByRole('button', { name: 'Cancel', exact: true });

        // Delete User dialog
        this.deleteUserDialog = page.getByRole('dialog', { name: 'Delete User' });
        this.confirmDeleteButton = this.deleteUserDialog.getByRole('button', { name: 'Delete', exact: true });
    }

    /** The link of a user in the list (exact username). */
    userLink(username: string): Locator {
        return this.usersList.getByRole('link', { name: username, exact: true });
    }

    /** The row of a role in the Create User dialog's "Assigned User Roles" table: the row that has the role's name cell. */
    roleRow(roleName: string): Locator {
        return this.createUserDialog.getByRole('row').filter({ has: this.page.getByRole('cell', { name: roleName, exact: true }) });
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/users');
        await expect(this.usersList).toBeVisible();
    }

    /**
     * The list as the server serves it NOW: the hash route, a reload, and only then the widget wait (a `goto` that only repeats
     * the hash is no navigation, so waiting first would judge the old render).
     */
    async reloadList(): Promise<void> {
        await this.page.goto('/administrator/#/users');
        await this.page.reload();
        await expect(this.usersList).toBeVisible();
    }

    async goToDetail(uuid: string): Promise<void> {
        logger.info(`Opening user ${uuid}`);
        await this.page.goto(`/administrator/#/users/detail/${uuid}`);
        await expect(this.userDetails).toBeVisible();
    }

    /** The list's "+" → the Create User dialog is open. */
    private async openCreateDialog(): Promise<void> {
        await this.addUserButton.click();
        await expect(this.createUserDialog).toBeVisible();
    }

    /**
     * Tick a role in the dialog's "Assigned User Roles" table: the row that has the role's name cell, then THAT row's
     * checkbox (CustomTable's row checkbox is a plain, visible `<input type=checkbox>`: no `force`, so a covered or
     * disabled box fails here instead of being clicked through).
     */
    private async tickRole(roleName: string): Promise<void> {
        const row = this.roleRow(roleName);
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
        await this.openCreateDialog();
        await fillText(this.usernameInput, fields.username);
        await fillText(this.firstNameInput, fields.firstName ?? 'QA');
        await fillText(this.lastNameInput, fields.lastName ?? 'Regression');
        await fillText(this.emailInput, fields.email ?? `${fields.username}@example.test`);
        await expect(this.enabledSwitch).toBeChecked();
        await fillRequiredCustomAttributes(this.page, this.createUserDialog, 'qa-reg', await customAttributesDefined(this.page, 'users'));
        for (const r of fields.roleNames ?? []) await this.tickRole(r);
        const createCall = watchApiCall(this.page, { method: 'POST', path: /\/api\/v1\/users$/ });
        const rolesCall = (fields.roleNames ?? []).length
            ? watchApiCall(this.page, { method: 'PATCH', path: new RegExp(`/api/v1/users/${UUID}/roles$`) })
            : undefined;
        rolesCall?.catch(() => undefined); // an unawaited wait that times out must not become an unhandled rejection
        const startedAt = Date.now();
        await this.createButton.click();
        const answer = await createAnswerOf(await createCall, startedAt);
        return {
            ...answer,
            rolesStatus: async () => (rolesCall && answer.status < 300 ? (await rolesCall).status() : undefined),
        };
    }

    /** The detail's pencil → the Edit User dialog is open. */
    async openEditDialog(): Promise<void> {
        await this.editUserButton.click();
        await expect(this.editUserDialog).toBeVisible();
    }

    /** Closes the Edit User dialog with Cancel when it is still open. */
    async closeEditDialog(): Promise<void> {
        await cancelIfOpen(this.editUserDialog, this.cancelEditButton);
    }

    /**
     * Waits until the Edit User dialog's custom-attribute editor holds the stored values (seen on a live tier: Save pressed about
     * 240 ms after the dialog opened sent `customAttributes: []` and core answered 422 "Content for required Custom attribute
     * ... is not provided").
     * The busy overlay is gone, the "Custom attributes" tab (when the tier has custom attributes) shows its editor, and every
     * REQUIRED list attribute shows a value (not the "Select ..." placeholder); then the tab that was active is selected again.
     * If a required value stays empty after the wait, the form did not take it from the user: unexpected behaviour (the error says so).
     * A tier that defines no custom attributes for users (read from the definitions of the Users resource, a session read) has
     * no editor: the tab is always shown, but the "Show custom attribute" select exists only when there are definitions to
     * offer, so there is nothing to wait for and the method returns once the busy overlay is gone.
     */
    async waitForCustomAttributeEditor(): Promise<void> {
        const dialog = this.editUserDialog;
        await expect(this.editDialogBusyOverlay).toHaveCount(0);
        if (!(await this.editCustomAttributesTab.isVisible())) return;
        if (!(await customAttributesDefined(this.page, 'users'))) return;
        // No selected tab is fine: then no tab is re-selected afterwards, so a failed read is ignored.
        const activeName = ((await this.editSelectedTab.textContent().catch(() => '')) ?? '').trim();
        await this.editCustomAttributesTab.click();
        await expect(customAttributeEditor(dialog), 'the custom attribute editor is rendered').toBeAttached();
        await expect(async () => {
            for (const label of await this.editRequiredAttributeLabels.all()) {
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
        const inputs = { firstName: this.editFirstNameInput, lastName: this.editLastNameInput, email: this.editEmailInput };
        const refetch = await actAndWaitForApi(this.page, { method: 'GET', path: USER_PATH }, () => this.openEditDialog());
        const stored = (await refetch.json()) as { firstName?: string | null; lastName?: string | null; email?: string | null };
        await expect(this.editDialogSpinner, 'the user form has finished loading').toHaveCount(0);
        await expect(this.editFirstNameInput, 'the form shows the stored first name').toHaveValue(stored.firstName ?? '');
        await expect(this.editLastNameInput, 'the form shows the stored last name').toHaveValue(stored.lastName ?? '');
        await expect(this.editEmailInput, 'the form shows the stored e-mail').toHaveValue(stored.email ?? '');
        await this.waitForCustomAttributeEditor();
        for (const field of ['firstName', 'lastName', 'email'] as const) {
            if (fields[field] !== undefined) await fillText(inputs[field], fields[field]!);
        }
        for (const field of ['firstName', 'lastName', 'email'] as const) {
            if (fields[field] !== undefined) await expect(inputs[field], `${field} still holds the typed value before Save`).toHaveValue(fields[field]!);
        }
        const startedAt = Date.now();
        const response = await actAndWaitForApi(this.page, { method: 'PUT', path: USER_PATH }, () => this.saveButton.click());
        const sent = (response.request().postDataJSON() ?? {}) as Record<string, unknown>;
        return { ...(await answerFrom(response, startedAt)), sent };
    }

    /** Detail → Delete → "Delete User" → Delete; returns the answer of `DELETE /api/v1/users/{uuid}`. */
    async deleteFromDetail(): Promise<ApiAnswer> {
        await this.deleteUserButton.click();
        await expect(this.deleteUserDialog).toBeVisible();
        return actAndReadAnswer(this.page, { method: 'DELETE', path: USER_PATH }, () => this.confirmDeleteButton.click());
    }

    /** In the Edit User dialog the username field is disabled and shows the username. */
    async assertUsernameLockedInEdit(username: string): Promise<void> {
        await expect(this.editUsernameInput).toBeDisabled();
        await expect(this.editUsernameInput).toHaveValue(username);
    }

    /**
     * The detail rows show the saved values. Call it BEFORE opening a dialog: an open modal hides the page from the
     * accessibility tree, and the widget is found by its heading's role.
     */
    async assertDetailRows(expected: { username: string; email: string }): Promise<void> {
        await expect(this.usernameRow).toContainText(expected.username);
        await expect(this.emailRow).toContainText(expected.email);
    }

    /** The open Edit User dialog shows the saved values. */
    async assertEditFormValues(expected: { username: string; firstName: string; lastName: string; email: string }): Promise<void> {
        await expect(this.editFirstNameInput).toHaveValue(expected.firstName);
        await expect(this.editLastNameInput).toHaveValue(expected.lastName);
        await expect(this.editEmailInput).toHaveValue(expected.email);
        await expect(this.editUsernameInput).toHaveValue(expected.username);
    }

    /** The detail's Roles row lists exactly these role names (order-insensitive). */
    async assertRoles(names: string[]): Promise<void> {
        const text = (await this.rolesRow.locator('td').last().innerText()).trim();
        const shown = text ? text.split(/,\s*/).map((s) => s.trim()).sort() : [];
        expect(shown).toEqual([...names].sort());
    }

    /**
     * Searched by username, the users list has no row of that name. Absence needs a positive marker first: the list shows rows
     * (every tier has users), so an empty, still-loading table cannot pass for "not listed". The search box is cleared afterwards.
     */
    async assertNotListed(username: string, options: { loadTimeout?: number } = {}): Promise<void> {
        await expect(this.rowLinks.first(), 'the list has loaded its rows').toBeVisible({ timeout: options.loadTimeout ?? 30_000 });
        await this.searchInput.fill(username);
        await expect(this.userLink(username)).toHaveCount(0);
        await this.searchInput.fill('');
    }
}
