/**
 * uiTable — offline checks of pages/ui/table.ts on a `page.setContent` table shaped like the admin UI's: a column is
 * found by its header id wherever it sits, and a missing column fails with the table's name.
 */
import { expect, test } from '@playwright/test';
import { cellByHeader, headerColumnIndex } from '../../pages/ui/table';

test('a cell is found by its column header id, wherever the column sits; a missing column fails naming the table', async ({ page }) => {
    await page.setContent(`<main><table>
      <thead><tr><th data-id="name">Name</th><th data-id="status">Status</th><th data-id="triggersCount">Triggers Count</th></tr></thead>
      <tbody><tr data-id="a"><td>first</td><td>ok</td><td>3</td></tr><tr data-id="b"><td>second</td><td>failed</td><td>0</td></tr></tbody>
    </table></main>`);
    const table = page.locator('main table');
    expect(await headerColumnIndex(table, 'triggersCount', 'the test table')).toBe(2);
    await expect(await cellByHeader(table, table.locator('tr[data-id="b"]'), 'status', 'the test table')).toHaveText('failed');
    await expect(headerColumnIndex(table, 'missing', 'the test table')).rejects.toThrow(/the test table has a missing column/);
});
