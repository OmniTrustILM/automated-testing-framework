/**
 * AcmeAccountPage — the ACME accounts list. The account is searched by id, because the list pages by ten rows.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { widgetTitled } from './ui/widget';

const logger = new Logger('AcmeAccountPage');

export class AcmeAccountPage {
    readonly page: Page;
    readonly main: Locator;

    // List of ACME Accounts
    readonly acmeAccountsList: Locator;
    readonly searchInput: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.acmeAccountsList = widgetTitled(this.main, 'List of ACME Accounts');
        this.searchInput = this.acmeAccountsList.getByRole('textbox', { name: 'Search' });
    }

    accountRow(accountId: string): Locator {
        return this.acmeAccountsList.locator('tbody tr').filter({ has: this.page.getByRole('link', { name: accountId, exact: true }) });
    }

    async goToList(): Promise<void> {
        logger.info('Opening the ACME accounts list');
        await this.page.goto('/administrator/#/acmeaccounts');
        await expect(this.acmeAccountsList).toBeVisible();
    }

    async searchById(accountId: string): Promise<void> {
        logger.info(`Searching the ACME accounts list for ${accountId}`);
        await this.searchInput.fill(accountId);
    }

    async clearSearch(): Promise<void> {
        await this.searchInput.fill('');
    }

    async assertListed(accountId: string, acmeProfileName: string): Promise<void> {
        logger.info(`Asserting ACME account ${accountId} is listed under ${acmeProfileName}`);
        await expect(this.accountRow(accountId)).toHaveCount(1);
        await expect(this.accountRow(accountId)).toContainText(acmeProfileName);
    }
}
