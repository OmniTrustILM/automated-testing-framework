/**
 * CertificateListPage — the certificate list.
 *
 * WHAT: the certificate list: the filter widget host, the table (headers, rows, cells), header sorting, row
 *       selection with the bulk toolbar and the Include archived switch.
 * WHY: REG-CERT-40 … 51 check filters, sorting, paging and the Standard columns against the request the page sends
 *       and the API; nothing here changes the list.
 * HOW: columns by the header's data id, never by position; rows by data id and by the Common Name link in its own
 *       column (a CA's name is also the issuer link of every row); paging is `PagerWidget`, the column menu
 *       `ColumnHeaderMenuWidget`; what a cell must show is computed in `certificateListOracle.ts`.
 */
import { expect, Locator, Page } from '@playwright/test';
import { ApiRecorder } from '../utils/network/apiRecorder';
import { CellExpectation, forbiddenWordIn } from '../utils/regression/inventory/certificateListOracle';
import type { PlatformLabels } from '../utils/regression/inventory/fieldLabels';
import { collapse } from '../utils/regression/text';
import { ColumnHeaderMenuWidget } from './ColumnHeaderMenuWidget';
import { FilterWidget, ListBody, ListObservation, PickedDate } from './FilterWidget';
import { Navigation } from './Navigation';
import { PagerWidget, PageSize } from './PagerWidget';

// ------------------------------------------------------------------ the page

export interface CellState {
    /** textContent, whitespace collapsed. */
    text: string;
    /** The cell holds the shared empty state. */
    empty: boolean;
}

/** What `openSeeded` reads of the run's list data (the `listSeed` of the certificate list fixture fits). */
export interface SeededList {
    manifest: { prefix: string };
    labels: PlatformLabels;
}

export interface OpenSeededOptions {
    /** Sets the page size after the list is open (and after the prefix filter, when `isolate` is set). */
    pageSize?: PageSize;
    /** Adds `Common Name starts with <run seed prefix>` through the widget first and keeps its badge. */
    isolate?: boolean;
}

