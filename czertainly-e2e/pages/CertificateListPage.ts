/**
 * CertificateListPage — the certificate list: filter badges and rows by Common Name (REG-USE-02).
 * Nothing here creates or deletes anything. Columns are found by the header's data id, never by position.
 */
import { expect, Locator, Page } from '@playwright/test';
import { ApiRecorder } from '../utils/network/apiRecorder';
import { CellExpectation, forbiddenWordIn } from '../utils/regression/inventory/certificateListOracle';
import { badgeTextOf, PlatformLabels } from '../utils/regression/inventory/fieldLabels';
import { collapse } from '../utils/regression/text';
import { Logger } from '../utils/Logger';
import { Navigation } from './Navigation';
import { fillFilterText, FilterSpec, FilterValue, instantOf, isPickedDate, PickedDate, pickDate } from './ui/filter';
import { ListBody, ListObservation, observeListRequest } from './ui/list';
import { chooseOption, chooseOptions, closePopover, describeChoice, OptionChoice, readSelectOptions, selectById, SelectHandle } from './ui/select';

const logger = new Logger('CertificateListPage');

/** The page sizes of every list table (`utils/pagination.ts` of fe-administrator). */
export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/** The reason a column that cannot be ordered gives in its menu. */
const NOT_SORTABLE_REASON = 'This field cannot be used for ordering.';

/** How far a picked date stays from every seed expiry, so it never sits on a bound. */
const PICK_MARGIN_DAYS = 5;

const PAGER_SUMMARY = /^Showing (\d+) to (\d+) items of (\d+)$/;

interface CellState {
    /** textContent, whitespace collapsed. */
    text: string;
    /** The cell holds the shared empty state. */
    empty: boolean;
}

/** What `openSeeded` reads of the run's list data (the `listSeed` of the certificate list fixture fits). */
interface SeededList {
    manifest: { prefix: string };
    labels: PlatformLabels;
}

interface OpenSeededOptions {
    pageSize?: PageSize;
    /** Adds `Common Name starts with <run seed prefix>` through the widget first and keeps its badge. */
    isolate?: boolean;
}

export class CertificateListPage {
    readonly page: Page;
    readonly main: Locator;
    /** The `/api/` requests of the page; idle until `traffic.start()`. */
    readonly traffic: ApiRecorder;

    // Filter widget: Source / Field / Condition, the value control of the chosen condition, Add
    readonly groupSelect: SelectHandle;
    readonly fieldSelect: SelectHandle;
    readonly conditionsSelect: SelectHandle;
    readonly filterValueInput: Locator;
    readonly valueSelect: SelectHandle;
    /** The date picker input: a plain `input#valueSelect` (the TextInput carries a test id). */
    readonly filterDateInput: Locator;
    /** The date picker portal: the `<body>` child that holds the weekday header (no test id yet). */
    readonly calendar: Locator;
    readonly durationHint: Locator;
    /** `Add`, or `Update` while a badge is loaded; `#addFilter` as the fallback. */
    readonly addFilterButton: Locator;

    // Filter badges above the table (each with its "Remove badge" button)
    readonly filterBadges: Locator;

    // Certificate table
    readonly table: Locator;
    readonly rows: Locator;
    readonly checkedRows: Locator;
    readonly columnHeaders: Locator;
    readonly sortedHeaders: Locator;
    readonly activeSortIndicators: Locator;
    readonly bodyCells: Locator;

    // Bulk toolbar
    readonly overrideGroupsButton: Locator;

    // Loading state: the skeleton, and the busy overlay of a refetch
    readonly tableSkeleton: Locator;
    readonly tableSkeletonRows: Locator;
    readonly busyOverlay: Locator;

    // Pager: page size, page buttons, the "Showing a to b items of n" line
    readonly pageSizeSelect: SelectHandle;
    readonly pager: Locator;
    readonly pagerPageButtons: Locator;
    readonly currentPageButtons: Locator;
    readonly previousPageButton: Locator;
    readonly nextPageButton: Locator;
    readonly pagerSummaryLine: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.traffic = new ApiRecorder(page);

        // Filter widget
        this.groupSelect = selectById(page, this.main, 'group');
        this.fieldSelect = selectById(page, this.main, 'field');
        this.conditionsSelect = selectById(page, this.main, 'conditions');
        this.filterValueInput = this.main.getByTestId('text-input-valueSelect');
        this.valueSelect = selectById(page, this.main, 'valueSelect');
        this.filterDateInput = this.main.locator('input#valueSelect:not([data-testid])');
        this.calendar = page.locator('body > div').filter({ hasText: /Mo\s*Tu\s*We\s*Th\s*Fr\s*Sa\s*Su/ });
        this.durationHint = this.main.getByText('Duration in format: 0d 0h 0m 0s');
        this.addFilterButton = this.main
            .getByRole('button', { name: 'Add', exact: true })
            .or(this.main.getByRole('button', { name: 'Update', exact: true }))
            .or(this.main.locator('#addFilter'))
            .first();

