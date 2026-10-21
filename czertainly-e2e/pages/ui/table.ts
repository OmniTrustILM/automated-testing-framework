/**
 * Tables of the admin UI whose header cells carry the column id (`thead th[data-id]`): find a column by that id and a
 * row's cell in it, instead of a fixed position (columns move between FE releases and with the user's column choice).
 */
import { expect, Locator } from '@playwright/test';

/** The index of the column whose header id is `headerId`; fails (naming `table`) when there is none. */
export async function headerColumnIndex(table: Locator, headerId: string, tableName: string): Promise<number> {
    const ids = await table.locator('thead th').evaluateAll((cells) => cells.map((c) => c.getAttribute('data-id') ?? ''));
    const index = ids.indexOf(headerId);
    expect(index, `${tableName} has a ${headerId} column`).toBeGreaterThanOrEqual(0);
    return index;
}

/** The cell of `row` in the column whose header id is `headerId` (the header is read from `table`). */
export async function cellByHeader(table: Locator, row: Locator, headerId: string, tableName: string): Promise<Locator> {
    return row.locator('td').nth(await headerColumnIndex(table, headerId, tableName));
}
