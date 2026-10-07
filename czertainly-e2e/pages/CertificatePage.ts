/**
 * CertificatePage — Page Object Model for the Certificates UI flow (SMK-004).
 *
 * Encapsulates:
 *   - Navigation to the Certificates list and detail pages
 *   - The "Issue New Certificate" modal flow (RA Profile + External CSR)
 *   - Tab assertions on the detail page (deep on Details/Request/History,
 *     shallow on the other 7 tabs)
 *
 * Locators that proved stable in SMK-003 (testids, ARIA roles) are reused;
 * unknowns are semantic getByRole/getByLabel — will be tightened up after
 * the first end-to-end run (Task 11) if any locator misses.
 */

import { Page, Locator, expect } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { Navigation } from './Navigation';

const logger = new Logger('CertificatePage');

export class CertificatePage {
    readonly page: Page;
    private readonly navigation: Navigation;

    // List page
    readonly main: Locator;
    readonly addCertificateButton: Locator;

    readonly uploadButton: Locator;
    readonly importModal: Locator;
    readonly importFileContent: Locator;
    readonly importDetectedContent: Locator;
    readonly importSubmitButton: Locator;
    readonly importResults: Locator;
    readonly importDoneButton: Locator;

    // Delete certificate from Details page
    readonly deleteButton: Locator;
    readonly deleteConfirmDialog: Locator;
    readonly deleteConfirmButton: Locator;

    // Issue page (separate URL: /certificates/add, not a modal)
    readonly requestTypeIssue: Locator;
    readonly raProfileTrigger: Locator;
    readonly keySourceTrigger: Locator;
    readonly csrTextarea: Locator;
    readonly submitButton: Locator;

    // Details page
    readonly tablist: Locator;

    // Attributes tab
    readonly customAttributeSelectTrigger: Locator;
    readonly saveCustomValueButton: Locator;


    constructor(page: Page) {
        this.page = page;
        this.navigation = new Navigation(page);

        this.main = page.locator('main');
        this.addCertificateButton = this.main.getByTestId('add-certificate-button');

        this.uploadButton = this.main.getByTestId('upload-button');
        this.importModal = page.getByRole('dialog', { name: 'Import certificates and keys' });
        this.importFileContent = this.importModal.getByRole('textbox', { name: 'File content' });
        this.importDetectedContent = this.importModal.getByRole('region', { name: /Detected content/ });
        this.importSubmitButton = this.importModal.getByRole('button', { name: /Import \d+ entr/ });
        this.importResults = this.importModal.getByRole('region', { name: 'Import results' });
        this.importDoneButton = this.importModal.getByRole('button', { name: 'Done', exact: true });

        this.deleteButton = this.main.getByTestId('trash-button');
        this.deleteConfirmDialog = page.getByRole('dialog').filter({ hasText: 'Delete Certificate' });
        this.deleteConfirmButton = this.deleteConfirmDialog.getByRole('button', { name: 'Delete', exact: true });


        this.requestTypeIssue = this.main.getByTestId('requestType-issue');
        this.raProfileTrigger = this.main.getByTestId('select-raProfile-trigger');
        this.keySourceTrigger = this.main.getByTestId('keySource-trigger');
        this.csrTextarea = this.main.locator('#__fileUpload__fileContent');
        this.submitButton = this.main.getByTestId('progress-button');

        this.tablist = page.getByRole('tablist');

        this.customAttributeSelectTrigger = this.main.getByTestId('select-selectCustomAttribute-trigger');
        this.saveCustomValueButton = this.main.getByTestId('save-custom-value');

    }

    async goToList(): Promise<void> {
        await this.navigation.openViaSidebar('Certificates', /\/certificates/i);
        await expect(this.main).toBeVisible();
    }

    async goToDetail(uuid: string): Promise<void> {
        logger.info(`Navigating to certificate detail: ${uuid}`);
        await this.page.goto(`/administrator/#/certificates/detail/${uuid}`);
        await expect(this.main).toBeVisible();
    }

