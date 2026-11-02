/**
 * AcmeProfilePage — Page Object Model for ACME profiles (REG-CFG-04).
 *
 * Encapsulates:
 *   - the ACME Profiles list and the profile detail with its Enable button
 *   - the Create ACME Profile dialog, including the Terms of Service and contact switches
 *
 * The create answer goes back to the spec before the dialog closes, so the profile is on the ledger first. The switches
 * are hidden inputs, set through `setSwitch`.
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
    /** The value of the first pre-authorized identifier row. */
    readonly identifierValueInput: Locator;
    readonly createButton: Locator;

    // ACME profile detail
    readonly enableButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        // ACME Profiles list
        this.addAcmeProfileButton = this.main.getByTestId('plus-button').first();

        // Create ACME Profile dialog
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

        // ACME profile detail
        this.enableButton = this.main.getByTestId('check-button').first();
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/acmeprofiles');
        await expect(this.main).toBeVisible();
    }

    /** The detail page of one ACME profile. */
    async goToDetail(uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/acmeprofiles/detail/${uuid}`);
        await expect(this.main).toBeVisible();
    }

    /** The list's "+" → the Create dialog is open. */
    async openCreateDialog(): Promise<void> {
        await this.addAcmeProfileButton.click();
        await expect(this.createAcmeProfileDialog).toBeVisible();
    }

    async fillName(name: string): Promise<void> {
        await fillText(this.nameInput, name);
    }

    /** The form offers a default retry interval and a default order validity. */
    async assertDefaultsOffered(): Promise<void> {
        await expect(this.retryIntervalInput, 'a default retry interval is offered').not.toHaveValue('');
        await expect(this.orderValidityInput, 'a default order validity is offered').not.toHaveValue('');
    }

    /** Switches the Terms of Service and the contact requirements off. */
    async switchOffRequirements(): Promise<void> {
        await setSwitch(this.createAcmeProfileDialog, this.requireTermsOfServiceSwitch, false);
        await setSwitch(this.createAcmeProfileDialog, this.requireContactSwitch, false);
    }

    /** Adds one pre-authorized identifier (type and match as the form defaults them) and types its value. */
    async addPreauthorizedIdentifier(value: string): Promise<void> {
        await this.addIdentifierButton.click();
        await expect(this.identifierRows).toHaveCount(1);
        await fillText(this.identifierValueInput, value);
    }

    /** Fills every required custom attribute the tier defines for ACME profiles (none: nothing). */
    async fillRequiredCustomAttributes(): Promise<void> {
        await fillRequiredCustomAttributes(this.page, this.createAcmeProfileDialog, 'qa-reg', await customAttributesDefined(this.page, 'acmeProfiles'));
    }

    /**
     * Clicks Create and returns the answer of `POST /api/v1/acmeProfiles` (status, new uuid, request body); the dialog is not waited for.
     */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createButton, { endpoint: '/api/v1/acmeProfiles' });
    }

    /** The Create dialog closes after a successful create. */
    async waitForCreateDialogClosed(): Promise<void> {
        await expect(this.createAcmeProfileDialog).toBeHidden({ timeout: LIST_STATE_MS });
    }

    /** The detail page shows the profile's name. */
    async assertDetailShows(name: string): Promise<void> {
        await expect(this.main).toContainText(name);
    }

    /** The detail's Enable button (the profile is created disabled). */
    async enable(): Promise<void> {
        await this.enableButton.click();
    }
}
