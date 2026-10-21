/**
 * List pages: waiting for real rows (a list renders skeleton rows first), the filter badges above a list, and the
 * inventory text filter (Source → Field → Condition → value → Add) used by the 18 main flows.
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
