/**
 * InventoryPage — page object of the certificate inventory LIST (`/certificates`, fe-administrator
 * `_pages/certificates/list/index.tsx` on `PagedList` + `CustomTable`): filter widget host, sortable headers, page size,
 * pager, row selection, the include-archived switch, and the value rendering of the Standard columns. The detail / issue flows
 * stay in `CertificatePage`; this class owns the list only (phase-05 B2.1).
 *
 * Contract (fe-administrator origin/main, 2026-10-14):
 * - the table is `data-testid="custom-table"`; a header is `th[data-id=<column key>]` with `aria-sort` ONLY on the sorted one
 *   (`CustomTable/index.tsx:101-107,677-679`); the key is `<source>:<identifier>` (`utils/tableColumns.tsx:116-118`), the checkbox
 *   column is `__checkbox__` (`:658`); a sortable heading is a button holding the sort arrow `sort-indicator` with
 *   `data-direction` asc / desc / none (`:626-653,720-734`); a column that cannot be ordered has no such button and its
 *   `ColumnHeaderMenu` (`column-header-menu-<key>-*`) shows both sort items `aria-disabled` with the reason
 *   `This field cannot be used for ordering.` (`ColumnHeaderMenu/index.tsx:21,192-216`; PagedList.tsx:535-548);
 * - rows are `tr[data-id=<uuid>]`, cell `n` is the `n`-th `td` (the checkbox column first, `:810-846`); an empty cell is the shared
 *   `empty-cell` (an em dash plus the screen-reader text `No value`, `CustomTable/columns/EmptyCell.tsx:6-13`);
 * - page size is the Select `select-pageSize-*` (options 10 / 25 / 50 / 100, `utils/pagination.ts:1`, `CustomTable/index.tsx:965-981`),
 *   shown only when there are rows; the pager is `pagination-prev|next|page-<n>` and is mounted only when there is more than one
 *   page (`:985-992`); the summary reads `Showing <a> to <b> items of <total>` (`:996-1004`); the controls are disabled while a
 *   fetch is in flight (`PagedList.tsx:802-804`); a page-size change keeps the page holding the first visible row
 *   (`CustomTable/index.tsx:596-608`); every fetch clears the row selection (`PagedList.tsx:414-417`);
 * - the bulk toolbar buttons (`group-button`, `archive-button`, …) are disabled while no row is checked (`list/index.tsx:167-210`);
 * - the include-archived switch is `switch-archived-switch-input` (`list/index.tsx:309-315`, `Switch/index.tsx:57-70`).
 *
 * Value rendering: `formatForDisplay` is the PURE expectation of one cell, written from the FE's rules (it calls nothing from the FE):
 * the cell registry `certificateTableHelpers.tsx:187-247`, the shared empty state `buildTableRows.tsx:11-26`, the date formatter
 * `utils/dateUtil.ts:41-57`, the status label `utils/certificate.tsx:207-243`.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Navigation } from './Navigation';
import { FilterWidget, ListBody, ListObservation, Json, PickedDate, PlatformLabels, observeListRequest, pickOption, readOptions } from './FilterWidget';

// ------------------------------------------------------------------ the Standard columns

/** The 16 Standard columns in display order, with the heading each ships (`certificateTableHelpers.tsx:99-180`; ids `<source>:<identifier>`). */
export const STANDARD_COLUMNS: ReadonlyArray<{ id: string; heading: string }> = [
    { id: 'property:CERTIFICATE_STATE', heading: 'State' },
    { id: 'property:CERTIFICATE_VALIDATION_STATUS', heading: 'Validation' },
    { id: 'property:COMPLIANCE_STATUS', heading: 'Compliance' },
    { id: 'property:PRIVATE_KEY', heading: 'Has private key' },
    { id: 'property:COMMON_NAME', heading: 'Common Name' },
    { id: 'property:NOT_BEFORE', heading: 'Valid From' },
    { id: 'property:NOT_AFTER', heading: 'Expires At' },
    { id: 'property:GROUP_NAME', heading: 'Groups' },
    { id: 'property:RA_PROFILE_NAME', heading: 'RA Profile' },
    { id: 'property:OWNER', heading: 'Owner' },
    { id: 'property:SERIAL_NUMBER', heading: 'Serial number' },
    { id: 'property:SIGNATURE_ALGORITHM', heading: 'Signature Algorithm' },
    { id: 'property:PUBLIC_KEY_ALGORITHM', heading: 'Public Key Algorithm' },
    { id: 'property:ISSUER_COMMON_NAME', heading: 'Issuer Common Name' },
    { id: 'property:CERTIFICATE_TYPE', heading: 'Certificate Type' },
    { id: 'property:ARCHIVED', heading: 'Archived' },
];

