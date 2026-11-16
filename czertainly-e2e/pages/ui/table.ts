/**
 * table — a column found by its header's data id, never by position: columns move between releases and with the user's choice.
 */
import { expect, Locator } from '@playwright/test';

/** The index of the column whose header id is `headerId`; fails (naming `tableName`) when there is none. */
export async function headerColumnIndex(table: Locator, headerId: string, tableName: string): Promise<number> {
    const ids = await table.locator('thead th').evaluateAll((cells) => cells.map((c) => c.getAttribute('data-id') ?? ''));
    const index = ids.indexOf(headerId);
    expect(index, `${tableName} has a ${headerId} column`).toBeGreaterThanOrEqual(0);
    return index;
}

export async function cellByHeader(table: Locator, row: Locator, headerId: string, tableName: string): Promise<Locator> {
    return row.locator('td').nth(await headerColumnIndex(table, headerId, tableName));
}
