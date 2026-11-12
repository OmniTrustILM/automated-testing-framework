/**
 * SearchableListWidget — a list widget with a client-side Search box.
 *
 * WHAT: a list widget with a client-side Search box (ten rows a page).
 * WHY: roles, users and ACME accounts share the search, the row lookup and the listed / not-listed checks; absence
 *       is asserted only after the list showed rows.
 * HOW: the widget by its heading; rows by their detail link; the search box is cleared afterwards.
 */
import { expect, Locator, Page } from '@playwright/test';
import { widgetTitled } from './ui/widget';

export class SearchableListWidget {
    private readonly page: Page;
    /** The widget (`<section>`) titled like the list, e.g. `List of Roles`. */
    readonly root: Locator;
    readonly searchBox: Locator;
    /** The detail links of the rows the table shows: the positive marker that the list has loaded. */
    readonly detailLinks: Locator;

    constructor(page: Page, title: string) {
        this.page = page;
        this.root = widgetTitled(page.locator('main'), title);
        this.searchBox = this.root.getByRole('textbox', { name: 'Search' });
        this.detailLinks = this.root.locator('tbody tr a[href*="/detail/"]');
    }

    /** Type into the Search box (an empty text shows every row again). */
    async search(text: string): Promise<void> {
        await this.searchBox.fill(text);
    }

    /** The row link of a name (exact link text), after `search`. */
    rowLink(name: string): Locator {
        return this.root.getByRole('link', { name, exact: true });
    }

    /** The table row that holds the link of a name (exact link text). */
    rowWithLink(name: string): Locator {
        return this.root.locator('tbody tr').filter({ has: this.page.getByRole('link', { name, exact: true }) });
    }

    /**
     * Searched by name, the list has no row of that name. Absence needs a positive marker first: the list shows rows
     * (every tier has system roles and users), so an empty, still-loading table cannot pass for "not listed".
     * `loadTimeout` is how long the rows may take to show. The search box is cleared afterwards.
     */
    async assertNotListed(name: string, opts: { loadTimeout?: number } = {}): Promise<void> {
        await expect(this.detailLinks.first(), 'the list has loaded its rows').toBeVisible({ timeout: opts.loadTimeout ?? 30_000 });
        await this.search(name);
        await expect(this.rowLink(name)).toHaveCount(0);
        await this.search('');
    }
}
