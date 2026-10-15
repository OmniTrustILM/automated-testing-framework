/**
 * FilterWidget — page object of the list filter widget (fe-administrator `components/FilterWidget`), the one the
 * certificate inventory, the discovery list and the workflow condition forms share (phase-04 A4 / A5 / A7 / A8).
 *
 * Contract it drives (fe-administrator origin/main, 2026-10-14; `FilterWidget/index.tsx:…` below):
 * - three single selects Source / Field / Condition: `select-group-*`, `select-field-*`, `select-conditions-*`
 *   (`:723-779`; each Radix popover is `select-<id>-trigger` + a portalled `select-<id>-content` with `role=option` rows,
 *   `components/Select/index.tsx:473-584`); the options are the catalogue's own: groups, fields with at least one condition,
 *   `field.conditions` in catalogue order (`:255-263`, `:757-768`), labelled by the platform enums (the FE has no condition table);
 * - the value control depends on field type and condition (`:513-674`): a TextInput `text-input-valueSelect` (readonly until
 *   focused: click, then fill), a duration TextInput for IN_NEXT / IN_PAST (`:514-529`), an integer box for COUNT_* (`:626-643`),
 *   a Select `select-valueSelect-*` for lists (multi-select keeps its popover open, `Select/index.tsx:314`) and booleans
 *   (`True` / `False`, `:577-593`), or the DatePicker `input#valueSelect` (readonly, `DatePicker/index.tsx:319-342`; the calendar
 *   is a portal in `<body>`: buttons `Previous` / `Next`, the month / year in plain spans, day buttons named by the number,
 *   other-month days disabled; a date-time picker adds `Time:` inputs and `Confirm`, `:346-516`);
 * - one button `Add` (or `Update` while a badge is loaded) with id `addFilter` (`:786-798`), disabled until field, condition
 *   and a valid value are set (`:788-793`: an invalid duration or regex keeps it disabled, no message of its own for a duration);
 * - one badge per filter, a `<button data-testid="badge">` with an inner `Remove badge` button (`Badge/index.tsx:79-106`);
 *   its text is `<Source>&nbsp;'<Field>'&nbsp;<condition>&nbsp;'<value>'` (`:499-509`, values `:676-712`: lists `a OR b`, durations
 *   `30d`, date-times in local time `yyyy-MM-dd HH:mm:ss`, EMPTY / NOT_EMPTY an empty `''`).
 *
 * Design notes:
 * - every action that changes the list returns a `ListObservation` (the certificate list request the click caused, its status
 *   and JSON), observed with `page.waitForRequest` REGISTERED BEFORE the click; no mock, nothing is rewritten;
 * - the labels of sources, conditions and enum values are not hard-coded: `PlatformLabels` reads them from `GET /api/v1/enums`,
 *   which is where the FE reads them;
 * - `settle` (optional) is the host page's "list settled" wait, so a caller never asserts rows of the previous request.
 */
import { expect, Locator, Page, Request } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { CatalogueGroup, Filter, findField } from '../utils/regression/inventoryApi';
import { assertToast } from './RegressionUi';

const logger = new Logger('FilterWidget');

export type Json = Record<string, any>;

// ------------------------------------------------------------------ platform labels (GET /api/v1/enums)

/** `GET /api/v1/enums`: enum name (the class simple name) → item code → item (`EnumServiceImpl.getPlatformEnums`). */
export type PlatformEnums = Record<string, Record<string, { code?: string; label: string; description?: string | null }>>;

/** The platform enum labels the UI shows (`getEnumLabel`, `ducks/enums.ts`: the label, or the code itself when missing). */
export class PlatformLabels {
    constructor(readonly enums: PlatformEnums) {}

    /** Reads the enums the way the FE does (one GET, any authenticated principal). */
    static async read(api: APIRequestContext): Promise<PlatformLabels> {
        const res = await api.get('/api/v1/enums');
        if (!res.ok()) throw new Error(`GET /api/v1/enums answered ${res.status()}`);
        return new PlatformLabels((await res.json()) as PlatformEnums);
    }

    /** The label of an enum item; a missing enum or item is an error here (a test must not guess a label). */
    label(enumName: string, code: string): string {
        const item = this.enums[enumName]?.[code];
        if (!item || typeof item.label !== 'string') throw new Error(`platform enum ${enumName} has no item "${code}"`);
        return item.label;
    }

