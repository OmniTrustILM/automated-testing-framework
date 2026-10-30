/**
 * CredentialPage — Page Object Model for credentials (REG-CFG-01).
 *
 * Encapsulates:
 *   - the Credentials list and the credential detail
 *   - the Create Credential dialog for a Basic credential
 *
 * The create answer goes back to the spec before the dialog closes, so the credential is on the ledger even when the list
 * never refreshes. The user name and password inputs are found by the suffix of their id, because the connector builds
 * the form.
 */
import { expect, Locator, Page } from '@playwright/test';
import { FormDialog } from './FormDialog';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { customAttributesDefined, fillRequiredCustomAttributes, fillText } from './ui/form';
import { chooseOption } from './ui/select';
import { dismissToasts, toast } from './ui/toast';
import { toolbarButton } from './ui/toolbar';

export interface BasicCredentialFields {
    name: string;
    /** The name of the credential connector the credential is stored on. */
    connectorName: string;
    username: string;
    password: string;
}

export class CredentialPage {
    readonly page: Page;
    readonly main: Locator;
    readonly createDialog: FormDialog;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.createDialog = new FormDialog(page, 'Create Credential');
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/credentials');
        await expect(this.main).toBeVisible();
    }

    /** The detail page of one credential. */
    async goToDetail(uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/credentials/detail/${uuid}`);
        await expect(this.main).toBeVisible();
    }

    /** The list's "+" → the Create Credential dialog is open. */
    async openCreateDialog(): Promise<void> {
        await toolbarButton(this.page, 'plus').click();
        await expect(this.createDialog.dialog).toBeVisible();
    }

    /** Fills the open dialog for the Basic kind (and any required custom attribute) without submitting. */
    async fillBasicForm(fields: BasicCredentialFields): Promise<void> {
        const dialog = this.createDialog.dialog;
        await fillText(this.createDialog.input('name'), fields.name);
        await chooseOption(this.page, this.page.getByTestId('select-credentialProviderSelect-trigger'), fields.connectorName);
        await chooseOption(this.page, this.page.getByTestId('select-storeKindSelect-trigger'), 'Basic');
        const username = dialog.locator('input[id$=".username"]');
        const password = dialog.locator('input[id$=".password"]');
        await expect(username).toBeVisible();
        await fillText(username, fields.username);
        await fillText(password, fields.password);
        await fillRequiredCustomAttributes(this.page, dialog, 'qa-reg', await customAttributesDefined(this.page, 'credentials'));
    }

    /**
     * Clicks Create and returns the answer of `POST /api/v1/credentials` (status, new uuid, request body); the redirect is not waited for.
     */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createDialog.dialog, { endpoint: '/api/v1/credentials' });
    }

    /** The detail page shows the credential's name. */
    async assertDetailShows(name: string): Promise<void> {
        await expect(this.main).toContainText(name);
    }

    /** The page shows `text` nowhere (the password of a credential is never shown). */
    async assertNotShown(text: string): Promise<void> {
        await expect(this.main).not.toContainText(text);
    }

    /** A refusal toast says that the name exists already. */
    async assertDuplicateNameRefused(): Promise<void> {
        await expect(toast(this.page, /already exist/i)).toBeVisible();
    }

    /** Clears the toasts and closes the dialog when a refused create left it open. */
    async closeCreateDialog(): Promise<void> {
        await dismissToasts(this.page);
        await this.createDialog.cancel();
    }
}
