/**
 * keyPage — KeyPage against a static key detail shaped like the admin UI (widgets are `<section>`s with a title, rows
 * are `tr[data-id]`): the Key Details rows are looked up inside their widget, never in the key item below.
 */
import { expect, test } from '@playwright/test';
import { KeyPage } from '../../pages/KeyPage';

const KEY_DETAIL = `<main>
  <section><div><h5>Key Details</h5><button data-testid="check-button" onclick="this.dataset.clicked='yes'">enable</button></div>
    <table><tbody><tr data-id="name"><td>Name</td><td>the key</td></tr></tbody></table></section>
  <div data-testid="tab-layout"><div role="tablist"><button role="tab" aria-selected="true">Private key</button><button role="tab">Public key</button></div>
    <div><button data-testid="check-button">item enable</button>
      <table><tbody><tr data-id="name"><td>Name</td><td>the private item</td></tr><tr data-id="state"><td>State</td><td>Active</td></tr></tbody></table></div>
    <div hidden><table><tbody><tr data-id="state"><td>State</td><td>Compromised</td></tr></tbody></table></div>
  </div></main>`;

test('KeyPage: row and the Enable button stay inside Key Details (the item reuses their ids); itemRow reads the shown item only', async ({ page }) => {
    const keys = new KeyPage(page);
    await page.setContent(KEY_DETAIL);
    await expect(keys.row('name')).toHaveCount(1);
    await expect(keys.row('name')).toContainText('the key');
    await expect(keys.itemRow('state')).toHaveCount(1);
    await expect(keys.itemRow('state')).toContainText('Active');
    await expect(keys.enableKeyButton).toHaveCount(1);
    await keys.enableKey();
    await expect(page.locator('main section').getByTestId('check-button')).toHaveAttribute('data-clicked', 'yes');
});
