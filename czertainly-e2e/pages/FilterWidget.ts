/**
 * FilterWidget — the list filter widget.
 *
 * WHAT: the list filter widget: Source / Field / Condition selects, the value control of the chosen condition
 *       (text, duration, list, boolean or the date picker), Add / Update and the badges.
 * WHY: REG-CERT-40 … 43 and REG-WFL-01 check what the widget offers, what it sends and what it shows; every action
 *       that changes the list returns the list request it caused (observed, never mocked); labels and badge texts
 *       are computed in `fieldLabels.ts`.
 * HOW: selects by id through the Select helper; the date picker is a portal found by its calendar (no test id yet,
 *       FE test-id request); the host page passes its "list loaded" wait and its list request matcher.
 */
import { expect, Locator, Page, Request } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { assertToast } from './ui/toast';
import { chooseOption, chooseOptions, OptionChoice, readSelectOptions, selectById, describeChoice } from './ui/select';
import { badgeTextOf } from '../utils/regression/inventory/fieldLabels';
import type { JsonObject } from '../utils/regression/json';
import { escapeRegExp } from '../utils/regression/text';
import { FILTER_LIST_REQUEST_MS, FILTER_REQUEST_SEEN_MS, FILTER_VALUE_SHOWN_MS, FILTER_FILL_SETTLE_MS, FILTER_BADGE_REOPEN_MS } from '../utils/regression/timeouts';

const logger = new Logger('FilterWidget');


// ------------------------------------------------------------------ the certificate list request

export interface ListBody {
    filters?: JsonObject[];
    itemsPerPage?: number;
    pageNumber?: number;
    sort?: JsonObject;
    columns?: JsonObject[];
    includeArchived?: boolean;
    [key: string]: unknown;
}

/** One certificate list request the page sent, with the answer. */
export interface ListObservation {
    request: Request;
    body: ListBody;
    status: number;
    json: JsonObject | undefined;
}

/** `POST /api/v1/certificates` (the list; `…/search` is the catalogue GET and never matches). */
export function isCertificateListRequest(request: Request): boolean {
    if (request.method() !== 'POST') return false;
    try {
        return /\/api\/v1\/certificates\/?$/.test(new URL(request.url()).pathname);
    } catch {
        return false;
    }
}

export function listBodyOf(request: Request): ListBody {
    try {
        return (request.postDataJSON() ?? {}) as ListBody;
    } catch {
        return {};
    }
}

/**
 * Runs `action` and returns the certificate list request it caused (optionally the first one whose body satisfies `match`)
 * with its answer. The wait is registered BEFORE the action, so a fast request cannot be missed; nothing is mocked. A request the
 * page itself cancelled (no response: the FE may supersede a list request with a newer one) is skipped for the next matching one.
 */
export async function observeListRequest(
    page: Page,
    action: () => Promise<unknown>,
    opts: { match?: (body: ListBody) => boolean; timeout?: number } = {},
): Promise<ListObservation> {
    const timeout = opts.timeout ?? FILTER_LIST_REQUEST_MS;
    const matches = (r: Request): boolean => isCertificateListRequest(r) && (!opts.match || opts.match(listBodyOf(r)));
    const collected: Request[] = [];
    const collect = (r: Request): void => {
        if (matches(r)) collected.push(r);
    };
    page.on('request', collect);
    try {
        const requested = page.waitForRequest(matches, { timeout });
        requested.catch(() => undefined); // an action that throws first must not leave an unhandled rejection behind
        await action();
        let request = await requested;
        let response = await request.response();
        for (let retry = 0; !response && retry < 3; retry++) {
            const later = collected.slice(collected.indexOf(request) + 1)[0];
            request = later ?? (await page.waitForRequest(matches, { timeout: Math.min(timeout, FILTER_REQUEST_SEEN_MS) }));
            response = await request.response();
        }
        if (!response) throw new Error(`the list request ${request.url()} got no response`);
        let json: JsonObject | undefined;
        try {
            json = (await response.json()) as JsonObject;
        } catch {
            json = undefined;
        }
        return { request, body: listBodyOf(request), status: response.status(), json };
    } finally {
        page.off('request', collect);
    }
}