        // Filter badges
        this.filterBadges = this.main.getByTestId('badge').filter({ has: page.getByRole('button', { name: 'Remove badge' }) });

        // Certificate table
        this.table = this.main.getByTestId('custom-table');
        this.rows = this.table.locator('tbody tr[data-id]');
        this.checkedRows = this.rows.filter({ has: page.locator('input[type="checkbox"]:checked') });
        this.columnHeaders = this.table.locator('thead th[data-id]');
        this.sortedHeaders = this.table.locator('thead th[aria-sort]');
        this.activeSortIndicators = this.table.locator('thead [data-testid="sort-indicator"]:not([data-direction="none"])');
        this.bodyCells = this.table.locator('tbody td');

        // Bulk toolbar
        this.overrideGroupsButton = this.main.getByTestId('group-button');

        // Loading state
        this.tableSkeleton = this.main.getByTestId('table-skeleton');
        this.tableSkeletonRows = this.main.getByTestId('table-skeleton-row');
        this.busyOverlay = this.main.getByTestId('widget-busy-overlay');

        // Pager
        this.pageSizeSelect = selectById(page, this.main, 'pageSize');
        this.pager = this.main.getByTestId('pagination');
        this.pagerPageButtons = this.pager.getByTestId(/^pagination-page-\d+$/);
        this.currentPageButtons = this.pager.locator('[aria-current="page"]');
        this.previousPageButton = this.main.getByTestId('pagination-prev');
        this.nextPageButton = this.main.getByTestId('pagination-next');
        this.pagerSummaryLine = this.main.getByText(/^Showing \d+ to \d+ items of \d+$/);
    }

    removeBadgeButton(index: number): Locator {
        return this.filterBadges.nth(index).getByRole('button', { name: 'Remove badge' });
    }

    /** `th[data-id=<column id>]`. */
    columnHeader(columnId: string): Locator {
        return this.table.locator(`thead th[data-id="${columnId}"]`);
    }

    /** The heading button that holds the sort arrow. */
    sortButton(columnId: string): Locator {
        return this.columnHeader(columnId).locator('button:has([data-testid="sort-indicator"])');
    }

    /** The options menu of a column (a portal outside the table). */
    columnMenu(columnId: string): Locator {
        return this.page.getByTestId(`column-header-menu-${columnId}`);
    }

    /** `trigger`, `sort-asc`, `sort-desc`, `sort-unavailable`. */
    columnMenuItem(columnId: string, name: string): Locator {
        return this.page.getByTestId(`column-header-menu-${columnId}-${name}`);
    }

    pageButton(pageNumber: number): Locator {
        return this.main.getByTestId(`pagination-page-${pageNumber}`);
    }

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
        await new Navigation(this.page).openViaSidebar('sidebar-certificates', /\/certificates/i);
        await expect(this.main).toBeVisible();
        await this.waitForTableLoaded();
        await expect(this.groupSelect.trigger).toBeVisible();
    }

    /** A refetch keeps the old rows under the busy overlay, so rows alone prove nothing. */
    async waitForTableLoaded(): Promise<void> {
        await expect(this.table).toBeVisible();
        await expect(this.tableSkeleton).toHaveCount(0);
        await expect(this.tableSkeletonRows).toHaveCount(0);
        await expect(this.busyOverlay).toHaveCount(0);
    }

    /** Runs an action and returns the certificate list request it caused (waited for before the action), with the table loaded. */
    private async observe(action: () => Promise<unknown>, match?: (body: ListBody) => boolean): Promise<ListObservation> {
        const seen = await observeListRequest(this.page, action, { match });
        await this.waitForTableLoaded();
        return seen;
    }

    // Filter widget

    /** `Common Name starts with <prefix>` through the widget. Add it first and keep its badge. */
    async filterByCommonNamePrefix(prefix: string, labels: PlatformLabels): Promise<ListObservation> {
        const condition = labels.condition('STARTS_WITH');
        return this.addFilter({ source: labels.source('property'), field: 'Common Name', condition, value: prefix });
    }

    async offeredSources(): Promise<string[]> {
        return readSelectOptions(this.page, this.groupSelect, { allowEmpty: true });
    }

    /** The Field select's options for the chosen Source. */
    async offeredFields(): Promise<string[]> {
        return readSelectOptions(this.page, this.fieldSelect, { allowEmpty: true });
    }

    /** Picks Source, Field and / or Condition (a later select resets on an earlier change; fe#994: the condition BEFORE the value). */
    async chooseFilter(selection: { source?: OptionChoice; field?: OptionChoice; condition?: OptionChoice }): Promise<void> {
        if (selection.source !== undefined) await chooseOption(this.page, this.groupSelect, selection.source);
        if (selection.field !== undefined) await chooseOption(this.page, this.fieldSelect, selection.field);
        if (selection.condition !== undefined) await chooseOption(this.page, this.conditionsSelect, selection.condition);
    }

    /** Which control the current condition shows (waits for one to render; the control is re-created on every selection). */
    private async valueControl(): Promise<Locator> {
        await expect(this.filterValueInput.or(this.valueSelect.trigger).or(this.filterDateInput).first(), 'a filter value control').toBeVisible();
        if ((await this.filterValueInput.count()) > 0) return this.filterValueInput;
        if ((await this.valueSelect.trigger.count()) > 0) return this.valueSelect.trigger;
        return this.filterDateInput;
    }

    /** Fills the value control the current condition shows: text / number / duration, list labels, a boolean label, or a date to pick. */
    async fillFilterValue(value: FilterValue): Promise<void> {
        const control = await this.valueControl();
        if (control === this.filterDateInput) {
            if (!isPickedDate(value)) throw new Error('the date picker needs a PickedDate');
            await pickDate(this.filterDateInput, this.calendar, value);
            return;
        }
        if (control === this.valueSelect.trigger) {
            await chooseOptions(this.page, this.valueSelect, Array.isArray(value) ? value : [String(value)]);
            return;
        }
        if (isPickedDate(value) || Array.isArray(value)) throw new Error('a text box takes a string or a number');
        await fillFilterText(this.filterValueInput, String(value));
    }

    /** Clicks `Add` / `Update` and returns the list request it caused. */
    async clickAddFilter(): Promise<ListObservation> {
        await expect(this.addFilterButton).toBeEnabled();
        return this.observe(() => this.addFilterButton.click());
    }

    /** One filter through the three selects, the value and `Add`; the condition is chosen BEFORE the value (fe#994). */
    async addFilter(spec: FilterSpec): Promise<ListObservation> {
        await this.chooseFilter({ source: spec.source, field: spec.field, condition: spec.condition });
        if (spec.value !== undefined) await this.fillFilterValue(spec.value);
        logger.info(`add filter ${describeChoice(spec.source)} / ${describeChoice(spec.field)} / ${describeChoice(spec.condition)}`);
        return this.clickAddFilter();
    }

    async removeFilterBadge(text: string): Promise<ListObservation> {
        await expect.poll(() => this.filterBadgeTexts(), { message: `badge "${text}"` }).toContain(text);
        const index = (await this.filterBadgeTexts()).indexOf(text);
        const seen = await observeListRequest(this.page, () => this.removeBadgeButton(index).click());
        await this.waitForTableLoaded();
        return seen;
    }

    /** The badge texts in order, normalised (`Property 'Common Name' contains 'x'`). */
    async filterBadgeTexts(): Promise<string[]> {
        return (await this.filterBadges.allTextContents()).map(badgeTextOf);
    }

    async assertFilterBadges(expected: readonly string[]): Promise<void> {
        await expect.poll(() => this.filterBadgeTexts(), { message: 'filter badges' }).toEqual([...expected]);
    }

    /** The Condition select offers exactly these labels (set equality; `ordered` also compares the order). */
    async assertConditionsOffered(expected: readonly string[], opts: { ordered?: boolean } = {}): Promise<void> {
        const offered = await readSelectOptions(this.page, this.conditionsSelect, { allowEmpty: true });
        if (opts.ordered) expect(offered, 'conditions offered, in order').toEqual([...expected]);
        else expect([...offered].sort(), 'conditions offered').toEqual([...expected].sort());
    }

    async assertAddFilterDisabled(): Promise<void> {
        await expect(this.addFilterButton).toBeDisabled();
    }

    async assertAddFilterEnabled(): Promise<void> {
        await expect(this.addFilterButton).toBeEnabled();
    }

    /** EMPTY / NOT_EMPTY: the value control is disabled, not hidden. */
    async assertValueControlDisabled(): Promise<void> {
        await expect(await this.valueControl()).toBeDisabled();
    }

    // Certificate table

    /** A CA's name is also the issuer link of every row it issued, so the link is matched in the row's own Common Name cell. */
    async rowByCommonName(commonName: string): Promise<Locator> {
        const index = await this.columnIndex('property:COMMON_NAME');
        return this.rows.filter({ has: this.page.locator(`td:nth-child(${index + 1})`).getByRole('link', { name: commonName, exact: true }) });
    }

    private async allHeaderIds(): Promise<string[]> {
        return (await this.columnHeaders.evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''))).filter(Boolean);
    }

    private async columnIndex(columnId: string): Promise<number> {
        const index = (await this.allHeaderIds()).indexOf(columnId);
        if (index < 0) throw new Error(`the table has no column ${columnId}`);
        return index;
    }

    /** The column ids shown, in order, without the checkbox column. */
    private async visibleColumns(): Promise<string[]> {
        return (await this.allHeaderIds()).filter((id) => id !== '__checkbox__');
    }

    /** The headings as rendered (the span named by the header's `aria-labelledby`; CSS upper-casing is not part of the text). */
    async columnHeadings(): Promise<string[]> {
        return this.columnHeaders.evaluateAll((els) =>
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
            const shown = got?.empty ? 'the empty state' : `"${got?.text}"`;
            if (!got) {
                mismatches.push(`${column}: no such cell`);
            } else if ('empty' in want) {
                if (!got.empty) mismatches.push(`${column}: expected the empty state, got "${got.text}"`);
            } else if ('text' in want) {
                if (got.empty || got.text !== collapse(want.text)) mismatches.push(`${column}: expected "${want.text}", got ${shown}`);
            } else {
                const missing = want.contains.filter((part) => !got.text.includes(part));
                if (got.empty || missing.length) {
                    mismatches.push(`${column}: expected a cell with ${JSON.stringify(want.contains)}, got ${shown}`);
                }
            }
        }
        expect(mismatches, `cells of ${commonName}`).toEqual([]);
    }

    /** The words `null`, `undefined`, `NaN`, `Invalid Date` appear nowhere in the table body (cells joined, so words never fuse). */
    async assertNoForbiddenWords(): Promise<void> {
        const body = (await this.bodyCells.allTextContents()).map(collapse).join(' | ');
        expect(forbiddenWordIn(body), 'a forbidden word in the table body').toBeUndefined();
    }

    /** The browser's IANA time zone (the list formats dates with the browser's local getters). */
    async browserTimeZone(): Promise<string> {
        return this.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    }

    /** A picker value `days` after the anchor at 12:00 local and its UTC instant; throws when one of `instants` is < 5 days away. */
    async pickDateInsideWindow(
        anchorIso: string, days: number, instants: readonly string[],
    ): Promise<{ picked: PickedDate; instant: string }> {
        const local = await this.page.evaluate((value) => {
            const d = new Date(value);
            return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
        }, new Date(Date.parse(anchorIso) + days * 24 * 3600 * 1000).toISOString());
        const picked: PickedDate = { ...local, hours: 12, minutes: 0, seconds: 0 };
        const instant = await instantOf(this.page, picked);
        for (const other of instants) {
            const apart = Math.abs(Date.parse(other) - Date.parse(instant)) / (24 * 3600 * 1000);
            if (apart < PICK_MARGIN_DAYS) {
                throw new Error(`the picked instant ${instant} is only ${apart.toFixed(1)} days from ${other}: not a mid-window value`);
            }
        }
        return { picked, instant };
    }

    // Sorting

    /** Clicks a sortable header (asc first, then desc, one column at a time) and returns the list request it caused. */
    async sortBy(columnId: string): Promise<ListObservation> {
        await expect(this.sortButton(columnId), `${columnId} is sortable`).toBeVisible();
        return this.observe(() => this.sortButton(columnId).click());
    }

    /** `aria-sort` on this header and on no other (asserted AFTER the click: an unsorted header has none), and only its arrow is set. */
    async assertSortedBy(columnId: string, direction: 'asc' | 'desc'): Promise<void> {
        const th = this.columnHeader(columnId);
        await expect(th, `aria-sort of ${columnId}`).toHaveAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
        await expect(this.sortedHeaders, 'only one header is sorted').toHaveCount(1);
        await expect(th.getByTestId('sort-indicator')).toHaveAttribute('data-direction', direction);
        await expect(this.activeSortIndicators, 'only one arrow').toHaveCount(1);
    }

    /** No header is sorted (the page opens with Core's own order). */
    async assertNotSorted(): Promise<void> {
        await expect(this.sortedHeaders).toHaveCount(0);
        await expect(this.activeSortIndicators).toHaveCount(0);
    }

    async assertNoSortButton(columnId: string): Promise<void> {
        await expect(this.columnHeader(columnId)).toBeVisible();
        await expect(this.sortButton(columnId)).toHaveCount(0);
    }

    // Column header menu

    async openColumnMenu(columnId: string): Promise<void> {
        await this.columnMenuItem(columnId, 'trigger').click();
        await expect(this.columnMenu(columnId)).toBeVisible();
    }

    async closeColumnMenu(columnId: string): Promise<void> {
        await closePopover(this.page, this.columnMenu(columnId));
    }

    async clickColumnSortItem(columnId: string, direction: 'asc' | 'desc'): Promise<void> {
        // `force`: Playwright would wait for an aria-disabled item to become enabled; the point is that pressing it is inert.
        await this.columnMenuItem(columnId, `sort-${direction}`).click({ force: true });
    }

    async assertColumnMenuOpen(columnId: string): Promise<void> {
        await expect(this.columnMenu(columnId)).toBeVisible();
    }

    /** Both sort items are `aria-disabled` and the reason text is shown. */
    async assertSortItemsDisabled(columnId: string): Promise<void> {
        for (const direction of ['asc', 'desc'] as const) {
            await expect(this.columnMenuItem(columnId, `sort-${direction}`), `sort-${direction}`).toHaveAttribute('aria-disabled', 'true');
        }
        await expect(this.columnMenuItem(columnId, 'sort-unavailable')).toHaveText(NOT_SORTABLE_REASON);
    }

    // Pager

    async pageSizeOptions(): Promise<number[]> {
        return (await readSelectOptions(this.page, this.pageSizeSelect, { allowEmpty: true })).map(Number);
    }

    async selectedPageSize(): Promise<number> {
        return Number(collapse((await this.pageSizeSelect.trigger.textContent()) ?? ''));
    }

    /** Chooses a page size (no request when it already is the size); returns the list request, which carries the page the UI kept. */
    async setPageSize(size: PageSize): Promise<ListObservation | undefined> {
        if ((await this.selectedPageSize()) === size) return undefined;
        return this.observe(() => chooseOption(this.page, this.pageSizeSelect, String(size)), (body) => body.itemsPerPage === size);
    }

    async goToPage(pageNumber: number): Promise<ListObservation> {
        return this.observe(() => this.pageButton(pageNumber).click(), (body) => body.pageNumber === pageNumber);
    }

    /** The page-size control is shown only while the list has rows. */
    async assertPageSizeControl(visible: boolean): Promise<void> {
        await expect(this.pageSizeSelect.trigger).toHaveCount(visible ? 1 : 0);
    }

    /** The pager shows `pages` page buttons (up to 7) with `page` current; Previous / Next are disabled at the ends. */
    async assertPager(expected: { page: number; pages: number }): Promise<void> {
        await expect(this.pager).toBeVisible();
        if (expected.pages <= 7) await expect(this.pagerPageButtons).toHaveCount(expected.pages);
        await expect(this.pageButton(expected.page)).toHaveAttribute('aria-current', 'page');
        await expect(this.currentPageButtons).toHaveCount(1);
        if (expected.page === 1) await expect(this.previousPageButton).toBeDisabled();
        else await expect(this.previousPageButton).toBeEnabled();
        if (expected.page === expected.pages) await expect(this.nextPageButton).toBeDisabled();
        else await expect(this.nextPageButton).toBeEnabled();
    }

    /** One page or none: the pager is not mounted at all. */
    async assertPagerHidden(): Promise<void> {
        await expect(this.pager).toHaveCount(0);
    }

    /** `Showing <from> to <to> items of <total>`; null while there are no rows (the line is hidden). */
    async pagerSummary(): Promise<{ from: number; to: number; total: number } | null> {
        if ((await this.pagerSummaryLine.count()) === 0) return null;
        const m = PAGER_SUMMARY.exec(collapse((await this.pagerSummaryLine.first().textContent()) ?? ''));
        return m ? { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]) } : null;
    }

    // Selection and the bulk toolbar

    async checkRows(commonNames: readonly string[]): Promise<void> {
        for (const name of commonNames) await (await this.rowByCommonName(name)).getByRole('checkbox').check();
    }

    async checkedCommonNames(): Promise<string[]> {
        const index = await this.columnIndex('property:COMMON_NAME');
        return (await this.checkedRows.locator(`td:nth-child(${index + 1})`).allTextContents()).map(collapse);
    }

    /** The bulk toolbar (Override Groups, Archive, …) is enabled exactly while a row is checked. */
    async assertBulkToolbar(enabled: boolean): Promise<void> {
        if (enabled) await expect(this.overrideGroupsButton).toBeEnabled();
        else await expect(this.overrideGroupsButton).toBeDisabled();
    }
}
