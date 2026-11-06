/**
 * AcmeProfilePage — the ACME profiles list, detail and Create dialog (REG-CFG-04).
 * The switches are hidden inputs, set through `setSwitch`.
 */
import { expect, Locator, Page } from '@playwright/test';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { customAttributesDefined, fillRequiredCustomAttributes, fillText, setSwitch } from './ui/form';
import { LIST_STATE_MS } from '../utils/regression/timeouts';

export class AcmeProfilePage {
    readonly page: Page;
    readonly main: Locator;

    // ACME Profiles list
    readonly addAcmeProfileButton: Locator;

    // Create ACME Profile dialog
    readonly createAcmeProfileDialog: Locator;
    readonly nameInput: Locator;
    readonly retryIntervalInput: Locator;
    readonly orderValidityInput: Locator;
    readonly requireTermsOfServiceSwitch: Locator;
    readonly requireContactSwitch: Locator;
    readonly addIdentifierButton: Locator;
    readonly identifierRows: Locator;
    readonly identifierValueInput: Locator;
    readonly createButton: Locator;

    // ACME profile detail
    readonly enableButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.addAcmeProfileButton = this.main.getByTestId('plus-button').first();

        this.createAcmeProfileDialog = page.getByRole('dialog').last();
        this.nameInput = this.createAcmeProfileDialog.getByTestId('text-input-name');
        this.retryIntervalInput = this.createAcmeProfileDialog.getByTestId('text-input-retryInterval');
        this.orderValidityInput = this.createAcmeProfileDialog.getByTestId('text-input-orderValidity');
        this.requireTermsOfServiceSwitch = this.createAcmeProfileDialog.locator('[id="requireTermsOfService"]');
        this.requireContactSwitch = this.createAcmeProfileDialog.locator('[id="requireContact"]');
        this.addIdentifierButton = this.createAcmeProfileDialog.getByTestId('add-identifier');
        this.identifierRows = this.createAcmeProfileDialog.getByTestId('identifier-row');
        this.identifierValueInput = this.createAcmeProfileDialog.getByTestId('identifier-0-value');
        this.createButton = this.createAcmeProfileDialog.getByTestId('progress-button').last();

        this.enableButton = this.main.getByTestId('check-button').first();
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/acmeprofiles');
        await expect(this.main).toBeVisible();
    }

    async goToDetail(uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/acmeprofiles/detail/${uuid}`);
        await expect(this.main).toBeVisible();
    }

    async openCreateDialog(): Promise<void> {
        await this.addAcmeProfileButton.click();
        await expect(this.createAcmeProfileDialog).toBeVisible();
    }

    async fillName(name: string): Promise<void> {
        await fillText(this.nameInput, name);
    }

    async assertDefaultsOffered(): Promise<void> {
        await expect(this.retryIntervalInput, 'a default retry interval is offered').not.toHaveValue('');
        await expect(this.orderValidityInput, 'a default order validity is offered').not.toHaveValue('');
    }

    async switchOffRequirements(): Promise<void> {
        await setSwitch(this.createAcmeProfileDialog, this.requireTermsOfServiceSwitch, false);
        await setSwitch(this.createAcmeProfileDialog, this.requireContactSwitch, false);
    }

    async addPreauthorizedIdentifier(value: string): Promise<void> {
        await this.addIdentifierButton.click();
        await expect(this.identifierRows).toHaveCount(1);
        await fillText(this.identifierValueInput, value);
    }

    async fillRequiredCustomAttributes(): Promise<void> {
        await fillRequiredCustomAttributes(this.page, this.createAcmeProfileDialog, 'qa-reg', await customAttributesDefined(this.page, 'acmeProfiles'));
    }

    /** Clicks Create and returns the create answer; the dialog is not waited for. */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createButton, { endpoint: '/api/v1/acmeProfiles' });
    }

    async waitForCreateDialogClosed(): Promise<void> {
        await expect(this.createAcmeProfileDialog).toBeHidden({ timeout: LIST_STATE_MS });
    }

    async assertDetailShows(name: string): Promise<void> {
        await expect(this.main).toContainText(name);
    }

    async enable(): Promise<void> {
        await this.enableButton.click();
    }
}