// ------------------------------------------------------------------ the widget

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** A day (and, for a date-time picker, a time) to pick; `month` is 1-12. The wall clock is the browser's (the picker is local). */
export interface PickedDate {
    year: number;
    month: number;
    day: number;
    hours?: number;
    minutes?: number;
    seconds?: number;
}

export type FilterValue = string | number | string[] | PickedDate;

const isPickedDate = (v: FilterValue): v is PickedDate => typeof v === 'object' && !Array.isArray(v);

export type ValueKind = 'text' | 'select' | 'date';

/** A Source / Field / Condition option: its label (exact name, then prefix), a pattern, or its `data-value` code. */
export type FilterChoice = OptionChoice;

export interface FilterSpec {
    source: FilterChoice;
    field: FilterChoice;
    condition: FilterChoice;
    /** Omitted for EMPTY / NOT_EMPTY (the value control is disabled and no `value` key is sent). */
    value?: FilterValue;
}

/**
 * One item of a workflow condition form: the three selects, then ONE value: a text, a list / boolean option or a day of the current month
 * (none for EMPTY / NOT_EMPTY).
 */
export interface FilterItem {
    source: FilterChoice;
    field: FilterChoice;
    condition: FilterChoice;
    /** A text / number value. */
    text?: string;
    /** A list value (RA profile, group, owner, boolean): the option to choose. */
    option?: FilterChoice;
    /** A date: the day of the CURRENT month to click in the calendar (date-only attributes). */
    dayOfCurrentMonth?: number;
}

export class FilterWidget {
    readonly page: Page;
    readonly scope: Locator;
    private readonly waitForListLoaded: () => Promise<void>;
    private readonly anyBadge: boolean;
    readonly sourceTrigger: Locator;
    /** The text / number / duration box (`text-input-valueSelect`). */
    readonly textValue: Locator;
    /** The list / boolean value Select trigger. */
    readonly selectValue: Locator;
    /**
     * The date picker input: a plain `input#valueSelect` (the TextInput carries a test id, the Select's hidden native `<select>` is not an
     * input).
     */
    readonly dateValue: Locator;
    /** `Add`, or `Update` while a badge is loaded; `#addFilter` as the fallback. */
    readonly addButton: Locator;
    /**
     * The filter badges: badge buttons that carry the inner `Remove badge` (table status badges do not); every badge for the condition
     * widgets.
     */
    readonly badgeLocator: Locator;
    /** The hint under the duration box (rendered by the FilterWidget component). */
    readonly durationHint: Locator;

    /**
     * `waitForListLoaded` is the host page's wait for a loaded list. `anyBadge` counts every `badge` test id of the scope (the workflow
     * condition widgets); by default only the filter badges that carry the inner `Remove badge` button count.
     */
    constructor(page: Page, scope: Locator = page.locator('main'), opts: { waitForListLoaded?: () => Promise<void>; anyBadge?: boolean } = {}) {
        this.page = page;
        this.scope = scope;
        this.waitForListLoaded = opts.waitForListLoaded ?? (async () => undefined);
        this.anyBadge = opts.anyBadge ?? false;
        this.sourceTrigger = scope.getByTestId('select-group-trigger');
        this.textValue = scope.getByTestId('text-input-valueSelect');
        this.selectValue = scope.getByTestId('select-valueSelect-trigger');
        this.dateValue = scope.locator('input#valueSelect:not([data-testid])');
        this.addButton = scope
            .getByRole('button', { name: 'Add', exact: true })
            .or(scope.getByRole('button', { name: 'Update', exact: true }))
            .or(scope.locator('#addFilter'))
            .first();
        const badges = scope.getByTestId('badge');
        this.badgeLocator = this.anyBadge ? badges : badges.filter({ has: page.getByRole('button', { name: 'Remove badge' }) });
        this.durationHint = scope.getByText('Duration in format: 0d 0h 0m 0s');
    }