    async openIssuePage(): Promise<void> {
        logger.info('Navigating to Issue Certificate page');
        await this.addCertificateButton.click();
        await expect(this.page).toHaveURL(/\/certificates\/add/);
    }

    async openImportModal(): Promise<void> {
        logger.info('Opening Import certificates and keys');
        await this.uploadButton.click();
        await expect(this.importModal).toBeVisible();
    }

    async pasteCertificatePem(pem: string): Promise<void> {
        logger.info('Pasting certificate PEM');
        await this.importFileContent.fill(pem);
        await expect(this.importDetectedContent).toBeVisible();
        await expect(this.importDetectedContent.getByRole('checkbox')).toBeChecked();
        await this.importFileContent.blur();
    }

    async importPastedCertificate(): Promise<void> {
        logger.info('Importing the detected certificate');
        await expect(this.importSubmitButton).toBeEnabled();
        await this.importSubmitButton.click();
        await expect(this.importResults).toBeVisible();
        await expect(this.importResults.getByTestId('badge')).toHaveText('Imported');
    }

    async closeImportModal(): Promise<void> {
        logger.info('Closing the import modal');
        await this.importDoneButton.click();
        await expect(this.importModal).not.toBeVisible();
    }

    async openCertificateFromList(commonName: string): Promise<void> {
        logger.info(`Opening certificate from the list: ${commonName}`);
        await this.main.getByRole('link', { name: commonName, exact: true }).click();
        await expect(this.page).toHaveURL(/\/certificates\/detail\//);
    }

    async assertUploadedCertificateDetails(commonName: string): Promise<void> {
        logger.info('Asserting uploaded certificate Details tab');
        await this.openTab('Details');
        await expect(this.main.locator('tr[data-id="commonName"]')).toContainText(commonName);
        const serial = (await this.main.locator('tr[data-id="serialNumber"]').locator('td').last().textContent())?.trim() ?? '';
        expect(serial, 'Serial Number should be non-empty').not.toBe('');
        const fingerprint = (await this.main.locator('tr[data-id="fingerprint"]').locator('td').last().textContent())?.trim() ?? '';
        expect(fingerprint, 'Fingerprint should be non-empty').not.toBe('');
        const stateRow = this.main.locator('tr[data-id="certState"]');
        await expect(stateRow.locator('[data-testid="certificate-status"]')).toHaveText('Issued');
        await expect(this.main.locator('tr[data-id="keySize"]')).toContainText('2048');
        await expect(this.main.locator('tr[data-id="subjectType"]')).toContainText('Self-signed End Entity');
    }

    async deleteFromDetail(): Promise<void> {
        logger.info('Deleting certificate from details page');
        await this.deleteButton.click();
        await expect(this.deleteConfirmDialog).toBeVisible();
        await this.deleteConfirmButton.click();
        await expect(this.deleteConfirmDialog).not.toBeVisible();
    }

    async selectRequestTypeIssue(): Promise<void> {
        logger.info('Selecting Request Type: Issue now');
        await this.requestTypeIssue.click();
    }

    async selectRaProfile(raProfileName: string): Promise<void> {
        logger.info(`Selecting RA Profile: ${raProfileName}`);
        await this.raProfileTrigger.click();
        const option = this.page.getByRole('option', { name: raProfileName, exact: true });
        await option.waitFor({ state: 'visible' });
        await option.click();
    }

    async selectKeySourceExternal(): Promise<void> {
        logger.info('Selecting Key Source: External key');
        await this.keySourceTrigger.click();
        const option = this.page.getByRole('option', { name: /external/i });
        await option.waitFor({ state: 'visible' });
        await option.click();
    }

    async pasteCsr(csrPem: string): Promise<void> {
        logger.info('Pasting CSR into form');
        await this.csrTextarea.scrollIntoViewIfNeeded();
        await this.csrTextarea.fill(csrPem);
    }

    async submitIssue(): Promise<string> {
        logger.info('Submitting Issue Certificate');
        await this.submitButton.click();
        await expect(this.page).toHaveURL(/\/certificates\/detail\/[a-f0-9-]+/);
        const url = this.page.url();
        const match = url.match(/\/certificates\/detail\/([a-f0-9-]+)/);
        if (!match) {
            throw new Error(`Could not extract certificate UUID from URL: ${url}`);
        }
        const certUuid = match[1];
        logger.info(`Issued certificate UUID: ${certUuid}`);
        return certUuid;
    }

    async openTab(tabName: string): Promise<void> {
        const tab = this.tablist.getByRole('tab', { name: tabName, exact: true });
        await tab.click();
    }

    async assertDetailsTab(expected: {
        commonName: string;
        raProfileName: string;
        ownerName: string;
    }): Promise<void> {
        logger.info('Asserting Details tab content');
        await this.openTab('Details');

        const commonNameRow = this.main.locator('tr[data-id="commonName"]');
        await expect(commonNameRow).toContainText(expected.commonName);

        const serialRow = this.main.locator('tr[data-id="serialNumber"]');
        const serial = (await serialRow.locator('td').last().textContent())?.trim() ?? '';
        expect(serial, 'Serial Number should be non-empty').not.toBe('');

        const fingerprintRow = this.main.locator('tr[data-id="fingerprint"]');
        const fingerprint = (await fingerprintRow.locator('td').last().textContent())?.trim() ?? '';
        expect(fingerprint, 'Fingerprint should be non-empty').not.toBe('');

        const stateRow = this.main.locator('tr[data-id="certState"]');
        await expect(stateRow.locator('[data-testid="certificate-status"]')).toHaveText('Issued');

        const keySizeRow = this.main.locator('tr[data-id="keySize"]');
        await expect(keySizeRow).toContainText('2048');

        await expect(this.main).toContainText(expected.raProfileName);
        await expect(this.main).toContainText(expected.ownerName);
    }

    async assertRequestTab(expected: { commonName: string }): Promise<void> {
        logger.info('Asserting Request tab content');
        await this.openTab('Request');

        const cnRow = this.main.locator('tr[data-id="commonName"]');
        await expect(cnRow).toContainText(expected.commonName);

        const formatRow = this.main.locator('tr[data-id="certificateRequestFormat"]');
        await expect(formatRow).toContainText('pkcs10');
    }

    async assertHistoryTabHasEntry(pattern: RegExp): Promise<void> {
        logger.info(`Asserting History tab has entry matching ${pattern}`);
        await this.openTab('History');
        const table = this.main.locator('table').first();
        await expect(table).toBeVisible();
        await expect(table).toContainText(pattern);
    }

    async verifyOtherTabsOpenWithoutError(tabs: string[]): Promise<void> {
        for (const tabName of tabs) {
            logger.info(`Opening tab (shallow check): ${tabName}`);
            const tab = this.tablist.getByRole('tab', { name: tabName, exact: true });
            if (!(await tab.isVisible())) {
                logger.warn(`Tab "${tabName}" not visible — skipping shallow check`);
                continue;
            }
            await tab.click();
            await expect(this.main).not.toContainText(/internal server error/i);
            await expect(this.main).not.toContainText(/unexpected error/i);
        }
    }

    async assignCustomAttributeValue(attributeName: string, value: string): Promise<void> {
        logger.info(`Assigning custom attribute "${attributeName}" with value "${value}"`);
        await this.customAttributeSelectTrigger.click();
        await this.page.getByRole('option', { name: attributeName, exact: true }).click();
        const valueInput = this.main.getByTestId(`text-input-${attributeName}`);
        await valueInput.click();
        await valueInput.fill(value);
        await this.saveCustomValueButton.click();
        // Wait for the row to appear in the Custom Attributes table
        const row = this.main.locator('tr').filter({ hasText: attributeName });
        await expect(row).toBeVisible();
    }

    async unassignCustomAttributeValue(attributeName: string): Promise<void> {
        logger.info(`Unassigning custom attribute value: ${attributeName}`);
        const row = this.main.locator('tr').filter({ hasText: attributeName });
        await row.getByTestId('delete-button').click();
        await expect(row).not.toBeVisible();
    }
}