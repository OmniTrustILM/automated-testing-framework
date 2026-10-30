/**
 * AcmeAccountPage — the ACME accounts list.
 *
 * Opens the list, searches it by account id, clears the search and asserts that an account is listed under an ACME
 * profile. The list pages by ten rows, sorted by ACME profile name, so the account is searched by its server-assigned
 * id: it may sort onto page two. `assertListed` matches the exact link text, so an id that only contains the searched
 * id does not count.
 */
import { expect, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { SearchableListWidget } from './SearchableListWidget';

const logger = new Logger('AcmeAccountPage');

export class AcmeAccountPage {
    readonly list: SearchableListWidget;

    constructor(private readonly page: Page) {
        this.list = new SearchableListWidget(page, 'List of ACME Accounts');
    }

    /** Opens the ACME accounts list by its route. */
    async goToList(): Promise<void> {
        logger.info('Opening the ACME accounts list');
        await this.page.goto('/administrator/#/acmeaccounts');
        await expect(this.list.root).toBeVisible();
    }

    /** Searches the list by an account id (the run's account may sort onto page two, so the list is never read unsearched). */
    async searchById(accountId: string): Promise<void> {
        logger.info(`Searching the ACME accounts list for ${accountId}`);
        await this.list.search(accountId);
    }

    /** Clears the search box: every row is shown again. */
    async clearSearch(): Promise<void> {
        await this.list.search('');
    }

    /** The list, as searched now, shows exactly one row with that account id, under the given ACME profile name. */
    async assertListed(accountId: string, acmeProfileName: string): Promise<void> {
        logger.info(`Asserting ACME account ${accountId} is listed under ${acmeProfileName}`);
        await expect(this.list.rowWithLink(accountId)).toHaveCount(1);
        await expect(this.list.rowWithLink(accountId)).toContainText(acmeProfileName);
    }
}