    /** The widget inside the open workflow condition form dialog (`condition-form-filter`): it sends no list request. */
    static inDialog(page: Page): FilterWidget {
        return new FilterWidget(page, page.getByRole('dialog').getByTestId('condition-form-filter'), { anyBadge: true });
    }

    /** The widget titled "Condition Items" on a workflow condition detail page. */
    static onConditionDetail(page: Page): FilterWidget {
        const scope = page.locator('main section').filter({ has: page.getByRole('heading', { name: 'Condition Items', exact: true }) }).last();
        return new FilterWidget(page, scope, { anyBadge: true });
    }

    private select(id: string) {
        return selectById(this.page, this.scope, id);
    }

    // ---- observation

    /** The badge texts in order, normalised (`Property 'Common Name' contains 'x'`). */
    async badges(): Promise<string[]> {
        return (await this.badgeLocator.allTextContents()).map(badgeTextOf);
    }

    /** The Source select's options (labels, in order). */
    async offeredSources(): Promise<string[]> {
        return readSelectOptions(this.page, this.select('group'), { allowEmpty: true });
    }

    /** The Field select's options for the chosen Source (labels, in order). */
    async offeredFields(): Promise<string[]> {
        return readSelectOptions(this.page, this.select('field'), { allowEmpty: true });
    }

    /** The Condition select's options for the chosen Field (labels, in order). */
    private async offeredConditions(): Promise<string[]> {
        return readSelectOptions(this.page, this.select('conditions'), { allowEmpty: true });
    }

    /** Which control the current condition shows (waits for one to render; the control is re-created on every selection). */
    async valueKind(): Promise<ValueKind> {
        await expect(this.textValue.or(this.selectValue).or(this.dateValue).first(), 'a filter value control').toBeVisible();
        if ((await this.textValue.count()) > 0) return 'text';
        if ((await this.selectValue.count()) > 0) return 'select';
        return 'date';
    }

    // ---- actions

    /**
     * Picks Source, Field and / or Condition by label (order matters: a later select resets on an earlier change; fe#994: pick the
     * condition BEFORE the value).
     */
    async choose(selection: { source?: FilterChoice; field?: FilterChoice; condition?: FilterChoice }): Promise<void> {
        if (selection.source !== undefined) await chooseOption(this.page, this.select('group'), selection.source);
        if (selection.field !== undefined) await chooseOption(this.page, this.select('field'), selection.field);
        if (selection.condition !== undefined) await chooseOption(this.page, this.select('conditions'), selection.condition);
    }

    /**
     * Fills the value control the current condition shows: text / number / duration, list labels (one or several), a boolean label, or a
     * date to pick.
     */
    async fillValue(value: FilterValue): Promise<void> {
        const kind = await this.valueKind();
        if (kind === 'date') {
            if (!isPickedDate(value)) throw new Error('the date picker needs a PickedDate');
            await this.pickDate(value);
            return;
        }
        if (kind === 'select') {
            await this.chooseValues(Array.isArray(value) ? value : [String(value)]);
            return;
        }
        if (isPickedDate(value) || Array.isArray(value)) throw new Error('a text box takes a string or a number');
        await this.typeText(String(value));
    }

    private async typeText(text: string): Promise<void> {
        const input = this.textValue;
        // The box is readonly until it has focus (anti-autofill, TextInput): click, then fill; retry once the effect re-applied readonly.
        await expect(async () => {
            await input.click();
            await input.fill(text);
            await expect(input).toHaveValue(text, { timeout: FILTER_VALUE_SHOWN_MS });
        }).toPass({ timeout: FILTER_FILL_SETTLE_MS });
    }

    /**
     * List / boolean values: open the Select, click each label, close the popover (a multi-select keeps it open, a single one closes it).
     */
    private async chooseValues(labels: string[]): Promise<void> {
        await chooseOptions(this.page, this.select('valueSelect'), labels);
    }

    /** The calendar portal: the `<body>` child that holds the weekday header (the app root never does). */
    private calendar(): Locator {
        return this.page.locator('body > div').filter({ hasText: /Mo\s*Tu\s*We\s*Th\s*Fr\s*Sa\s*Su/ });
    }

