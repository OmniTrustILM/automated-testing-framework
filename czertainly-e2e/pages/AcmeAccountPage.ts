/**
 * AcmeAccountPage — the ACME accounts list.
 *
 * Opens the list, searches it by account id, clears the search and asserts that an account is listed under an ACME
 * profile. The list pages by ten rows, sorted by ACME profile name, so the account is searched by its server-assigned
 * id: it may sort onto page two. `assertListed` matches the exact link text, so an id that only contains the searched
 * id does not count.
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

        // List of ACME Accounts
        this.acmeAccountsList = widgetTitled(this.main, 'List of ACME Accounts');
        this.searchInput = this.acmeAccountsList.getByRole('textbox', { name: 'Search' });
    }

    /** The table row that holds the link of an account id (exact link text). */
    accountRow(accountId: string): Locator {
        return this.acmeAccountsList.locator('tbody tr').filter({ has: this.page.getByRole('link', { name: accountId, exact: true }) });
    }

    /** Opens the ACME accounts list by its route. */
    async goToList(): Promise<void> {
        logger.info('Opening the ACME accounts list');
        await this.page.goto('/administrator/#/acmeaccounts');
        await expect(this.acmeAccountsList).toBeVisible();
    }

    /** Searches the list by an account id (the run's account may sort onto page two, so the list is never read unsearched). */
    async searchById(accountId: string): Promise<void> {
        logger.info(`Searching the ACME accounts list for ${accountId}`);
        await this.searchInput.fill(accountId);
    }

    /** Clears the search box: every row is shown again. */
    async clearSearch(): Promise<void> {
        await this.searchInput.fill('');
    }

    /** The list, as searched now, shows exactly one row with that account id, under the given ACME profile name. */
    async assertListed(accountId: string, acmeProfileName: string): Promise<void> {
        logger.info(`Asserting ACME account ${accountId} is listed under ${acmeProfileName}`);
        await expect(this.accountRow(accountId)).toHaveCount(1);
        await expect(this.accountRow(accountId)).toContainText(acmeProfileName);
    }
}