    /** What the FE shows for an enum item: the label, or the code itself when the item is unknown (`getEnumLabel`, `ducks/enums.ts:44-45`). */
    display(enumName: string, code: string): string {
        return this.enums[enumName]?.[code]?.label ?? code;
    }

    /** `FilterConditionOperator` item label, e.g. STARTS_WITH → `starts with` (interfaces `FilterConditionOperator.java:15-34`). */
    condition(code: string): string {
        return this.label('FilterConditionOperator', code);
    }

    /** `FilterFieldSource` item label, e.g. `property` → `Property`, `custom` → `Custom attribute`. */
    source(code: string): string {
        return this.label('FilterFieldSource', code);
    }
}

// ------------------------------------------------------------------ pure helpers (unit-tested)

/** A filter field as the catalogue sends it (the members the widget reads). */
export interface WidgetField {
    fieldIdentifier: string;
    fieldLabel: string;
    conditions: string[];
    attributeContentType?: string;
}

const normalizeLabel = (label: string): string => label.trim().toLowerCase();

/**
 * The label each field of a catalogue group gets in the Field select (`buildFieldLabelMap`, `FilterWidget/index.tsx:82-108`,
 * fe#1627): a label shared by several fields gets the attribute content type appended, and a label still shared gets
 * ` — <identifier>`. `contentTypeLabel` maps an attribute content type code to its platform label (`AttributeContentType` enum).
 */
export function fieldLabelMap(fields: readonly WidgetField[], contentTypeLabel: (code: string) => string): Map<string, string> {
    const counts = new Map<string, number>();
    for (const f of fields) counts.set(normalizeLabel(f.fieldLabel), (counts.get(normalizeLabel(f.fieldLabel)) ?? 0) + 1);
    const withType = fields.map((f) => {
        const duplicate = (counts.get(normalizeLabel(f.fieldLabel)) ?? 0) > 1;
        const type = f.attributeContentType ? contentTypeLabel(f.attributeContentType) : undefined;
        return { id: f.fieldIdentifier, label: duplicate && type ? `${f.fieldLabel} (${type})` : f.fieldLabel };
    });
    const shown = new Map<string, number>();
    for (const o of withType) shown.set(normalizeLabel(o.label), (shown.get(normalizeLabel(o.label)) ?? 0) + 1);
    return new Map(withType.map((o) => [o.id, (shown.get(normalizeLabel(o.label)) ?? 0) > 1 ? `${o.label} — ${o.id}` : o.label]));
}

/** The labels the Field select shows for a catalogue group, in order: fields without a condition are left out (`FilterWidget/index.tsx:255-263`). */
export function expectedFieldLabels(fields: readonly WidgetField[], contentTypeLabel: (code: string) => string): string[] {
    const labels = fieldLabelMap(fields, contentTypeLabel);
    return fields.filter((f) => f.conditions.length > 0).map((f) => labels.get(f.fieldIdentifier)!);
}

/** The label a list option shows for a catalogue value: the platform enum label for an enum-backed field, a group object's `name`, else the value itself (`FilterWidget/index.tsx:479-494`). */
export function valueOptionLabel(labels: PlatformLabels, field: { platformEnum?: string }, value: unknown): string {
    if (typeof value === 'object' && value !== null) return String((value as { name?: unknown }).name ?? JSON.stringify(value));
    return field.platformEnum ? labels.display(field.platformEnum, String(value)) : String(value);
}

/** A request value as comparable text: undefined stays undefined, an array becomes its items as strings, a scalar its string. */
export function wireValue(value: unknown): undefined | string | string[] {
    if (value === undefined || value === null) return undefined;
    return Array.isArray(value) ? value.map((v) => String(v)) : String(value);
}

/**
 * The filters of an observed list request against the expected ones: source, identifier, condition and the value (arrays item by
 * item in order, numbers as text: the FE sends a NUMBER field's value as a raw string and a list value as codes). Returns the
 * first difference, or undefined when they agree.
 */
export function filtersDifference(actual: readonly Json[] | undefined, expected: readonly Json[]): string | undefined {
    const got = actual ?? [];
    if (got.length !== expected.length) return `${got.length} filter(s) sent, ${expected.length} expected: ${JSON.stringify(got)}`;
    for (const [i, want] of expected.entries()) {
        const have = got[i];
        for (const key of ['fieldSource', 'fieldIdentifier', 'condition'] as const) {
            if (have[key] !== want[key]) return `filter ${i + 1}: ${key} ${JSON.stringify(have[key])}, expected ${JSON.stringify(want[key])}`;
        }
        const a = JSON.stringify(wireValue(have.value));
        const b = JSON.stringify(wireValue(want.value));
        if (a !== b) return `filter ${i + 1}: value ${JSON.stringify(have.value)}, expected ${JSON.stringify(want.value)}`;
        if (want.value === undefined && 'value' in have) return `filter ${i + 1}: a value key was sent for a value-less condition`;
    }
    return undefined;
}

