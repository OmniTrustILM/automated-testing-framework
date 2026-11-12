/**
 * CertificatePage — the smoke suite's certificate page object.
 *
 * WHAT: the smoke suite's certificate page object: the list, the import dialog, the Issue-now fields and the
 *       Details / Request / History tabs (SMK-004, SMK-007, SMK-008).
 * WHY: the three smoke specs call these names; the regression suite uses `CertificateListPage`, `CertificateAddPage`,
 *       `CertificateDetailPage` and `ImportCertificatesDialog`, to which every method here delegates.
 * HOW: the list is opened through the sidebar because SMK-004 and SMK-007 navigate that way (SMK-002 uses
 *       Navigation directly); the methods that moved to the classes above delegate to them under their old names.
 */

import { Page, Locator, Response, expect } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { SanSet, sameSans } from '../utils/regression/pkiBuilders';
import { Navigation } from './Navigation';
import { CertificateAddPage } from './CertificateAddPage';
import { ImportCertificatesDialog } from './ImportCertificatesDialog';
import { chooseOption } from './ui/select';
import { widgetTitled } from './ui/widget';

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
    /** The import dialog's page object; the import methods below that the regression specs call delegate to it. */
    readonly importDialog: ImportCertificatesDialog;

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
        this.importDialog = new ImportCertificatesDialog(page);

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
        // The result badge has its own test id since fe-administrator#2274; it used to be the generic 'badge'.
        await expect(this.importResults.getByTestId('import-result-badge')).toHaveText('Imported');
    }

    /**
     * Click Import and return the platform's answer to the import call (`POST /api/v1/certificates/import`): its
     * `results[].certificateUuid` / `certificateOutcome` let a spec record what the import created before asserting
     * anything. The result badge is not checked here: `assertImportResult` does that.
     */
    async submitImport(): Promise<Response> {
        logger.info('Submitting the import');
        return this.importDialog.submitForResponse();
    }

    /** The import results region shows the given outcome badge (`Imported`, `Already in inventory`, …). */
    async assertImportResult(text: string): Promise<void> {
        await this.importDialog.assertResults([text]);
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
        await chooseOption(this.page, this.raProfileTrigger, raProfileName);
    }

    async selectKeySourceExternal(): Promise<void> {
        logger.info('Selecting Key Source: External key');
        await chooseOption(this.page, this.keySourceTrigger, /external/i);
    }

    async pasteCsr(csrPem: string): Promise<void> {
        logger.info('Pasting CSR into form');
        await this.csrTextarea.scrollIntoViewIfNeeded();
        await this.csrTextarea.fill(csrPem);
    }

    /**
     * Create on the Add Certificate form (the smoke spec's entry point). As the smoke suite expects, it waits for the
     * new certificate's detail page and FAILS when the "accepted with warnings" panel shows instead; a regression row that
     * accepts the panel passes `{ acceptWarnings: true }`.
     */
    async submitIssue(options: { acceptWarnings?: boolean } = {}): Promise<string> {
        return (await new CertificateAddPage(this.page).submitIssueFailingOnWarnings(options)).uuid;
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

    /**
     * The state badge and identity of an issued certificate on the Details tab: the common name row, the state label
     * `Issued` and the RA profile name. The caller reloads first: the detail page opened by Create does not poll.
     */
    async assertIssuedDetails(expected: { commonName: string; raProfileName: string }): Promise<void> {
        logger.info('Asserting the Details tab of an issued certificate');
        await this.openTab('Details');
        await expect(this.main.locator('tr[data-id="commonName"]')).toContainText(expected.commonName);
        await expect(this.main.locator('tr[data-id="certState"] [data-testid="certificate-status"]')).toHaveText('Issued');
        await expect(this.main).toContainText(expected.raProfileName);
    }

    /** The `Subject Alternative Names` widget of the Details tab (rows `tr[data-id=<SAN type>]`, values joined by ", "). */
    get sanWidget(): Locator {
        return widgetTitled(this.main, 'Subject Alternative Names');
    }

    /**
     * The DNS names and IP addresses the Details tab shows in its `Subject Alternative Names` widget (rows `dNSName` and
     * `iPAddress`; the frontend renders `subjectAlternativeNames` of the detail as one row per type, values joined by ", ").
     */
    async sanValues(): Promise<SanSet> {
        await this.openTab('Details');
        await expect(this.sanWidget).toBeVisible();
        const valuesOf = async (type: string): Promise<string[]> => {
            const row = this.sanWidget.locator(`tr[data-id="${type}"]`);
            if (!(await row.count())) return [];
            const text = (await row.locator('td').last().innerText()).trim();
            return text ? text.split(/,\s*/).map((v) => v.trim()).filter(Boolean) : [];
        };
        return { dns: await valuesOf('dNSName'), ip: await valuesOf('iPAddress') };
    }

    /**
     * The Details tab shows the expected SANs: `exact` = set equality of DNS and IP (no extras), `dns` = every expected
     * DNS name is shown (a CA whose template rewrites the SAN extension, the oracle on a CA other than EJBCA-NG).
     */
    async assertSans(expected: SanSet, mode: 'exact' | 'dns' = 'exact'): Promise<void> {
        const shown = await this.sanValues();
        logger.info(`SANs shown: ${shown.dns.length} DNS, ${shown.ip.length} IP (${mode})`);
        if (mode === 'exact') expect(sameSans(shown, expected), `Details SANs ${JSON.stringify(shown)} = ${JSON.stringify(expected)}`).toBe(true);
        else for (const d of expected.dns) expect(shown.dns.map((x) => x.toLowerCase()), `Details SANs include ${d}`).toContain(d.toLowerCase());
    }

    async assertHistoryTabHasEntry(pattern: RegExp): Promise<void> {
        logger.info(`Asserting History tab has entry matching ${pattern}`);
        await this.openTab('History');
        const table = this.main.locator('table').first();
        await expect(table).toBeVisible();
        await expect(table).toContainText(pattern);
    }

    /** Each listed tab that is shown opens without an error text (a tab that is not shown is skipped with a warning). */
    async assertTabsOpenWithoutError(tabs: string[]): Promise<void> {
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

    /** The former name of `assertTabsOpenWithoutError`; the smoke spec calls it. */
    async verifyOtherTabsOpenWithoutError(tabs: string[]): Promise<void> {
        await this.assertTabsOpenWithoutError(tabs);
    }

    async assignCustomAttributeValue(attributeName: string, value: string): Promise<void> {
        logger.info(`Assigning custom attribute "${attributeName}" with value "${value}"`);
        await chooseOption(this.page, this.customAttributeSelectTrigger, attributeName);
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