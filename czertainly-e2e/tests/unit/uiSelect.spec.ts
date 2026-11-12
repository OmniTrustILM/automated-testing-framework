/**
 * The Select choice rule (pages/ui/select.ts) on a static page: a text choice matches the option's EXACT accessible name
 * only; a label that only starts an option's text is chosen only with an explicit `{ prefix, reason }`; there is no
 * "contains" fallback; `{ value }` matches `data-value` exactly.
 */
import { expect, Page, test } from '@playwright/test';
import { chooseOption, chooseOptions, describeChoice, OptionChoice, selectById } from '../../pages/ui/select';

const OPTIONS = ['x-ra-2', 'x-ra (enabled)', 'Not equals', 'Equals', 'Starts with'];

async function render(page: Page): Promise<void> {
    const opts = OPTIONS.map((o, i) => `<div role="option" data-value="v${i}" onclick="pick(this)">${o}</div>`).join('');
    await page.setContent(`<main><div data-testid="select-x"><label>X</label>
      <button data-testid="select-x-trigger" aria-haspopup="listbox" onclick="document.getElementById('c').style.display='block'">Choose</button></div>
      <div id="c" data-testid="select-x-content" style="display:none"><div role="listbox">${opts}</div></div>
      <output id="picked"></output></main>
      <script>
        function pick(el) { document.getElementById('picked').textContent += el.textContent + ';'; document.getElementById('c').style.display = 'none'; }
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('c').style.display = 'none'; });
      </script>`);
}

const picked = (page: Page) => page.locator('#picked').textContent();
const failsWithin = async (p: Promise<unknown>): Promise<boolean> => p.then(() => false, () => true);

// a text choice is the exact accessible name: "Equals" is never "Not equals", "x-ra-2" is chosen by its own name
test('a text choice is the exact accessible name: Equals is never Not equals', async ({ page }) => {
    await render(page);
    const sel = selectById(page, page.locator('main'), 'x');
    expect(await chooseOption(page, sel, 'Equals')).toBe('Equals');
    expect(await chooseOption(page, sel, 'x-ra-2')).toBe('x-ra-2');
    await chooseOptions(page, sel, ['Starts with', { value: 'v2' }]);
    expect(await picked(page)).toBe('Equals;x-ra-2;Starts with;Not equals;');
});

// a label that only starts or only appears in an option fails: no prefix, no "contains" fallback without the opt-in
test('a label that only starts or only appears in an option fails, with no contains fallback', async ({ page }) => {
    test.setTimeout(20_000);
    await render(page);
    const sel = selectById(page, page.locator('main'), 'x');
    expect(await failsWithin(chooseOption(page, sel, 'x-ra')), 'a prefix of "x-ra (enabled)"').toBe(true);
    await page.keyboard.press('Escape');
    expect(await failsWithin(chooseOption(page, sel, 'with')), 'contained in "Starts with"').toBe(true);
    await page.keyboard.press('Escape');
    expect(await failsWithin(chooseOption(page, sel, 'equals')), 'another case').toBe(true);
    await page.keyboard.press('Escape');
    expect(await picked(page)).toBe('');
});

test('the prefix opt-in: word boundary, the reason is required', async ({ page }) => {
    await render(page);
    const sel = selectById(page, page.locator('main'), 'x');
    const choice: OptionChoice = { prefix: 'x-ra', reason: 'the UI appends the state "(enabled)" to the name' };
    expect(await chooseOption(page, sel, choice)).toBe('x-ra (enabled)');
    await expect(chooseOption(page, sel, { prefix: 'x-ra', reason: ' ' })).rejects.toThrow(/needs the reason/);
    await page.keyboard.press('Escape');
    expect(await failsWithin(chooseOption(page, sel, { prefix: 'Start', reason: 'r' })), 'no word boundary after "Start"').toBe(true);
    await page.keyboard.press('Escape');
    expect(await failsWithin(chooseOption(page, sel, { prefix: 'equals', reason: 'r' })), 'the text must START with the prefix ("Not equals" ends with it)').toBe(true);
    await page.keyboard.press('Escape');
    expect(await picked(page)).toBe('x-ra (enabled);');
    expect([describeChoice(choice), describeChoice('Equals'), describeChoice({ value: 'v1' }), describeChoice(/x/)]).toEqual(['prefix "x-ra"', 'Equals', 'value v1', '/x/']);
});