/** What a badge reads (`FilterWidget/index.tsx:499-509`): `Property 'Common Name' contains 'x'`; no value → `''`; a list → `a OR b`. */
export function expectedBadgeText(parts: { source: string; field: string; condition: string; value?: string | string[] }): string {
    const value = parts.value === undefined ? '' : Array.isArray(parts.value) ? parts.value.join(' OR ') : parts.value;
    return `${parts.source} '${parts.field}' ${parts.condition} '${value}'`;
}

const clean = (s: string): string => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/** A badge's text without the screen-reader `Remove badge` of its inner button. */
export const badgeTextOf = (raw: string): string => clean(raw).replace(/\s*Remove badge$/, '').trim();

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------------ the certificate list request

export interface ListBody {
    filters?: Json[];
    itemsPerPage?: number;
    pageNumber?: number;
    sort?: Json;
    columns?: Json[];
    includeArchived?: boolean;
    [key: string]: unknown;
}

/** One certificate list request the page sent, with the answer. */
export interface ListObservation {
    request: Request;
    body: ListBody;
    status: number;
    json: Json | undefined;
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
    const timeout = opts.timeout ?? 20_000;
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
            request = later ?? (await page.waitForRequest(matches, { timeout: Math.min(timeout, 5_000) }));
            response = await request.response();
        }
        if (!response) throw new Error(`the list request ${request.url()} got no response`);
        let json: Json | undefined;
        try {
            json = (await response.json()) as Json;
        } catch {
            json = undefined;
        }
        return { request, body: listBodyOf(request), status: response.status(), json };
    } finally {
        page.off('request', collect);
    }
}

// ------------------------------------------------------------------ Select helpers (shared with the list page)

/** The portalled content of a `Select` (`select-<id>-content`): the popover is mounted outside the widget, so page-level. */
export const selectContent = (page: Page, id: string): Locator => page.getByTestId(`${id}-content`);

/** The option of an open Select: exact accessible name first, else the first option whose text starts with the label. */
async function optionByLabel(content: Locator, label: string | RegExp): Promise<Locator> {
    if (typeof label !== 'string') {
        const byRegExp = content.getByRole('option', { name: label }).first();
        await expect(byRegExp, `option ${String(label)}`).toBeVisible();
        return byRegExp;
    }
    const exact = content.getByRole('option', { name: label, exact: true });
    const prefixed = content.getByRole('option').filter({ hasText: new RegExp(`^\\s*${escapeRe(label)}(\\s|$)`) });
    await expect(exact.or(prefixed).first(), `option "${label}"`).toBeVisible();
    return (await exact.count()) > 0 ? exact.first() : prefixed.first();
}

/** Opens `select-<id>`, picks one option by label (single select: the popover closes by itself). */
export async function pickOption(page: Page, scope: Locator, id: string, label: string | RegExp): Promise<void> {
    const trigger = scope.getByTestId(`${id}-trigger`);
    const content = selectContent(page, id);
    await expect(trigger, `select ${id} is enabled`).toBeEnabled();
    await trigger.click();
    await expect(content).toBeVisible();
    await (await optionByLabel(content, label)).click();
    await expect(content).toBeHidden();
}

