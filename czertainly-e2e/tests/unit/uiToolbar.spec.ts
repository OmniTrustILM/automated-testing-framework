/**
 * pages/ui/toolbar.ts on a static page: `expectButtons` for the three states (enabled, disabled, absent), with the buttons
 * looked up inside their widget, each shown passing on the right page and failing on a wrong one.
 */
import { expect, test } from '@playwright/test';
import { expectButtons } from '../../pages/ui/toolbar';
import { widgetTitled } from '../../pages/ui/widget';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

const page2 = `<main>
  <section><div><h5>Certificate Properties</h5>
    <button data-testid="retweet-button">r</button><button data-testid="trash-button" disabled>d</button></div></section>
  <section><div><h5>Other</h5><button data-testid="minus-square-button">x</button></div></section></main>`;

test('expectButtons judges enabled, disabled and absent; a button of another widget is not in scope', async ({ page }) => {
    await page.setContent(page2);
    const properties = widgetTitled(page, 'Certificate Properties');
    const testIds = { renew: 'retweet-button', delete: 'trash-button', revoke: 'minus-square-button' };
    const button = (name: keyof typeof testIds) => properties.getByTestId(testIds[name]);
    await expectButtons(button, { renew: 'enabled', delete: 'disabled', revoke: 'absent' }, 'certificate toolbar');
    expect(await failsFast(expectButtons(button, { renew: 'disabled' }, 'x')), 'an enabled button is not disabled').toBe(true);
    expect(await failsFast(expectButtons(button, { delete: 'enabled' }, 'x')), 'a disabled button is not enabled').toBe(true);
    expect(await failsFast(expectButtons(button, { renew: 'absent' }, 'x')), 'a rendered button is not absent').toBe(true);
    expect(await failsFast(expectButtons(button, { revoke: 'enabled' }, 'x')), 'the other widget\'s button is not in scope').toBe(true);
});
