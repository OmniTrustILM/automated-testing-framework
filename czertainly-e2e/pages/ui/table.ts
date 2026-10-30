/**
 * table — column-by-id table helpers.
 *
 * Finds a column by the id its header cell carries, and a row's cell in it. Columns move between releases and with the
 * user's column choice, so a fixed position is a wrong oracle.
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
