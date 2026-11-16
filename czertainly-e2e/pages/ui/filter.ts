/**
 * filter — the filter widget of a list and of a workflow condition: Source / Field / Condition selects, a value control, Add and badges.
 */
import { expect, Locator, Page } from '@playwright/test';
import type { OptionChoice } from './select';
import { FILTER_FILL_SETTLE_MS, FILTER_VALUE_SHOWN_MS } from '../../utils/regression/timeouts';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

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

export const isPickedDate = (v: FilterValue): v is PickedDate => typeof v === 'object' && !Array.isArray(v);

export interface FilterSpec {
    source: OptionChoice;
    field: OptionChoice;
    condition: OptionChoice;
    /** Omitted for EMPTY / NOT_EMPTY (the value control is disabled and no `value` key is sent). */
    value?: FilterValue;
}

/** The value box is readonly until it has focus (anti-autofill): click, then fill; retried once the effect re-applied readonly. */
export async function fillFilterText(input: Locator, text: string): Promise<void> {
    await expect(async () => {
        await input.click();
        await input.fill(text);
        await expect(input).toHaveValue(text, { timeout: FILTER_VALUE_SHOWN_MS });
    }).toPass({ timeout: FILTER_FILL_SETTLE_MS });
}

/** Month index (0-11) and year the open calendar shows. */
async function shownMonth(calendar: Locator): Promise<{ month: number; year: number }> {
    const monthText = (await calendar.getByText(new RegExp(`^(${MONTHS.join('|')})$`)).first().textContent())?.trim() ?? '';
    const yearText = (await calendar.getByText(/^\d{4}$/).first().textContent())?.trim() ?? '';
    const month = MONTHS.indexOf(monthText as (typeof MONTHS)[number]);
    if (month < 0 || !/^\d{4}$/.test(yearText)) throw new Error(`the calendar shows "${monthText} / ${yearText}"`);
    return { month, year: Number(yearText) };
}

/** Walks the date picker to the month, clicks the day, sets the time when shown; returns the input text (`dd.mm.yyyy[ HH:MM:SS]`). */
export async function pickDate(dateInput: Locator, calendar: Locator, date: PickedDate): Promise<string> {
    await expect(dateInput, 'the date picker is enabled').toBeEnabled();
    await dateInput.click();
    await expect(calendar).toBeVisible();
    let reached = false;
    for (let step = 0; step < 600 && !reached; step++) {
        const shown = await shownMonth(calendar);
        const diff = (date.year - shown.year) * 12 + (date.month - 1 - shown.month);
        if (diff === 0) {
            reached = true;
            break;
        }
        await calendar.getByRole('button', { name: diff > 0 ? 'Next' : 'Previous', exact: true }).click();
        await expect.poll(async () => JSON.stringify(await shownMonth(calendar))).not.toBe(JSON.stringify(shown));
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
    return dateInput.inputValue();
}

/** The UTC instant a picked wall-clock time stands for in the BROWSER's time zone: the value the FE sends. */
export async function instantOf(page: Page, date: PickedDate): Promise<string> {
    return page.evaluate(
        ({ year, month, day, hours, minutes, seconds }) => new Date(year, month - 1, day, hours ?? 0, minutes ?? 0, seconds ?? 0).toISOString(),
        date,
    );
}
