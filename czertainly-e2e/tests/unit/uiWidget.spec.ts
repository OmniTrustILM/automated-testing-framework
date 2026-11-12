/**
 * uiWidget — offline checks of pages/ui/widget.ts on `page.setContent` documents shaped like the admin UI: a widget is
 * the closest `<section>` around its title heading (nested widgets, exact and RegExp titles, regex characters literal).
 */
import { expect, test } from '@playwright/test';
import { widgetTitled as widget } from '../../pages/ui/widget';

test('widget(): the closest <section> around the title heading — nested widgets, exact titles, RegExp titles', async ({ page }) => {
    await page.setContent(`<main>
      <section data-testid="outer"><div><h5>Role Details</h5></div>
        <section data-testid="inner-a"><div><h5>Subject Alternative Names</h5><button data-testid="pencil-button">e</button></div></section>
        <section data-testid="inner-b"><div><h5>Subject Alternative Names extra</h5><button data-testid="pencil-button">e</button></div></section>
        <section data-testid="inner-c"><div><h5>CSR Properties</h5></div></section>
      </section></main>`);
    await expect(widget(page, 'Subject Alternative Names')).toHaveAttribute('data-testid', 'inner-a');
    await expect(widget(page, 'Role Details')).toHaveAttribute('data-testid', 'outer');
    await expect(widget(page.locator('main'), /^(Certificate|CSR) Properties$/)).toHaveAttribute('data-testid', 'inner-c');
    await expect(widget(page, 'Subject Alternative Names').getByTestId('pencil-button')).toHaveCount(1);
    await expect(widget(page, 'Nope')).toHaveCount(0);
    // Regex characters in a title are literal.
    await page.setContent('<main><section data-testid="s"><h5>A (b) [c].*</h5></section></main>');
    await expect(widget(page, 'A (b) [c].*')).toHaveAttribute('data-testid', 's');
});