export class CertificateListPage {
    readonly page: Page;
    readonly main: Locator;
    readonly filter: FilterWidget;
    readonly pager: PagerWidget;
    /** The `/api/` requests of the page; idle until `traffic.start()`, so a page object adds no listener by itself. */
    readonly traffic: ApiRecorder;
    readonly table: Locator;
    /** The data rows (`tr[data-id=<uuid>]`). */
    readonly rows: Locator;
    private readonly headers: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.filter = new FilterWidget(page, this.main, { waitForListLoaded: () => this.waitForTableLoaded() });
        this.pager = new PagerWidget(page, this.main);
        this.traffic = new ApiRecorder(page);
        this.table = this.main.getByTestId('custom-table');
        this.rows = this.table.locator('tbody tr[data-id]');
        this.headers = this.table.locator('thead th[data-id]');
    }

    // ---- navigation and loading

    /** Opens the list on an already signed-in page; with `isolate` the run's seed prefix filter is added before the page size is set. */
    static async openSeeded(page: Page, seed: SeededList, options: OpenSeededOptions = {}): Promise<CertificateListPage> {
        const list = new CertificateListPage(page);
        await list.goToList();
        if (options.isolate) await list.filterByCommonNamePrefix(seed.manifest.prefix, seed.labels);
        if (options.pageSize) await list.setPageSize(options.pageSize);
        return list;
    }

    /** Sidebar → Certificates; returns once the list and the filter widget are rendered and no fetch is in flight. */
    async goToList(): Promise<void> {
        await new Navigation(this.page).openViaSidebar('Certificates', /\/certificates/i);
        await expect(this.main).toBeVisible();
        await this.waitForTableLoaded();
        await expect(this.filter.sourceTrigger).toBeVisible();
    }

    /**
     * The table is shown, no skeleton and no busy overlay (a refetch keeps the old rows under the overlay, so rows alone prove nothing).
     */
    async waitForTableLoaded(): Promise<void> {
        await expect(this.table).toBeVisible();
        await expect(this.main.getByTestId('table-skeleton')).toHaveCount(0);
        await expect(this.main.getByTestId('table-skeleton-row')).toHaveCount(0);
        await expect(this.main.getByTestId('widget-busy-overlay')).toHaveCount(0);
    }

    /** Runs an action and returns the certificate list request it caused (waited for before the action), with the table loaded. */
    async observeListRequest(action: () => Promise<unknown>, match?: (body: ListBody) => boolean): Promise<ListObservation> {
        return this.filter.observeListRequest(action, match);
    }

    // ---- the common-name filter every exact row-set check carries

    /** `Common Name starts with <prefix>` through the widget. Add it first and keep its badge. */
    async filterByCommonNamePrefix(prefix: string, labels: PlatformLabels): Promise<ListObservation> {
        return this.filter.addFilter({
            source: labels.source('property'),
            field: 'Common Name',
            condition: labels.condition('STARTS_WITH'),
            value: prefix,
        });
    }

    // ---- table structure

    /**
     * A data row by its Common Name: the link with exactly that text in the row's own Common Name cell. A CA's name is also the
     * Issuer Common Name link of every certificate it issued (the certificate table helpers of the admin UI), so a row-wide link match is
     * not one row.
     */
    async rowByCommonName(commonName: string): Promise<Locator> {
        const index = await this.columnIndex('property:COMMON_NAME');
        return this.rows.filter({ has: this.page.locator(`td:nth-child(${index + 1})`).getByRole('link', { name: commonName, exact: true }) });
    }

    /** `th[data-id=<column key>]`. */
    header(columnId: string): Locator {
        return this.table.locator(`thead th[data-id="${columnId}"]`);
    }

    /** The options menu of a column. */
    columnMenu(columnId: string): ColumnHeaderMenuWidget {
        return new ColumnHeaderMenuWidget(this.page, columnId);
    }

    /** Every header id including the checkbox column, in order (a row's n-th `td` belongs to the n-th id). */
    private async allHeaderIds(): Promise<string[]> {
        return (await this.headers.evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''))).filter(Boolean);
    }

    /** The column ids shown, in order, without the checkbox column. */
    async visibleColumns(): Promise<string[]> {
        return (await this.allHeaderIds()).filter((id) => id !== '__checkbox__');
    }

    /**
     * The headings as the page renders them (the heading span named by the header's `aria-labelledby`; CSS upper-casing is not part of
     * the text).
     */
    async columnHeadings(): Promise<string[]> {
        return this.headers.evaluateAll((els) =>
            els
                .filter((e) => e.getAttribute('data-id') !== '__checkbox__')
                .map((e) => {
                    const target = document.getElementById(e.getAttribute('aria-labelledby') ?? '');
                    return (target?.textContent ?? '').replace(/\s+/g, ' ').trim();
                }),
        );
    }

    async assertColumns(expected: readonly string[]): Promise<void> {
        await expect.poll(() => this.visibleColumns(), { message: 'the columns shown' }).toEqual([...expected]);
    }

    private async columnIndex(columnId: string): Promise<number> {
        const index = (await this.allHeaderIds()).indexOf(columnId);
        if (index < 0) throw new Error(`the table has no column ${columnId}`);
        return index;
    }

    // ---- rows and cells

    async commonNames(): Promise<string[]> {
        return this.cellTexts('property:COMMON_NAME');
    }

    /** The texts of one column over the rows shown, whitespace collapsed, in row order. */
    async cellTexts(columnId: string): Promise<string[]> {
        const index = await this.columnIndex(columnId);
        return (await this.rows.locator(`td:nth-child(${index + 1})`).allTextContents()).map(collapse);
    }

    /** Every cell of one row in a single DOM read: column id → text and empty-state flag. */
    async readRow(commonName: string): Promise<Record<string, CellState>> {
        const ids = await this.allHeaderIds();
        const raw = await (await this.rowByCommonName(commonName)).evaluate((tr, headerIds) => {
            const cells = Array.from(tr.querySelectorAll(':scope > td'));
            const out: Record<string, { text: string; empty: boolean }> = {};
            headerIds.forEach((id, i) => {
                const td = cells[i];
                if (td) out[id] = { text: td.textContent ?? '', empty: td.querySelector('[data-testid="empty-cell"]') !== null };
            });
            return out;
        }, ids);
        return Object.fromEntries(Object.entries(raw).map(([id, c]) => [id, { text: collapse(c.text), empty: c.empty }]));
    }

    /** Each given cell of the row equals its expectation; every mismatch is reported together. */
    async assertCellValues(commonName: string, expected: Record<string, CellExpectation>): Promise<void> {
        const cells = await this.readRow(commonName);
        const mismatches: string[] = [];
        for (const [column, want] of Object.entries(expected)) {
            const got = cells[column];
            if (!got) {
                mismatches.push(`${column}: no such cell`);
            } else if ('empty' in want) {
                if (!got.empty) mismatches.push(`${column}: expected the empty state, got "${got.text}"`);
            } else if ('text' in want) {
                if (got.empty || got.text !== collapse(want.text)) mismatches.push(`${column}: expected "${want.text}", got ${got.empty ? 'the empty state' : `"${got.text}"`}`);
            } else {
                const missing = want.contains.filter((part) => !got.text.includes(part));
                if (got.empty || missing.length) mismatches.push(`${column}: expected a cell with ${JSON.stringify(want.contains)}, got ${got.empty ? 'the empty state' : `"${got.text}"`}`);
            }
        }
        expect(mismatches, `cells of ${commonName}`).toEqual([]);
    }

    /**
     * The text of the table body: every cell of every row shown, separated (a word at the end of one cell must not fuse with the next
     * cell's text).
     */
    async bodyText(): Promise<string> {
        return (await this.table.locator('tbody td').allTextContents()).map(collapse).join(' | ');
    }

    /** The words `null`, `undefined`, `NaN`, `Invalid Date` appear nowhere in the table body. */
    async assertNoForbiddenWords(): Promise<void> {
        const hit = forbiddenWordIn(await this.bodyText());
        expect(hit, 'a forbidden word in the table body').toBeUndefined();
    }

    /** The browser's IANA time zone (the list formats dates with the browser's local getters). */
    async browserTimeZone(): Promise<string> {
        return this.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    }

    /** The picker date (browser local calendar) of an absolute instant: where a picked day lands in the local zone. */
    private async localDateOf(iso: string): Promise<{ year: number; month: number; day: number }> {
        return this.page.evaluate((value) => {
            const d = new Date(value);
            return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
        }, iso);
    }

    /**
     * A date-time picker value in the middle of a window: `days` after the anchor, at 12:00:00 on the browser's local calendar (noon
     * exists on every day, DST gaps included), with the UTC instant the FE will send for it. Boundary rule: the value must not sit on
     * a bound, so it throws when any of the given instants (the seeds' expiries) is less than `marginDays` away.
     */
    async pickDateInsideWindow(anchorIso: string, days: number, instants: readonly string[], marginDays = 5): Promise<{ picked: PickedDate; instant: string }> {
        const local = await this.localDateOf(new Date(Date.parse(anchorIso) + days * 24 * 3600 * 1000).toISOString());
        const picked: PickedDate = { ...local, hours: 12, minutes: 0, seconds: 0 };
        const instant = await this.filter.instantOf(picked);
        for (const other of instants) {
            const apart = Math.abs(Date.parse(other) - Date.parse(instant)) / (24 * 3600 * 1000);
            if (apart < marginDays) throw new Error(`the picked instant ${instant} is only ${apart.toFixed(1)} days from ${other}: not a mid-window value`);
        }
        return { picked, instant };
    }

    // ---- sorting

    /** The sort button inside a sortable header (the heading button that holds the arrow). */
    private sortButton(columnId: string): Locator {
        return this.header(columnId).locator('button:has([data-testid="sort-indicator"])');
    }

    /** Clicks a sortable header (asc first, then desc, one column at a time) and returns the list request it caused. */
    async sortBy(columnId: string): Promise<ListObservation> {
        const button = this.sortButton(columnId);
        await expect(button, `${columnId} is sortable`).toBeVisible();
        return this.observeListRequest(() => button.click());
    }

    /**
     * The header is the sorted one: `aria-sort` on it and on no other header (an unsorted header carries no attribute, so this is
     * asserted AFTER the click), its arrow shows the direction and every other arrow is the neutral one.
     */
    async assertSortedBy(columnId: string, direction: 'asc' | 'desc'): Promise<void> {
        const th = this.header(columnId);
        await expect(th, `aria-sort of ${columnId}`).toHaveAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
        await expect(this.table.locator('thead th[aria-sort]'), 'only one header is sorted').toHaveCount(1);
        await expect(th.getByTestId('sort-indicator')).toHaveAttribute('data-direction', direction);
        await expect(this.table.locator('thead [data-testid="sort-indicator"]:not([data-direction="none"])'), 'only one arrow').toHaveCount(1);
    }

    /** No header is sorted (the page opens with Core's own order). */
    async assertNotSorted(): Promise<void> {
        await expect(this.table.locator('thead th[aria-sort]')).toHaveCount(0);
        await expect(this.table.locator('thead [data-testid="sort-indicator"]:not([data-direction="none"])')).toHaveCount(0);
    }

    /**
     * The header of a column that cannot be ordered has no sort button (a click does nothing; the column state of the admin UI decides).
     */
    async assertNoSortButton(columnId: string): Promise<void> {
        await expect(this.header(columnId)).toBeVisible();
        await expect(this.sortButton(columnId)).toHaveCount(0);
    }

    // ---- paging (the list request each change causes)

    /** Chooses a page size (no request when it already is the size); returns the list request, which carries the page the UI kept. */
    async setPageSize(size: PageSize): Promise<ListObservation | undefined> {
        if ((await this.pager.selectedPageSize()) === size) return undefined;
        return this.observeListRequest(() => this.pager.setPageSize(size), (body) => body.itemsPerPage === size);
    }

    /** Clicks a page number of the pager; returns the list request. */
    async goToPage(pageNumber: number): Promise<ListObservation> {
        return this.observeListRequest(() => this.pager.goToPage(pageNumber), (body) => body.pageNumber === pageNumber);
    }

    // ---- selection and the bulk toolbar

    /** Ticks the checkboxes of the rows with these Common Names. */
    async checkRows(commonNames: readonly string[]): Promise<void> {
        for (const name of commonNames) await (await this.rowByCommonName(name)).getByRole('checkbox').check();
    }

    /** Common Names of the checked rows on the page shown. */
    async checkedCommonNames(): Promise<string[]> {
        const index = await this.columnIndex('property:COMMON_NAME');
        const checked = this.rows.filter({ has: this.page.locator('input[type="checkbox"]:checked') });
        return (await checked.locator(`td:nth-child(${index + 1})`).allTextContents()).map(collapse);
    }

    /** The bulk toolbar (Override Groups, Archive, …) is enabled exactly while a row is checked. */
    async assertBulkToolbar(enabled: boolean): Promise<void> {
        const button = this.main.getByTestId('group-button');
        if (enabled) await expect(button).toBeEnabled();
        else await expect(button).toBeDisabled();
    }

    // ---- include archived

    /** Sets the Include archived switch (the list refetches with `includeArchived`); undefined when it already was in that state. */
    async setIncludeArchived(on: boolean): Promise<ListObservation | undefined> {
        const input = this.main.getByTestId('switch-archived-switch-input');
        if ((await input.isChecked()) === on) return undefined;
        const label = this.main.locator('label[for="archived-switch"]').first();
        return this.observeListRequest(() => label.click(), (body) => body.includeArchived === on);
    }

    async assertIncludeArchived(on: boolean): Promise<void> {
        await expect(this.main.getByTestId('switch-archived-switch-input')).toBeChecked({ checked: on });
    }
}
