/**
 * list — list helpers for the main-usage flows.
 *
 * WHAT: list helpers of the main-usage flows: wait for real rows (a list renders skeleton rows first), read the
 *       filter badges above a list, add one text filter (Source, Field, Condition, value, Add).
 * WHY: the main-usage specs need only the inventory text filter; the full filter widget with its conditions is
 *       `FilterWidget`, used by `CertificateListPage`.
 * HOW: rows by their detail link; selects by label; the value box is readonly until focused.
 */
import { expect, Page } from '@playwright/test';
import { chooseOption, selectTriggerByLabel } from './select';

/** Wait until a list table shows real rows (it renders skeleton rows first). */
export async function waitForListRows(page: Page): Promise<void> {
    await expect(page.locator('main table tbody tr a[href*="/detail/"]').first()).toBeVisible({ timeout: 30_000 });
}

/** Filter badges shown above a list ("Property 'Common Name' contains 'x'"), without the trailing "Remove badge". */
export async function filterBadges(page: Page): Promise<string[]> {
    const raw = await page.locator('main').getByRole('button', { name: /Remove badge$/ }).allInnerTexts();
    // The inner "Remove badge" button matches too and leaves an empty string: drop those.
    return raw.map((t) => t.replace(/\s*Remove badge$/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Inventory filter widget: Source → Field → Condition → value → Add. The value box is readonly until focused. */
export async function addInventoryTextFilter(page: Page, field: string, condition: string, value: string): Promise<void> {
    const main = page.locator('main');
    await chooseOption(page, selectTriggerByLabel(main, 'Filter Field Source'), 'Property');
    await chooseOption(page, selectTriggerByLabel(main, /^Filter Field$/), field);
    await chooseOption(page, selectTriggerByLabel(main, 'Filter Condition'), condition);
    const input = main.getByTestId('text-input-valueSelect');
    await input.click();
    await input.pressSequentially(value);
    await main.getByRole('button', { name: 'Add', exact: true }).click();
}
