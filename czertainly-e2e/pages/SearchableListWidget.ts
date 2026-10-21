/**
 * SearchableListWidget — a list widget of the admin UI with a client-side `Search` box (CustomTable: the box filters
 * every page of the table, the table shows 10 rows a page). Roles, users and ACME accounts share it, so the search,
 * the row lookup and the listed / not-listed checks are written once. Asserts never navigate: the page object loads or
 * reloads the list first.
 */
import { expect, Locator, Page } from '@playwright/test';
import { widgetTitled } from './ui/widget';

export class SearchableListWidget {
    readonly page: Page;
    /** The widget (`<section>`) titled like the list, e.g. `List of Roles`. */
    readonly root: Locator;

    constructor(page: Page, title: string) {
        this.page = page;
        this.root = widgetTitled(page.locator('main'), title);
    }

    get searchBox(): Locator {
        return this.root.getByRole('textbox', { name: 'Search' });
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

    /** The detail links of the rows the table shows: the positive marker that the list has loaded. */
    get detailLinks(): Locator {
        return this.root.locator('tbody tr a[href*="/detail/"]');
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