/** The option texts of `select-<id>` in order (the popover is opened and closed again; nothing is chosen). */
export async function readOptions(page: Page, scope: Locator, id: string): Promise<string[]> {
    const trigger = scope.getByTestId(`${id}-trigger`);
    const content = selectContent(page, id);
    await expect(trigger, `select ${id} is enabled`).toBeEnabled();
    await trigger.click();
    await expect(content).toBeVisible();
    const texts = (await content.getByRole('option').allTextContents()).map(clean);
    await page.keyboard.press('Escape');
    await expect(content).toBeHidden();
    return texts;
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

export interface FilterSpec {
    source: string;
    field: string;
    condition: string;
    /** Omitted for EMPTY / NOT_EMPTY (the value control is disabled and no `value` key is sent). */
    value?: FilterValue;
}

/** The Field select label of a catalogue field (the catalogue label, disambiguated the way the FE does). */
export function catalogueFieldLabel(catalogue: readonly CatalogueGroup[], labels: PlatformLabels, source: string, identifier: string): string {
    const group = catalogue.find((g) => g.filterFieldSource === source);
    const label = group ? fieldLabelMap(group.searchFieldData ?? [], (code) => labels.display('AttributeContentType', code)).get(identifier) : undefined;
    if (!label) throw new Error(`the catalogue has no ${source} field ${identifier}`);
    return label;
}

/** What the widget needs to add an API-shaped filter: labels for source, field and condition, and the value to type or pick (list values by their option labels). */
export function widgetSpecOf(f: Filter, catalogue: readonly CatalogueGroup[], labels: PlatformLabels): FilterSpec {
    const field = findField(catalogue as CatalogueGroup[], f.fieldIdentifier, f.fieldSource);
    if (!field) throw new Error(`the catalogue has no field ${f.fieldIdentifier}`);
    const value = f.value === undefined ? undefined : Array.isArray(f.value) ? f.value.map((v) => valueOptionLabel(labels, field, v)) : String(f.value);
    return {
        source: labels.source(f.fieldSource),
        field: catalogueFieldLabel(catalogue, labels, f.fieldSource, f.fieldIdentifier),
        condition: labels.condition(f.condition),
        ...(value === undefined ? {} : { value }),
    };
}

/** The badge an API-shaped filter shows once added through the widget (`Property 'Common Name' contains 'web'`). */
export function badgeOfFilter(f: Filter, catalogue: readonly CatalogueGroup[], labels: PlatformLabels): string {
    const spec = widgetSpecOf(f, catalogue, labels);
    return expectedBadgeText({ source: spec.source, field: spec.field, condition: spec.condition, value: spec.value as string | string[] | undefined });
}

export class FilterWidget {
    readonly page: Page;
    readonly scope: Locator;
    private readonly settle: () => Promise<void>;

    constructor(page: Page, scope: Locator = page.locator('main'), opts: { settle?: () => Promise<void> } = {}) {
        this.page = page;
        this.scope = scope;
        this.settle = opts.settle ?? (async () => undefined);
    }

    // ---- locators

    get sourceTrigger(): Locator {
        return this.scope.getByTestId('select-group-trigger');
    }
    get fieldTrigger(): Locator {
        return this.scope.getByTestId('select-field-trigger');
    }
    get conditionTrigger(): Locator {
        return this.scope.getByTestId('select-conditions-trigger');
    }
    /** The text / number / duration box (`text-input-valueSelect`). */
    get textValue(): Locator {
        return this.scope.getByTestId('text-input-valueSelect');
    }
    /** The list / boolean value Select trigger. */
    get selectValue(): Locator {
        return this.scope.getByTestId('select-valueSelect-trigger');
    }
    /** The date picker input: a plain `input#valueSelect` (the TextInput carries a test id, the Select's hidden native `<select>` is not an input). */
    get dateValue(): Locator {
        return this.scope.locator('input#valueSelect:not([data-testid])');
    }
    /** `Add`, or `Update` while a badge is loaded; `#addFilter` as the fallback (phase-04 A4). */
    get addButton(): Locator {
        return this.scope
            .getByRole('button', { name: 'Add', exact: true })
            .or(this.scope.getByRole('button', { name: 'Update', exact: true }))
            .or(this.scope.locator('#addFilter'))
            .first();
    }
    /** The filter badges: badge buttons that carry the inner `Remove badge` (table status badges do not). */
    private badgeButtons(): Locator {
        return this.scope.getByTestId('badge').filter({ has: this.page.getByRole('button', { name: 'Remove badge' }) });
    }
    /** The hint under the duration box (`FilterWidget/index.tsx:526`). */
    get durationHint(): Locator {
        return this.scope.getByText('Duration in format: 0d 0h 0m 0s');
    }

    // ---- observation

    /** The badge texts in order, normalised (`Property 'Common Name' contains 'x'`). */
    async badges(): Promise<string[]> {
        return (await this.badgeButtons().allTextContents()).map(badgeTextOf);
    }

    /** The Source select's options (labels, in order). */
    async offeredSources(): Promise<string[]> {
        return readOptions(this.page, this.scope, 'select-group');
    }

    /** The Field select's options for the chosen Source (labels, in order). */
    async offeredFields(): Promise<string[]> {
        return readOptions(this.page, this.scope, 'select-field');
    }

    /** The Condition select's options for the chosen Field (labels, in order). */
    async offeredConditions(): Promise<string[]> {
        return readOptions(this.page, this.scope, 'select-conditions');
    }

    /** Which control the current condition shows (waits for one to render; the control is re-created on every selection). */
    async valueKind(): Promise<ValueKind> {
        await expect(this.textValue.or(this.selectValue).or(this.dateValue).first(), 'a filter value control').toBeVisible();
        if ((await this.textValue.count()) > 0) return 'text';
        if ((await this.selectValue.count()) > 0) return 'select';
        return 'date';
    }

    // ---- actions

    /** Picks Source, Field and / or Condition by label (order matters: a later select resets on an earlier change; fe#994: pick the condition BEFORE the value). */
    async choose(selection: { source?: string; field?: string; condition?: string }): Promise<void> {
        if (selection.source !== undefined) await pickOption(this.page, this.scope, 'select-group', selection.source);
        if (selection.field !== undefined) await pickOption(this.page, this.scope, 'select-field', selection.field);
        if (selection.condition !== undefined) await pickOption(this.page, this.scope, 'select-conditions', selection.condition);
    }

    /** Fills the value control the current condition shows: text / number / duration, list labels (one or several), a boolean label, or a date to pick. */
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
            await expect(input).toHaveValue(text, { timeout: 1_000 });
        }).toPass({ timeout: 10_000 });
    }

    /** List / boolean values: open the Select, click each label, close the popover (a multi-select keeps it open, a single one closes it). */
    private async chooseValues(labels: string[]): Promise<void> {
        const trigger = this.selectValue;
        const content = selectContent(this.page, 'select-valueSelect');
        await expect(trigger, 'the value select is enabled').toBeEnabled();
        for (const label of labels) {
            if (!(await content.isVisible())) {
                await trigger.click();
                await expect(content).toBeVisible();
            }
            await (await optionByLabel(content, label)).click();
        }
        if (await content.isVisible()) {
            await this.page.keyboard.press('Escape');
        }
        await expect(content).toBeHidden();
    }

    /** The calendar portal: the `<body>` child that holds the weekday header (the app root never does). */
    private calendar(): Locator {
        return this.page.locator('body > div').filter({ hasText: /Mo\s*Tu\s*We\s*Th\s*Fr\s*Sa\s*Su/ });
    }

    /** Month index (0-11) and year the open calendar shows (`DatePicker/index.tsx:386-390`). */
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

    /** The UTC instant (`new Date(y, m-1, d, h, mi, s).toISOString()`) a picked wall-clock time stands for in the BROWSER's time zone: the value the FE sends (`dateUtil.ts:124-135`). */
    async instantOf(date: PickedDate): Promise<string> {
        return this.page.evaluate(
            ({ year, month, day, hours, minutes, seconds }) => new Date(year, month - 1, day, hours ?? 0, minutes ?? 0, seconds ?? 0).toISOString(),
            date,
        );
    }

    private async afterList(action: () => Promise<unknown>, match?: (body: ListBody) => boolean): Promise<ListObservation> {
        const seen = await observeListRequest(this.page, action, { match });
        await this.settle();
        return seen;
    }

    /** Clicks `Add` / `Update` and returns the list request it caused (a duplicate filter sends none: use `addExpectingNoRequest`). */
    async add(): Promise<ListObservation> {
        const button = this.addButton;
        await expect(button).toBeEnabled();
        return this.afterList(() => button.click());
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
        logger.info(`add filter ${spec.source} / ${spec.field} / ${spec.condition}`);
        return this.add();
    }

    /** Loads the badge into the form (button turns into `Update`); `update()` then applies the change. */
    async editBadge(text: string): Promise<void> {
        await expect.poll(() => this.badges(), { message: `badge "${text}"` }).toContain(text);
        const index = (await this.badges()).indexOf(text);
        await this.badgeButtons().nth(index).locator('b').first().click();
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
        const remove = this.badgeButtons().nth(index).getByRole('button', { name: 'Remove badge' });
        return this.afterList(() => remove.click());
    }

    /** The list widget's Reset (filters, paging, sort; the columns and Include archived stay): `Reset filters, sorting and pagination`. Sends a list request only when something was not at its default. */
    async reset(): Promise<ListObservation> {
        const button = this.scope.getByRole('button', { name: 'Reset filters, sorting and pagination' });
        return this.afterList(() => button.click());
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

    /** EMPTY / NOT_EMPTY: the value control is disabled, not hidden (`FilterWidget/index.tsx:540,590,597`). */
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
