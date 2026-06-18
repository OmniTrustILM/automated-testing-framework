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

    // Issue modal
    readonly modal: Locator;
    readonly raProfileTrigger: Locator;
    readonly keySourceTrigger: Locator;
    readonly csrTextarea: Locator;
    readonly submitButton: Locator;

    // Detail page
    readonly tablist: Locator;

    constructor(page: Page) {
        this.page = page;
        this.navigation = new Navigation(page);

        this.main = page.locator('main');
        this.addCertificateButton = this.main.getByTestId('plus-button');

        this.modal = page.locator('div[role="dialog"]').first();
        this.raProfileTrigger = this.modal.getByLabel(/RA Profile/i).first();
        this.keySourceTrigger = this.modal.getByLabel(/Key Source/i).first();
        this.csrTextarea = this.modal.getByLabel(/CSR|Certificate Signing Request/i).first();
        this.submitButton = this.modal.getByTestId('progress-button');

        this.tablist = page.getByRole('tablist');
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

    async openIssueModal(): Promise<void> {
        logger.info('Opening Issue Certificate modal');
        await this.addCertificateButton.click();
        await expect(this.modal).toBeVisible();
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
        expect(serial, 'Serial Number should be non-empty hex').toMatch(/^[0-9a-f]+$/i);

        const fingerprintRow = this.main.locator('tr[data-id="fingerprint"]');
        const fingerprint = (await fingerprintRow.locator('td').last().textContent())?.trim() ?? '';
        expect(fingerprint, 'Fingerprint should be non-empty').not.toBe('');

        const stateRow = this.main.locator('tr[data-id="state"]');
        await expect(stateRow.locator('[data-testid="badge"]')).toHaveText('Issued');

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
}
