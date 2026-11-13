/**
 * PlatformSettingsPage — the Certificates tab of the platform settings and its edit dialog (Automatic Ownership).
 */
import { expect, Locator, Page } from '@playwright/test';
import { setSwitch } from './ui/form';
import { openHashRoute } from './ui/openHashRoute';

export class PlatformSettingsPage {
    readonly page: Page;

    // Certificates tab (read-only view)
    readonly certificatesTab: Locator;
    readonly automaticOwnershipSwitch: Locator;
    readonly editButton: Locator;

    // Edit Platform Settings dialog
    readonly editDialog: Locator;
    readonly editCertificatesTab: Locator;
    readonly editAutomaticOwnershipSwitch: Locator;
    readonly saveButton: Locator;

    constructor(page: Page) {
        this.page = page;

        this.certificatesTab = page.getByRole('tab', { name: 'Certificates' });
        this.automaticOwnershipSwitch = page.getByTestId('switch-uploadAutomaticOwnership-input');
        this.editButton = page.getByTestId('pencil-button');

        this.editDialog = page.getByRole('dialog', { name: 'Edit Platform Settings' });
        this.editCertificatesTab = this.editDialog.getByRole('tab', { name: 'Certificates' });
        this.editAutomaticOwnershipSwitch = this.editDialog.getByTestId('switch-automaticOwnership-input');
        this.saveButton = this.editDialog.getByRole('button', { name: 'Save', exact: true });
    }

    /** Opens the Certificates tab; on the same route it reloads, so the view shows what is stored. */
    async goToCertificates(): Promise<void> {
        await openHashRoute(this.page, 'settings?tab=certificates');
        await this.certificatesTab.click();
    }

    /** Saves the switch from the opposite stored value: the form is filled from the platform, so it is toggled only after it shows that value. */
    async saveAutomaticOwnership(on: boolean): Promise<void> {
        await this.goToCertificates();
        await this.editButton.click();
        await this.editCertificatesTab.click();
        await expect(this.editAutomaticOwnershipSwitch).toBeChecked({ checked: !on });
        await setSwitch(this.editDialog, this.editAutomaticOwnershipSwitch, on);
        await this.saveButton.click();
        await expect(this.editDialog).toBeHidden();
    }
}
