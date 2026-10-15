/**
 * AcmeAccountPage — the ACME accounts list (REG-USE-05, "the account is listed in the UI").
 *
 * fe-administrator origin/main, `_pages/acme-accounts/list`: widget `List of ACME Accounts`, a CustomTable with
 * client-side paging (10 rows a page, persisted) sorted by ACME Profile Name ascending and a client-side `Search` box
 * that filters every column's text. Columns: Account Id (link to the detail), ACME Profile Name (link), RA Profile Name,
 * Internal State, Account Status, Total Orders. Incident fix (B1 live run 1): the run's account sorted onto page 2, so
 * a `toContainText` over the first page failed; the list is searched by the server-assigned account id instead.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { widget } from './RegressionUi';

const logger = new Logger('AcmeAccountPage');

export class AcmeAccountPage {
    readonly page: Page;
    readonly main: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
    }

    get listWidget(): Locator {
        return widget(this.main, 'List of ACME Accounts');
    }

    async goToList(): Promise<void> {
        logger.info('Opening the ACME accounts list');
        await this.page.goto('administrator/#/acmeaccounts');
        await expect(this.listWidget).toBeVisible();
    }

    async searchList(text: string): Promise<void> {
        await this.listWidget.getByRole('textbox', { name: 'Search' }).fill(text);
    }

    /** The list row of an account id (the Account Id column is a link to the detail), after `searchList`. */
    row(accountId: string): Locator {
        return this.listWidget.locator('tbody tr').filter({ has: this.page.getByRole('link', { name: accountId, exact: true }) });
    }

    /** The list, searched by the account id, shows exactly that account under the given ACME profile name. */
    async assertListed(accountId: string, acmeProfileName: string): Promise<void> {
        logger.info(`Asserting ACME account ${accountId} is listed under ${acmeProfileName}`);
        await this.searchList(accountId);
        await expect(this.row(accountId)).toHaveCount(1);
        await expect(this.row(accountId)).toContainText(acmeProfileName);
        await this.searchList('');
    }
}
