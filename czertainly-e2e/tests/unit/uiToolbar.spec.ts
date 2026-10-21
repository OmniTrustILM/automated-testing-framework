/**
 * pages/ui/toolbar.ts on a static page: the one icon map, `ToolbarButtons` scoped to a widget, and `expectButtons` for the
 * three states (enabled, disabled, absent), each shown passing on the right page and failing on a wrong one.
 */
import { expect, test } from '@playwright/test';
import { expectButtons, TOOLBAR_ICON, ToolbarButtons } from '../../pages/ui/toolbar';
import { widgetTitled } from '../../pages/ui/widget';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

const page2 = `<main>
  <section><div><h5>Certificate Properties</h5>
    <button data-testid="retweet-button">r</button><button data-testid="trash-button" disabled>d</button></div></section>
  <section><div><h5>Other</h5><button data-testid="minus-square-button">x</button></div></section></main>`;

// ToolbarButtons finds a button by action inside its widget only; expectButtons judges enabled, disabled and absent
test('ToolbarButtons finds a button by action inside its widget only; expectButtons judges states', async ({ page }) => {
    await page.setContent(page2);
    const toolbar = new ToolbarButtons(widgetTitled(page, 'Certificate Properties'));
    await expect(toolbar.button('renew')).toHaveCount(1);
    await expect(toolbar.button('revoke'), 'the other widget\'s button is not in scope').toHaveCount(0);
    await expectButtons(toolbar, { renew: 'enabled', delete: 'disabled', revoke: 'absent' }, 'certificate toolbar');
    expect(await failsFast(expectButtons(toolbar, { renew: 'disabled' }, 'x')), 'an enabled button is not disabled').toBe(true);
    expect(await failsFast(expectButtons(toolbar, { delete: 'enabled' }, 'x')), 'a disabled button is not enabled').toBe(true);
    expect(await failsFast(expectButtons(toolbar, { renew: 'absent' }, 'x')), 'a rendered button is not absent').toBe(true);
});

test('expectButtons takes any name-to-button lookup; the icon map names every action once', async ({ page }) => {
    await page.setContent(page2);
    const scope = widgetTitled(page, 'Other');
    await expectButtons((name: 'x' | 'y') => scope.getByTestId(name === 'x' ? 'minus-square-button' : 'nope-button'), { x: 'enabled', y: 'absent' });
    expect(TOOLBAR_ICON.renew).toBe('retweet');
    expect(Object.keys(TOOLBAR_ICON).length).toBe(new Set(Object.keys(TOOLBAR_ICON)).size);
});
