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
import { toolbarButton } from './ui/toolbar';
import { LIST_STATE_MS } from '../utils/regression/timeouts';

export class AcmeProfilePage {
    readonly page: Page;
    readonly main: Locator;
    readonly createDialog: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.createDialog = page.getByRole('dialog').last();
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
        await toolbarButton(this.page, 'plus').click();
        await expect(this.createDialog).toBeVisible();
    }

    async fillName(name: string): Promise<void> {
        await fillText(this.createDialog.getByTestId('text-input-name'), name);
    }

    /** The form offers a default retry interval and a default order validity. */
    async assertDefaultsOffered(): Promise<void> {
        await expect(this.createDialog.getByTestId('text-input-retryInterval'), 'a default retry interval is offered').not.toHaveValue('');
        await expect(this.createDialog.getByTestId('text-input-orderValidity'), 'a default order validity is offered').not.toHaveValue('');
    }

    /** Switches the Terms of Service and the contact requirements off. */
    async switchOffRequirements(): Promise<void> {
        for (const id of ['requireTermsOfService', 'requireContact']) await setSwitch(this.createDialog, this.createDialog.locator(`[id="${id}"]`), false);
    }

    /** Adds one pre-authorized identifier (type and match as the form defaults them) and types its value. */
    async addPreauthorizedIdentifier(value: string): Promise<void> {
        await this.createDialog.getByTestId('add-identifier').click();
        await expect(this.createDialog.getByTestId('identifier-row')).toHaveCount(1);
        await fillText(this.createDialog.getByTestId('identifier-0-value'), value);
    }

    /** Fills every required custom attribute the tier defines for ACME profiles (none: nothing). */
    async fillRequiredCustomAttributes(): Promise<void> {
        await fillRequiredCustomAttributes(this.page, this.createDialog, 'qa-reg', await customAttributesDefined(this.page, 'acmeProfiles'));
    }

    /**
     * Clicks Create and returns the answer of `POST /api/v1/acmeProfiles` (status, new uuid, request body); the dialog is not waited for.
     */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createDialog, { endpoint: '/api/v1/acmeProfiles' });
    }

    /** The Create dialog closes after a successful create. */
    async waitForCreateDialogClosed(): Promise<void> {
        await expect(this.createDialog).toBeHidden({ timeout: LIST_STATE_MS });
    }

    /** The detail page shows the profile's name. */
    async assertDetailShows(name: string): Promise<void> {
        await expect(this.main).toContainText(name);
    }

    /** The detail's Enable button (the profile is created disabled). */
    async enable(): Promise<void> {
        await toolbarButton(this.page, 'check').click();
    }
}
