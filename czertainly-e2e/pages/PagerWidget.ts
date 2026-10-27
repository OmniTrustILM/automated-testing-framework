/**
 * PagerWidget — the paging controls of every list table.
 *
 * WHAT: the paging controls of every list table: the page-size select, the page buttons with Previous / Next and
 *       the "Showing a to b items of n" line.
 * WHY: REG-CERT-50 checks sizes, pages and the summary (REG-WFL-15 through EventHistoryWidget); the widget only
 *       acts and reads — a page that needs the list request a click caused wraps the call itself.
 * HOW: controls by test id inside the scope it is given; the page size is shown only while there are rows, the
 *       pager only with more than one page.
 */
import { expect, Locator, Page } from '@playwright/test';
import { collapse } from '../utils/regression/text';
import { chooseOption, readSelectOptions, selectById } from './ui/select';

/** The page sizes of every list table (`utils/pagination.ts` of fe-administrator). */
export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

const SUMMARY = /^Showing (\d+) to (\d+) items of (\d+)$/;

export class PagerWidget {
    readonly pageSizeTrigger: Locator;
    readonly pager: Locator;

    /** `scope` is the widget or main area that holds the table. */
    constructor(readonly page: Page, readonly scope: Locator) {
        this.pageSizeTrigger = scope.getByTestId('select-pageSize-trigger');
        this.pager = scope.getByTestId('pagination');
    }

    pageButton(pageNumber: number): Locator {
        return this.scope.getByTestId(`pagination-page-${pageNumber}`);
    }

    /** The page-size control is shown (it is hidden while the list has no rows). */
    async assertPageSizeControl(visible: boolean): Promise<void> {
        await expect(this.pageSizeTrigger).toHaveCount(visible ? 1 : 0);
    }

    /** The options of the page-size control, as numbers, in order. */
    async pageSizeOptions(): Promise<number[]> {
        return (await readSelectOptions(this.page, selectById(this.page, this.scope, 'pageSize'), { allowEmpty: true })).map(Number);
    }

    async selectedPageSize(): Promise<number> {
        return Number(collapse((await this.pageSizeTrigger.textContent()) ?? ''));
    }

    /** Chooses a page size; returns false (and does nothing) when it already is the size. */
    async setPageSize(size: PageSize): Promise<boolean> {
        if ((await this.selectedPageSize()) === size) return false;
        await chooseOption(this.page, selectById(this.page, this.scope, 'pageSize'), String(size));
        return true;
    }

    /** Clicks a page number of the pager. */
    async goToPage(pageNumber: number): Promise<void> {
        await this.pageButton(pageNumber).click();
    }

    /** The pager shows `pages` page buttons (up to 7) with `page` current; Previous / Next are disabled at the ends. */
    async assertPager(expected: { page: number; pages: number }): Promise<void> {
        await expect(this.pager).toBeVisible();
        if (expected.pages <= 7) await expect(this.pager.getByTestId(/^pagination-page-\d+$/)).toHaveCount(expected.pages);
        await expect(this.pageButton(expected.page)).toHaveAttribute('aria-current', 'page');
        await expect(this.pager.locator('[aria-current="page"]')).toHaveCount(1);
        const prev = this.scope.getByTestId('pagination-prev');
        const next = this.scope.getByTestId('pagination-next');
        if (expected.page === 1) await expect(prev).toBeDisabled();
        else await expect(prev).toBeEnabled();
        if (expected.page === expected.pages) await expect(next).toBeDisabled();
        else await expect(next).toBeEnabled();
    }

    /** One page or none: the pager is not mounted at all. */
    async assertPagerHidden(): Promise<void> {
        await expect(this.pager).toHaveCount(0);
    }

    /** `Showing <from> to <to> items of <total>`; null while there are no rows (the line is hidden). */
    async summary(): Promise<{ from: number; to: number; total: number } | null> {
        const line = this.scope.getByText(/^Showing \d+ to \d+ items of \d+$/);
        if ((await line.count()) === 0) return null;
        const m = SUMMARY.exec(collapse((await line.first().textContent()) ?? ''));
        return m ? { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]) } : null;
    }
}
