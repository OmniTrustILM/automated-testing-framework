/**
 * PlatformSettingsPage — the Certificates tab of the platform settings and its edit dialog (Automatic Ownership).
 */
import { expect, Locator, Page } from '@playwright/test';
import { setSwitch } from './ui/form';
import { openHashRoute } from './ui/openHashRoute';

const CERTIFICATES_ROUTE = 'settings?tab=certificates';

export class PlatformSettingsPage {
    readonly page: Page;

    // Certificates tab (read-only view)
    private readonly certificatesTab: Locator;
    readonly automaticOwnershipSwitch: Locator;
    private readonly editButton: Locator;

    // Edit Platform Settings dialog
    private readonly editDialog: Locator;
    private readonly editCertificatesTab: Locator;
    private readonly editAutomaticOwnershipSwitch: Locator;
    private readonly saveButton: Locator;

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

    /** The Certificates tab loaded anew, so the read-only view shows what the platform stored. */
    async showStored(): Promise<void> {
        await openHashRoute(this.page, CERTIFICATES_ROUTE);
        await this.page.reload();
        await this.certificatesTab.click();
    }

    /** Saves the switch from the opposite stored value: the form is filled from the platform, so it is toggled only after it shows that value. */
    async saveAutomaticOwnership(on: boolean): Promise<void> {
        await openHashRoute(this.page, CERTIFICATES_ROUTE);
        await this.certificatesTab.click();
        await this.editButton.click();
        await this.editCertificatesTab.click();
        await expect(this.editAutomaticOwnershipSwitch).toBeChecked({ checked: !on });
        await setSwitch(this.editDialog, this.editAutomaticOwnershipSwitch, on);
        await this.saveButton.click();
        await expect(this.editDialog).toBeHidden();
    }
}
