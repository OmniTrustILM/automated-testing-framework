/**
 * AcmeAccountPage — the ACME accounts list (REG-USE-05, "the account is listed in the UI"): widget
 * `List of ACME Accounts`, a SearchableListWidget sorted by ACME Profile Name with 10 rows a page. Columns: Account Id
 * (link to the detail), ACME Profile Name, RA Profile Name, Internal State, Account Status, Total Orders. The run's
 * account can sort onto page 2, so the list is searched by the server-assigned account id instead of read page one.
 */
import { expect, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { SearchableListWidget } from './SearchableListWidget';

const logger = new Logger('AcmeAccountPage');

export class AcmeAccountPage {
    readonly page: Page;
    readonly list: SearchableListWidget;

    constructor(page: Page) {
        this.page = page;
        this.list = new SearchableListWidget(page, 'List of ACME Accounts');
    }

    async goToList(): Promise<void> {
        logger.info('Opening the ACME accounts list');
        await this.page.goto('administrator/#/acmeaccounts');
        await expect(this.list.root).toBeVisible();
    }

    /** The list, searched by the account id, shows exactly that account under the given ACME profile name. */
    async assertListed(accountId: string, acmeProfileName: string): Promise<void> {
        logger.info(`Asserting ACME account ${accountId} is listed under ${acmeProfileName}`);
        await this.list.search(accountId);
        await expect(this.list.rowWithLink(accountId)).toHaveCount(1);
        await expect(this.list.rowWithLink(accountId)).toContainText(acmeProfileName);
        await this.list.search('');
    }
}