/** The reason a column that cannot be ordered gives (`ColumnHeaderMenu/index.tsx:21`). */
export const NOT_SORTABLE_REASON = 'This field cannot be used for ordering.';

/** The page sizes of every list table (`utils/pagination.ts:1`, fe#2193). */
export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

// ------------------------------------------------------------------ pure: what a cell shows

const clean = (s: string): string => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/** `utils/common-utils.ts:28-30`. */
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * `yyyy-MM-dd HH:mm:ss` in a time zone: the list's date cells (`dateFormatter`, `utils/dateUtil.ts:41-57`, which formats with the
 * BROWSER's local getters; the test passes the browser's own zone, so the runner's zone does not matter).
 */
export function formatDateTime(iso: string, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(new Date(iso));
    const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

export interface DisplayContext {
    /** The browser's IANA time zone (`InventoryPage.browserTimeZone()`). */
    timeZone: string;
    labels: PlatformLabels;
}

/** What one cell must show: an exact text, the shared empty state, or fragments (a multi-value cell). */
export type CellExpectation = { text: string } | { empty: true } | { contains: string[] };

/**
 * The expected cell of a Standard column for a list row (an element of the API's `certificates` array), derived from the display
 * rules, never from what the page shows. Each branch cites the FE rule it mirrors; a blank value renders the empty state
 * (`buildTableRows.tsx:11-26`: null, undefined and '' all become `EmptyCell`).
 */
export function formatForDisplay(columnId: string, row: Json, ctx: DisplayContext): CellExpectation {
    const text = (value: unknown): CellExpectation => (value === null || value === undefined || value === '' ? { empty: true } : { text: String(value) });
    switch (columnId) {
        // certificateTableHelpers.tsx:191-196 + CertificateStatus/index.tsx:12-26 (a coloured dot with the sr-only label), label: certificate.tsx:234-243
        case 'property:CERTIFICATE_STATE':
            return text(row.state ? capitalize(ctx.labels.display('CertificateState', String(row.state))) : undefined);
        // :197-199, label certificate.tsx:224-232
        case 'property:CERTIFICATE_VALIDATION_STATUS':
            return text(row.validationStatus ? capitalize(ctx.labels.display('CertificateValidationStatus', String(row.validationStatus))) : undefined);
        // :200-201, label certificate.tsx:253-258
        case 'property:COMPLIANCE_STATUS':
            return text(row.complianceStatus ? capitalize(ctx.labels.display('ComplianceStatus', String(row.complianceStatus))) : undefined);
        // :202-210: the key icon with the sr-only text, or nothing (the empty state) when no private key is available — never a "No" badge
        case 'property:PRIVATE_KEY':
            return row.privateKeyAvailability ? { text: 'Private key available' } : { empty: true };
        // :44-49
        case 'property:COMMON_NAME':
            return { text: String(row.commonName || '(empty)') };
        // :212-215 with dateFormatter (dateUtil.ts:41-57)
        case 'property:NOT_BEFORE':
            return row.notBefore ? { text: formatDateTime(String(row.notBefore), ctx.timeZone) } : { empty: true };
        case 'property:NOT_AFTER':
            return row.notAfter ? { text: formatDateTime(String(row.notAfter), ctx.timeZone) } : { empty: true };
        // :85-91, :216-219 + MultiValueCell.tsx:24-55: the first group, `+N` for the rest behind the toggletip
        case 'property:GROUP_NAME': {
            const groups = (row.groups ?? []) as Array<{ name?: string }>;
            if (groups.length === 0) return { empty: true };
            return groups.length === 1 ? { text: String(groups[0].name) } : { contains: [String(groups[0].name), `+${groups.length - 1}`] };
        }
        // :51-56, :220-221
        case 'property:RA_PROFILE_NAME':
            return row.raProfile ? { text: String(row.raProfile.name ?? 'Unassigned') } : { empty: true };
        // :58-63, :222
        case 'property:OWNER':
            return text(row.owner);
        // :223-226 (plain values), :65-70 (issuer)
        case 'property:SERIAL_NUMBER':
            return text(row.serialNumber);
        case 'property:SIGNATURE_ALGORITHM':
            return text(row.signatureAlgorithm);
        case 'property:PUBLIC_KEY_ALGORITHM':
            return text(row.publicKeyAlgorithm);
        case 'property:ISSUER_COMMON_NAME':
            return text(row.issuerCommonName);
        // :72-83, :227
        case 'property:CERTIFICATE_TYPE':
            return text(row.certificateType ? ctx.labels.display('CertificateType', String(row.certificateType)) : undefined);
        // :228-232
        case 'property:ARCHIVED':
            return { text: row.archived ? 'Yes' : 'No' };
        default:
            throw new Error(`no display rule for column ${columnId}`);
    }
}

/** The words that must never appear in a rendered table body. */
export const FORBIDDEN_RENDERED = /\b(?:null|undefined|NaN)\b|Invalid Date/;

/** The first forbidden word in a text (with a little context), or undefined. */
export function forbiddenWordIn(text: string): string | undefined {
    const m = FORBIDDEN_RENDERED.exec(text);
    return m ? text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20) : undefined;
}

