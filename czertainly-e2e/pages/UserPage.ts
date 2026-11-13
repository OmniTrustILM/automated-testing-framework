/**
 * UserPage — the users list, detail and the Create / Edit / Delete User dialogs (REG-CFG-09).
 * `createUser` returns the create answer as soon as it arrives, so the spec writes the ledger line first. Edit and Delete are used only on
 * users this run created.
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
    readonly rolesTrigger: Locator;
    readonly rolesSearchInput: Locator;
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
    readonly editRequiredAttributeLabels: Locator;
    readonly saveButton: Locator;
    readonly cancelEditButton: Locator;

    // Delete User dialog
    readonly deleteUserDialog: Locator;
    readonly confirmDeleteButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.usersList = widgetTitled(this.main, 'List of Users');
        this.addUserButton = this.usersList.getByTestId('plus-button');
        this.searchInput = this.usersList.getByRole('textbox', { name: 'Search' });
        this.rowLinks = this.usersList.locator('tbody tr a[href*="/detail/"]');

        this.userDetails = widgetTitled(this.main, 'User Details');
        this.editUserButton = this.userDetails.getByTestId('pencil-button');
        this.deleteUserButton = this.userDetails.getByTestId('trash-button');
        this.usernameRow = this.userDetails.locator('tr[data-id="username"]');
        this.emailRow = this.userDetails.locator('tr[data-id="email"]');
        this.rolesRow = this.userDetails.locator('tr[data-id="roles"]');

        this.createUserDialog = page.getByRole('dialog', { name: 'Create User' });
        this.usernameInput = this.createUserDialog.getByTestId('text-input-username');
        this.firstNameInput = this.createUserDialog.getByTestId('text-input-firstName');
        this.lastNameInput = this.createUserDialog.getByTestId('text-input-lastName');
        this.emailInput = this.createUserDialog.getByTestId('text-input-email');
        this.enabledSwitch = this.createUserDialog.getByTestId('switch-enabled-input');
        this.rolesTrigger = this.createUserDialog.getByTestId('select-userRoles-trigger');
        this.rolesSearchInput = page.getByTestId('select-userRoles-search');
        this.createButton = this.createUserDialog.getByTestId('progress-button').last();

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

        this.deleteUserDialog = page.getByRole('dialog', { name: 'Delete User' });
        this.confirmDeleteButton = this.deleteUserDialog.getByRole('button', { name: 'Delete', exact: true });
    }

    userLink(username: string): Locator {
        return this.usersList.getByRole('link', { name: username, exact: true });
    }

    private roleOption(roleName: string): Locator {
        return this.page.getByRole('option').filter({ has: this.page.getByText(roleName, { exact: true }) });
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/users');
        await expect(this.usersList).toBeVisible();
    }

    /** A `goto` that only repeats the hash is no navigation, so the list is reloaded before the widget wait. */
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

    private async openCreateDialog(): Promise<void> {
        await this.addUserButton.click();
        await expect(this.createUserDialog).toBeVisible();
    }

    /** Picks the role in the searchable roles select (fe-administrator#2423); its chip shows the choice. */
    private async pickRole(roleName: string): Promise<void> {
        await this.rolesTrigger.click();
        await this.rolesSearchInput.fill(roleName);
        const option = this.roleOption(roleName);
        await expect(option).toHaveCount(1);
        await option.click();
        await this.page.keyboard.press('Escape');
        await expect(this.createUserDialog).toBeVisible();
        await expect(this.rolesTrigger.getByRole('button', { name: `Remove ${roleName}`, exact: true })).toBeVisible();
    }

    /**
     * Returns as soon as the create POST is answered, so the spec records
     * the user before the roles PATCH; `rolesStatus()` waits for that PATCH.
     */
    async createUser(fields: UserFields): Promise<CreateAnswer & { rolesStatus: () => Promise<number | undefined> }> {
        await this.openCreateDialog();
        await fillText(this.usernameInput, fields.username);
        await fillText(this.firstNameInput, fields.firstName ?? 'QA');
        await fillText(this.lastNameInput, fields.lastName ?? 'Regression');
        await fillText(this.emailInput, fields.email ?? `${fields.username}@example.test`);
        await expect(this.enabledSwitch).toBeChecked();
        await fillRequiredCustomAttributes(this.page, this.createUserDialog, 'qa-reg', await customAttributesDefined(this.page, 'users'));
        for (const r of fields.roleNames ?? []) await this.pickRole(r);
        const createCall = watchApiCall(this.page, { method: 'POST', path: /\/api\/v1\/users$/ });
        const rolesCall = (fields.roleNames ?? []).length
            ? watchApiCall(this.page, { method: 'PATCH', path: new RegExp(`/api/v1/users/${UUID}/roles$`) })
            : undefined;
        const startedAt = Date.now();
        await this.createButton.click();
        const answer = await createAnswerOf(await createCall, startedAt);
        return {
            ...answer,
            rolesStatus: async () => (rolesCall && answer.status < 300 ? (await rolesCall).status() : undefined),
        };
    }

    async openEditDialog(): Promise<void> {
        await this.editUserButton.click();
        await expect(this.editUserDialog).toBeVisible();
    }

    async closeEditDialog(): Promise<void> {
        await cancelIfOpen(this.editUserDialog, this.cancelEditButton);
    }

    /**
     * Waits until the custom-attribute editor holds the stored values: Save pressed too early sent `customAttributes: []`
     * and core answered 422. A tier without custom attributes for users has no editor to wait for.
     */
    async waitForCustomAttributeEditor(): Promise<void> {
        const dialog = this.editUserDialog;
        await expect(this.editDialogBusyOverlay).toHaveCount(0);
        if (!(await this.editCustomAttributesTab.isVisible())) return;
        if (!(await customAttributesDefined(this.page, 'users'))) return;
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

    /** UserForm resets its fields once the detail is loaded, so the form is waited for, typed into and read back before Save. */
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

    async deleteFromDetail(): Promise<ApiAnswer> {
        await this.deleteUserButton.click();
        await expect(this.deleteUserDialog).toBeVisible();
        return actAndReadAnswer(this.page, { method: 'DELETE', path: USER_PATH }, () => this.confirmDeleteButton.click());
    }

    async assertUsernameLockedInEdit(username: string): Promise<void> {
        await expect(this.editUsernameInput).toBeDisabled();
        await expect(this.editUsernameInput).toHaveValue(username);
    }

    /** Call it BEFORE opening a dialog: an open modal hides the page from the accessibility tree. */
    async assertDetailRows(expected: { username: string; email: string }): Promise<void> {
        await expect(this.usernameRow).toContainText(expected.username);
        await expect(this.emailRow).toContainText(expected.email);
    }

    async assertEditFormValues(expected: { username: string; firstName: string; lastName: string; email: string }): Promise<void> {
        await expect(this.editFirstNameInput).toHaveValue(expected.firstName);
        await expect(this.editLastNameInput).toHaveValue(expected.lastName);
        await expect(this.editEmailInput).toHaveValue(expected.email);
        await expect(this.editUsernameInput).toHaveValue(expected.username);
    }

    async assertRoles(names: string[]): Promise<void> {
        const text = (await this.rolesRow.locator('td').last().innerText()).trim();
        const shown = text ? text.split(/,\s*/).map((s) => s.trim()).sort() : [];
        expect(shown).toEqual([...names].sort());
    }

    /** Absence needs a positive marker first: the list shows rows (every tier has users), so an empty, still-loading table cannot pass. */
    async assertNotListed(username: string, options: { loadTimeout?: number } = {}): Promise<void> {
        await expect(this.rowLinks.first(), 'the list has loaded its rows').toBeVisible({ timeout: options.loadTimeout ?? 30_000 });
        await this.searchInput.fill(username);
        await expect(this.userLink(username)).toHaveCount(0);
        await this.searchInput.fill('');
    }
}