    /** Month index (0-11) and year the open calendar shows (shown by the DatePicker component). */
    private async shownMonth(calendar: Locator): Promise<{ month: number; year: number }> {
        const monthText = (await calendar.getByText(new RegExp(`^(${MONTHS.join('|')})$`)).first().textContent())?.trim() ?? '';
        const yearText = (await calendar.getByText(/^\d{4}$/).first().textContent())?.trim() ?? '';
        const month = MONTHS.indexOf(monthText as (typeof MONTHS)[number]);
        if (month < 0 || !/^\d{4}$/.test(yearText)) throw new Error(`the calendar shows "${monthText} / ${yearText}"`);
        return { month, year: Number(yearText) };
    }

    /**
     * Picks a day in the date picker: opens it, walks Previous / Next to the month, clicks the enabled day button (other-month
     * days are disabled, so a number shared with a neighbour month is unambiguous) and, for the date-time picker, sets the
     * time inputs and presses Confirm. Returns what the input then shows (`dd.mm.yyyy[ HH:MM:SS]`).
     */
    async pickDate(date: PickedDate): Promise<string> {
        const input = this.dateValue;
        await expect(input, 'the date picker is enabled').toBeEnabled();
        await input.click();
        const calendar = this.calendar();
        await expect(calendar).toBeVisible();
        let reached = false;
        for (let step = 0; step < 600 && !reached; step++) {
            const shown = await this.shownMonth(calendar);
            const diff = (date.year - shown.year) * 12 + (date.month - 1 - shown.month);
            if (diff === 0) {
                reached = true;
                break;
            }
            await calendar.getByRole('button', { name: diff > 0 ? 'Next' : 'Previous', exact: true }).click();
            await expect.poll(async () => JSON.stringify(await this.shownMonth(calendar))).not.toBe(JSON.stringify(shown));
        }
        if (!reached) throw new Error(`the calendar did not reach ${date.year}-${String(date.month).padStart(2, '0')}`);
        await calendar.locator('button:not([disabled])').filter({ hasText: new RegExp(`^${date.day}$`) }).click();
        const timeInputs = calendar.locator('input[type="number"]');
        if ((await timeInputs.count()) > 0) {
            // The date-time picker: the day click keeps it open; every time input re-emits the full value.
            if (date.hours !== undefined) await timeInputs.nth(0).fill(String(date.hours));
            if (date.minutes !== undefined) await timeInputs.nth(1).fill(String(date.minutes));
            if (date.seconds !== undefined) await timeInputs.nth(2).fill(String(date.seconds));
            await calendar.getByRole('button', { name: 'Confirm', exact: true }).click();
        }
        await expect(calendar).toBeHidden();
        return input.inputValue();
    }

    /**
     * The UTC instant (`new Date(y, m-1, d, h, mi, s).toISOString()`) a picked wall-clock time stands for in the BROWSER's time zone: the
     * value the FE sends (the date helper of the admin UI).
     */
    async instantOf(date: PickedDate): Promise<string> {
        return this.page.evaluate(
            ({ year, month, day, hours, minutes, seconds }) => new Date(year, month - 1, day, hours ?? 0, minutes ?? 0, seconds ?? 0).toISOString(),
            date,
        );
    }

    /** Runs an action and returns the certificate list request it caused (waited for before the action), after the host's load wait. */
    async observeListRequest(action: () => Promise<unknown>, match?: (body: ListBody) => boolean): Promise<ListObservation> {
        const seen = await observeListRequest(this.page, action, { match });
        await this.waitForListLoaded();
        return seen;
    }

    /** Clicks `Add` / `Update` and returns the list request it caused (a duplicate filter sends none: use `addExpectingNoRequest`). */
    async add(): Promise<ListObservation> {
        const button = this.addButton;
        await expect(button).toBeEnabled();
        return this.observeListRequest(() => button.click());
    }

    /** Clicks `Add` for a case that must NOT reach the server (a duplicate source + field + condition: alert, no request). */
    async addExpectingNoRequest(): Promise<void> {
        const button = this.addButton;
        await expect(button).toBeEnabled();
        await button.click();
    }

