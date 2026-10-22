/**
 * table — column-by-id table helpers.
 *
 * WHAT: tables whose header cells carry the column id: find a column by that id and a row's cell in it.
 * WHY: columns move between releases and with the user's column choice; a fixed position is a wrong oracle.
 * HOW: the header ids are read once; the cell is the row's td at that index.
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