// ------------------------------------------------------------------ the request log ("nothing is sent")

export interface SeenRequest {
    method: string;
    path: string;
}

/** Records every `/api/` request of the page (installed once; `mark()` / `since()` bracket a window). */
export class ApiTraffic {
    private readonly seen: SeenRequest[] = [];

    constructor(page: Page) {
        page.on('request', (request) => {
            try {
                const path = new URL(request.url()).pathname;
                if (path.includes('/api/')) this.seen.push({ method: request.method(), path });
            } catch {
                // not a URL: not an API request
            }
        });
    }

    mark(): number {
        return this.seen.length;
    }

    since(mark: number): SeenRequest[] {
        return this.seen.slice(mark);
    }

    /** Everything but GET / HEAD since the mark: writes and the list search (a POST). */
    nonReadsSince(mark: number): SeenRequest[] {
        return this.since(mark).filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
    }
}

// ------------------------------------------------------------------ the page

export interface CellState {
    /** textContent, whitespace collapsed. */
    text: string;
    /** The cell holds the shared empty state. */
    empty: boolean;
}

export class InventoryPage {
    readonly page: Page;
    readonly main: Locator;
    readonly filter: FilterWidget;
    readonly traffic: ApiTraffic;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.filter = new FilterWidget(page, this.main, { settle: () => this.waitSettled() });
        this.traffic = new ApiTraffic(page);
    }

    // ---- navigation and settling

    /** Sidebar → Certificates; returns once the list and the filter widget are rendered and no fetch is in flight. */
    async goToList(): Promise<void> {
        await new Navigation(this.page).openViaSidebar('Certificates', /\/certificates/i);
        await expect(this.main).toBeVisible();
        await this.waitSettled();
        await expect(this.filter.sourceTrigger).toBeVisible();
    }

    /** The table is shown, no skeleton and no busy overlay (a refetch keeps the old rows under the overlay, so rows alone prove nothing). */
    async waitSettled(): Promise<void> {
        await expect(this.table()).toBeVisible();
        await expect(this.main.getByTestId('table-skeleton')).toHaveCount(0);
        await expect(this.main.getByTestId('table-skeleton-row')).toHaveCount(0);
        await expect(this.main.getByTestId('widget-busy-overlay')).toHaveCount(0);
    }

    /** Runs an action and returns the certificate list request it caused (waited for before the action), settled. */
    async afterList(action: () => Promise<unknown>, match?: (body: ListBody) => boolean): Promise<ListObservation> {
        const seen = await observeListRequest(this.page, action, { match });
        await this.waitSettled();
        return seen;
    }

    // ---- the isolation filter

    /** `Common Name starts with <prefix>` through the widget: the filter every exact row-set oracle carries (phase-03 §7). Add it FIRST and keep its badge. */
    async isolate(prefix: string, labels: PlatformLabels): Promise<ListObservation> {
        return this.filter.addFilter({
            source: labels.source('property'),
            field: 'Common Name',
            condition: labels.condition('STARTS_WITH'),
            value: prefix,
        });
    }

    // ---- table structure

    table(): Locator {
        return this.main.getByTestId('custom-table');
    }

    rows(): Locator {
        return this.table().locator('tbody tr[data-id]');
    }

    /** A data row by its Common Name (the cell holds a link with exactly that text). */
    rowOf(commonName: string): Locator {
        return this.rows().filter({ has: this.page.getByRole('link', { name: commonName, exact: true }) });
    }

    private headers(): Locator {
        return this.table().locator('thead th[data-id]');
    }

    /** `th[data-id=<column key>]`. */
    header(columnId: string): Locator {
        return this.table().locator(`thead th[data-id="${columnId}"]`);
    }

    /** Every header id including the checkbox column, in order (a row's n-th `td` belongs to the n-th id). */
    private async allHeaderIds(): Promise<string[]> {
        return (await this.headers().evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''))).filter(Boolean);
    }

    /** The column ids shown, in order, without the checkbox column. */
    async visibleColumns(): Promise<string[]> {
        return (await this.allHeaderIds()).filter((id) => id !== '__checkbox__');
    }

    /** The headings as the page renders them (the heading span named by the header's `aria-labelledby`; CSS upper-casing is not part of the text). */
    async columnHeadings(): Promise<string[]> {
        return this.headers().evaluateAll((els) =>
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
        return (await this.rows().locator(`td:nth-child(${index + 1})`).allTextContents()).map(clean);
    }

    /** Every cell of one row in a single DOM read: column id → text and empty-state flag. */
    async readRow(commonName: string): Promise<Record<string, CellState>> {
        const ids = await this.allHeaderIds();
        const raw = await this.rowOf(commonName).evaluate((tr, headerIds) => {
            const cells = Array.from(tr.querySelectorAll(':scope > td'));
            const out: Record<string, { text: string; empty: boolean }> = {};
            headerIds.forEach((id, i) => {
                const td = cells[i];
                if (td) out[id] = { text: td.textContent ?? '', empty: td.querySelector('[data-testid="empty-cell"]') !== null };
            });
            return out;
        }, ids);
        return Object.fromEntries(Object.entries(raw).map(([id, c]) => [id, { text: clean(c.text), empty: c.empty }]));
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
                if (got.empty || got.text !== clean(want.text)) mismatches.push(`${column}: expected "${want.text}", got ${got.empty ? 'the empty state' : `"${got.text}"`}`);
            } else {
                const missing = want.contains.filter((part) => !got.text.includes(part));
                if (got.empty || missing.length) mismatches.push(`${column}: expected a cell with ${JSON.stringify(want.contains)}, got ${got.empty ? 'the empty state' : `"${got.text}"`}`);
            }
        }
        expect(mismatches, `cells of ${commonName}`).toEqual([]);
    }

    /** The text of the table body: every cell of every row shown, separated (a word at the end of one cell must not fuse with the next cell's text). */
    async bodyText(): Promise<string> {
        return (await this.table().locator('tbody td').allTextContents()).map(clean).join(' | ');
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
    async localDateOf(iso: string): Promise<{ year: number; month: number; day: number }> {
        return this.page.evaluate((value) => {
            const d = new Date(value);
            return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
        }, iso);
    }

    /**
     * A date-time picker value in the middle of a window: `days` after the anchor, at 12:00:00 on the browser's local calendar (noon
     * exists on every day, DST gaps included), with the UTC instant the FE will send for it. Domain analysis: the value must not sit on
     * a bound, so it throws when any of the given instants (the seeds' expiries) is less than `marginDays` away.
     */
    async midWindowPick(anchorIso: string, days: number, instants: readonly string[], marginDays = 5): Promise<{ picked: PickedDate; instant: string }> {
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
        return this.afterList(() => button.click());
    }

    /**
     * The header is the sorted one: `aria-sort` on it and on no other header (an unsorted header carries no attribute, so this is
     * asserted AFTER the click), its arrow shows the direction and every other arrow is the neutral one.
     */
    async assertSortedBy(columnId: string, direction: 'asc' | 'desc'): Promise<void> {
        const th = this.header(columnId);
        await expect(th, `aria-sort of ${columnId}`).toHaveAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
        await expect(this.table().locator('thead th[aria-sort]'), 'only one header is sorted').toHaveCount(1);
        await expect(th.getByTestId('sort-indicator')).toHaveAttribute('data-direction', direction);
        await expect(this.table().locator('thead [data-testid="sort-indicator"]:not([data-direction="none"])'), 'only one arrow').toHaveCount(1);
    }

    /** No header is sorted (the page opens with Core's own order). */
    async assertNotSorted(): Promise<void> {
        await expect(this.table().locator('thead th[aria-sort]')).toHaveCount(0);
        await expect(this.table().locator('thead [data-testid="sort-indicator"]:not([data-direction="none"])')).toHaveCount(0);
    }

    /** The header of a column that cannot be ordered has no sort button (a click does nothing, `columnState.ts:23-35`). */
    async assertNoSortButton(columnId: string): Promise<void> {
        await expect(this.header(columnId)).toBeVisible();
        await expect(this.sortButton(columnId)).toHaveCount(0);
    }

    /** Opens the column options menu (three dots) of a column; the menu is a portal. */
    async openColumnMenu(columnId: string): Promise<void> {
        await this.page.getByTestId(`column-header-menu-${columnId}-trigger`).click();
        await expect(this.page.getByTestId(`column-header-menu-${columnId}`)).toBeVisible();
    }

    async closeColumnMenu(columnId: string): Promise<void> {
        await this.page.keyboard.press('Escape');
        await expect(this.page.getByTestId(`column-header-menu-${columnId}`)).toBeHidden();
    }

    /** Selects a sort entry of the open column menu (a disabled entry is inert: the menu stays open and nothing is sent). */
    async pressSortItem(columnId: string, direction: 'asc' | 'desc'): Promise<void> {
        // `force`: a menu item marked aria-disabled is not "actionable" for Playwright, which would wait for it to become enabled; the
        // point here is that the press of a disabled entry is inert (the FE keeps it focusable and prevents the select, ColumnHeaderMenu/index.tsx:43-53).
        await this.page.getByTestId(`column-header-menu-${columnId}-sort-${direction}`).click({ force: true });
    }

    async assertColumnMenuOpen(columnId: string): Promise<void> {
        await expect(this.page.getByTestId(`column-header-menu-${columnId}`)).toBeVisible();
    }

    /** Both sort entries of an open column menu are `aria-disabled` and the reason text is shown (`ColumnHeaderMenu/index.tsx:192-216`). */
    async assertSortItemsDisabled(columnId: string, reason: string = NOT_SORTABLE_REASON): Promise<void> {
        for (const item of ['sort-asc', 'sort-desc']) {
            const entry = this.page.getByTestId(`column-header-menu-${columnId}-${item}`);
            await expect(entry, item).toHaveAttribute('aria-disabled', 'true');
        }
        await expect(this.page.getByTestId(`column-header-menu-${columnId}-sort-unavailable`)).toHaveText(reason);
    }

    // ---- paging

    private pageSizeTrigger(): Locator {
        return this.main.getByTestId('select-pageSize-trigger');
    }

    /** The page-size control is shown (it is hidden while the list has no rows). */
    async assertPageSizeControl(visible: boolean): Promise<void> {
        await expect(this.pageSizeTrigger()).toHaveCount(visible ? 1 : 0);
    }

    /** The options of the page-size control, as numbers, in order. */
    async pageSizeOptions(): Promise<number[]> {
        return (await readOptions(this.page, this.main, 'select-pageSize')).map(Number);
    }

    async selectedPageSize(): Promise<number> {
        return Number(clean((await this.pageSizeTrigger().textContent()) ?? ''));
    }

    /** Chooses a page size (no request when it is already the size); returns the list request, which carries the page the FE kept. */
    async setPageSize(size: PageSize): Promise<ListObservation | undefined> {
        if ((await this.selectedPageSize()) === size) return undefined;
        return this.afterList(() => pickOption(this.page, this.main, 'select-pageSize', String(size)), (body) => body.itemsPerPage === size);
    }

    /** Clicks a page number of the pager; returns the list request. */
    async goToPage(pageNumber: number): Promise<ListObservation> {
        const button = this.main.getByTestId(`pagination-page-${pageNumber}`);
        return this.afterList(() => button.click(), (body) => body.pageNumber === pageNumber);
    }

    async nextPage(): Promise<ListObservation> {
        return this.afterList(() => this.main.getByTestId('pagination-next').click());
    }

    async previousPage(): Promise<ListObservation> {
        return this.afterList(() => this.main.getByTestId('pagination-prev').click());
    }

    /** The pager shows `pages` page buttons (up to 7) with `page` current; Previous / Next are disabled at the ends. */
    async assertPager(expected: { page: number; pages: number }): Promise<void> {
        const pager = this.main.getByTestId('pagination');
        await expect(pager).toBeVisible();
        if (expected.pages <= 7) await expect(pager.getByTestId(/^pagination-page-\d+$/)).toHaveCount(expected.pages);
        await expect(this.main.getByTestId(`pagination-page-${expected.page}`)).toHaveAttribute('aria-current', 'page');
        await expect(pager.locator('[aria-current="page"]')).toHaveCount(1);
        if (expected.page === 1) await expect(this.main.getByTestId('pagination-prev')).toBeDisabled();
        else await expect(this.main.getByTestId('pagination-prev')).toBeEnabled();
        if (expected.page === expected.pages) await expect(this.main.getByTestId('pagination-next')).toBeDisabled();
        else await expect(this.main.getByTestId('pagination-next')).toBeEnabled();
    }

    /** One page or none: the pager is not mounted at all. */
    async assertPagerHidden(): Promise<void> {
        await expect(this.main.getByTestId('pagination')).toHaveCount(0);
    }

    /** `Showing <from> to <to> items of <total>`; null while there are no rows (the line is hidden). */
    async summary(): Promise<{ from: number; to: number; total: number } | null> {
        const line = this.main.getByText(/^Showing \d+ to \d+ items of \d+$/);
        if ((await line.count()) === 0) return null;
        const m = /^Showing (\d+) to (\d+) items of (\d+)$/.exec(clean((await line.first().textContent()) ?? ''));
        return m ? { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]) } : null;
    }

    // ---- selection and the bulk toolbar

    /** Ticks the checkboxes of the rows with these Common Names. */
    async checkRows(commonNames: readonly string[]): Promise<void> {
        for (const name of commonNames) await this.rowOf(name).getByRole('checkbox').check();
    }

    /** Common Names of the checked rows on the page shown. */
    async checkedCommonNames(): Promise<string[]> {
        const index = await this.columnIndex('property:COMMON_NAME');
        const checked = this.rows().filter({ has: this.page.locator('input[type="checkbox"]:checked') });
        return (await checked.locator(`td:nth-child(${index + 1})`).allTextContents()).map(clean);
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
        return this.afterList(() => label.click(), (body) => body.includeArchived === on);
    }

    async assertIncludeArchived(on: boolean): Promise<void> {
        await expect(this.main.getByTestId('switch-archived-switch-input')).toBeChecked({ checked: on });
    }
}