    /** One filter through the three selects, the value and `Add`; the condition is chosen BEFORE the value (fe#994). */
    async addFilter(spec: FilterSpec): Promise<ListObservation> {
        await this.choose({ source: spec.source, field: spec.field, condition: spec.condition });
        if (spec.value !== undefined) await this.fillValue(spec.value);
        logger.info(`add filter ${describeChoice(spec.source)} / ${describeChoice(spec.field)} / ${describeChoice(spec.condition)}`);
        return this.add();
    }

    /** Waits until the field catalogue of the chosen resource is loaded (the spinner is gone, the source select is enabled). */
    async waitForFilterCatalogue(): Promise<void> {
        await expect(this.scope.getByTestId('spinner')).toHaveCount(0);
        await expect(this.sourceTrigger).toBeEnabled();
    }

    /**
     * The labels the Field select offers for a source (picks the source, opens and closes the select); an empty list when the source has no
     * field.
     */
    async fieldLabels(source: FilterChoice): Promise<string[]> {
        await chooseOption(this.page, this.select('group'), source);
        if (!(await this.scope.getByTestId('select-field-trigger').isEnabled())) return [];
        return readSelectOptions(this.page, this.select('field'));
    }

    /**
     * Adds one item to a widget that sends no list request (the workflow condition form): the three selects, the value, Add; the
     * badge appears and the controls reset. A list value select that stays open (multi) is closed with Escape.
     */
    async addItem(item: FilterItem): Promise<void> {
        logger.info(`adding condition item ${describeChoice(item.source)} / ${describeChoice(item.field)} / ${describeChoice(item.condition)}`);
        const before = await this.badgeLocator.count();
        await this.choose({ source: item.source, field: item.field, condition: item.condition });
        if (item.text !== undefined) await this.typeText(item.text);
        else if (item.option !== undefined) await chooseOptions(this.page, this.select('valueSelect'), [item.option]);
        else if (item.dayOfCurrentMonth !== undefined) await this.pickDayOfCurrentMonth(item.dayOfCurrentMonth);
        await expect(this.addButton).toBeEnabled();
        await this.addButton.click();
        await expect(this.badgeLocator).toHaveCount(before + 1);
    }

    /** Opens the date picker and clicks an enabled day button of the month it shows (the current one: date-only attributes). */
    private async pickDayOfCurrentMonth(day: number): Promise<void> {
        await this.scope.locator('#valueSelect').click();
        await this.page.getByRole('button', { name: String(day), exact: true }).and(this.page.locator(':enabled')).first().click();
    }

    /**
     * The badge texts, whitespace-normalised and without the "Remove badge" suffix. A badge is empty until the field catalogue and the
     * enums are loaded, so the read waits until at least one badge exists and every badge has text (`expected` pins their number).
     */
    async badgeTexts(expected?: number): Promise<string[]> {
        let texts: string[] = [];
        await expect(async () => {
            texts = (await this.badgeLocator.allInnerTexts()).map(badgeTextOf);
            expect(texts.length, 'the widget shows badges').toBeGreaterThan(0);
            if (expected !== undefined) expect(texts.length).toBe(expected);
            expect(texts.every(Boolean), `every badge is rendered (the catalogue is loaded): ${JSON.stringify(texts)}`).toBe(true);
        }).toPass({ timeout: FILTER_BADGE_REOPEN_MS });
        return texts;
    }

    /**
     * One badge shows the source label, the field label (in quotes) and the condition label (and the value when given):
     * `Property 'Common Name' Equals 'x'`. The condition is compared case-insensitively (the platform enum label is lower case,
     * the UI may capitalise it); the field may carry a content-type suffix for duplicated custom labels (`label (String)`).
     */
    async assertBadge(parts: { source: string; field: string; condition: string; value?: string }): Promise<void> {
        const texts = await this.badgeTexts();
        // The whole badge is matched segment by segment, so "Equals" never hits "Not equals" and a field label is not a prefix of another.
        const value = parts.value === undefined ? "(?: '.*')?" : ` '${escapeRegExp(parts.value)}'`;
        const wanted = new RegExp(`^${escapeRegExp(parts.source)} '${escapeRegExp(parts.field)}(?: \\([^)]*\\))?' ${escapeRegExp(parts.condition)}${value}$`, 'i');
        const hit = texts.find((t) => wanted.test(t));
        expect(hit, `a badge ${JSON.stringify(parts)} (${String(wanted)}) among ${JSON.stringify(texts)}`).toBeTruthy();
    }

