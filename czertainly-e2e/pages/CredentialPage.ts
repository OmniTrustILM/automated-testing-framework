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
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { cancelIfOpen, customAttributesDefined, fillRequiredCustomAttributes, fillText } from './ui/form';
import { chooseOption } from './ui/select';
import { dismissToasts, toast } from './ui/toast';

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

    // Credentials list
    readonly addCredentialButton: Locator;

    // Create Credential dialog
    readonly createCredentialDialog: Locator;
    readonly nameInput: Locator;
    readonly connectorTrigger: Locator;
    readonly kindTrigger: Locator;
    readonly usernameInput: Locator;
    readonly passwordInput: Locator;
    readonly createButton: Locator;
    readonly cancelButton: Locator;

    // Toasts
    readonly nameExistsToast: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        // Credentials list
        this.addCredentialButton = this.main.getByTestId('plus-button').first();

        // Create Credential dialog
        this.createCredentialDialog = page.getByRole('dialog', { name: 'Create Credential' });
        this.nameInput = this.createCredentialDialog.getByTestId('text-input-name');
        this.connectorTrigger = page.getByTestId('select-credentialProviderSelect-trigger');
        this.kindTrigger = page.getByTestId('select-storeKindSelect-trigger');
        this.usernameInput = this.createCredentialDialog.locator('input[id$=".username"]');
        this.passwordInput = this.createCredentialDialog.locator('input[id$=".password"]');
        this.createButton = this.createCredentialDialog.getByTestId('progress-button').last();
        this.cancelButton = this.createCredentialDialog.getByRole('button', { name: 'Cancel', exact: true });

        // Toasts
        this.nameExistsToast = toast(page, /already exist/i);
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
        await this.addCredentialButton.click();
        await expect(this.createCredentialDialog).toBeVisible();
    }

    /** Fills the open dialog for the Basic kind (and any required custom attribute) without submitting. */
    async fillBasicForm(fields: BasicCredentialFields): Promise<void> {
        await fillText(this.nameInput, fields.name);
        await chooseOption(this.page, this.connectorTrigger, fields.connectorName);
        await chooseOption(this.page, this.kindTrigger, 'Basic');
        await expect(this.usernameInput).toBeVisible();
        await fillText(this.usernameInput, fields.username);
        await fillText(this.passwordInput, fields.password);
        await fillRequiredCustomAttributes(this.page, this.createCredentialDialog, 'qa-reg', await customAttributesDefined(this.page, 'credentials'));
    }

    /**
     * Clicks Create and returns the answer of `POST /api/v1/credentials` (status, new uuid, request body); the redirect is not waited for.
     */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createButton, { endpoint: '/api/v1/credentials' });
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
        await expect(this.nameExistsToast).toBeVisible();
    }

    /** Clears the toasts and closes the dialog when a refused create left it open. */
    async closeCreateDialog(): Promise<void> {
        await dismissToasts(this.page);
        await cancelIfOpen(this.createCredentialDialog, this.cancelButton);
    }
}