    /** Selecting a saved badge repopulates the three selects: the hidden native selects hold the raw codes. */
    async readBadgeCodes(index: number): Promise<{ source: string; field: string; condition: string }> {
        await this.badgeTexts();
        await this.badgeLocator.nth(index).click();
        // The widget repopulates group / field / condition from the saved filter in a useEffect AFTER the click: wait until each
        // hidden select holds a code, then read.
        for (const id of ['select-group-input', 'select-field-input', 'select-conditions-input']) {
            await expect(this.scope.getByTestId(id), `${id} is repopulated from the clicked badge`).not.toHaveValue('');
        }
        const source = await this.scope.getByTestId('select-group-input').inputValue();
        const field = await this.scope.getByTestId('select-field-input').inputValue();
        const condition = await this.scope.getByTestId('select-conditions-input').inputValue();
        return { source, field, condition };
    }

    /** Loads the badge into the form (button turns into `Update`); `update()` then applies the change. */
    async editBadge(text: string): Promise<void> {
        await expect.poll(() => this.badges(), { message: `badge "${text}"` }).toContain(text);
        const index = (await this.badges()).indexOf(text);
        await this.badgeLocator.nth(index).locator('b').first().click();
        await expect(this.addButton).toHaveText('Update');
    }

    /** Applies the loaded badge's edit (optionally loads `badgeText` first) and returns the list request. */
    async update(badgeText?: string): Promise<ListObservation> {
        if (badgeText !== undefined) await this.editBadge(badgeText);
        return this.add();
    }

    /** Removes one badge by its text; returns the list request that follows. */
    async removeBadge(text: string): Promise<ListObservation> {
        await expect.poll(() => this.badges(), { message: `badge "${text}"` }).toContain(text);
        const index = (await this.badges()).indexOf(text);
        const remove = this.badgeLocator.nth(index).getByRole('button', { name: 'Remove badge' });
        return this.observeListRequest(() => remove.click());
    }

    /**
     * The list widget's Reset (filters, paging, sort; the columns and Include archived stay): `Reset filters, sorting and pagination`.
     * Sends a list request only when something was not at its default.
     */
    async reset(): Promise<ListObservation> {
        const button = this.scope.getByRole('button', { name: 'Reset filters, sorting and pagination' });
        return this.observeListRequest(() => button.click());
    }

    // ---- assertions

    /** The Condition select offers exactly these labels (set equality; `ordered` also compares the order). */
    async assertConditionsOffered(expected: readonly string[], opts: { ordered?: boolean } = {}): Promise<void> {
        const offered = await this.offeredConditions();
        if (opts.ordered) expect(offered, 'conditions offered, in order').toEqual([...expected]);
        else expect([...offered].sort(), 'conditions offered').toEqual([...expected].sort());
    }

    async assertBadges(expected: readonly string[]): Promise<void> {
        await expect.poll(() => this.badges(), { message: 'filter badges' }).toEqual([...expected]);
    }

    async assertAddDisabled(): Promise<void> {
        await expect(this.addButton).toBeDisabled();
    }

    async assertAddEnabled(): Promise<void> {
        await expect(this.addButton).toBeEnabled();
    }

    /** EMPTY / NOT_EMPTY: the value control is disabled, not hidden (FilterWidget component). */
    async assertValueControlDisabled(): Promise<void> {
        const kind = await this.valueKind();
        const control = kind === 'text' ? this.textValue : kind === 'select' ? this.selectValue : this.dateValue;
        await expect(control).toBeDisabled();
    }

    /** A refused list request shows a danger toast with the server's text (`…(422): <text>`). */
    async assertRefusalAlert(text: RegExp | string): Promise<void> {
        await assertToast(this.page, text, { severity: 'danger' });
    }
}
