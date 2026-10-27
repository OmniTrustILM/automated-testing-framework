/**
 * PagerWidget on a static CustomTable stand-in: the page-size Select (read, chosen, no change when already chosen), the
 * pager (current page, Previous / Next at the ends, hidden with one page) and the summary line, each shown passing on the
 * right page and failing on a wrong one.
 */
import { expect, Page, test } from '@playwright/test';
import { PAGE_SIZES, PagerWidget } from '../../pages/PagerWidget';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

async function table(page: Page, o: { size: number; current: number; pages: number; summary?: string }): Promise<void> {
    const pages = Array.from({ length: o.pages }, (_, i) => i + 1)
        .map((n) => `<button data-testid="pagination-page-${n}" ${n === o.current ? 'aria-current="page"' : ''} onclick="clicked(${n})">${n}</button>`).join('');
    const options = PAGE_SIZES.map((s) => `<div role="option" data-value="${s}" onclick="pick(this)">${s}</div>`).join('');
    await page.setContent(`<main><section data-testid="list">
      <div data-testid="select-pageSize"><button data-testid="select-pageSize-trigger" aria-haspopup="listbox" onclick="document.getElementById('c').style.display='block'">${o.size}</button></div>
      ${o.pages > 1 ? `<nav data-testid="pagination"><button data-testid="pagination-prev" ${o.current === 1 ? 'disabled' : ''}>p</button>${pages}<button data-testid="pagination-next" ${o.current === o.pages ? 'disabled' : ''}>n</button></nav>` : ''}
      ${o.summary ? `<p>${o.summary}</p>` : ''}
      <output id="log"></output></section>
      <div id="c" data-testid="select-pageSize-content" style="display:none"><div role="listbox">${options}</div></div></main>
      <script>
        function pick(el) { document.querySelector('[data-testid=select-pageSize-trigger]').textContent = el.textContent; document.getElementById('c').style.display = 'none'; document.getElementById('log').textContent += 'size ' + el.textContent + ';'; }
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('c').style.display = 'none'; });
        function clicked(n) { document.getElementById('log').textContent += 'page ' + n + ';'; }
      </script>`);
}

test('page size: the options in order, the selected size, a change only when the size differs', async ({ page }) => {
    await table(page, { size: 10, current: 1, pages: 3 });
    const pager = new PagerWidget(page, page.getByTestId('list'));
    await pager.assertPageSizeControl(true);
    expect(await pager.pageSizeOptions()).toEqual([10, 25, 50, 100]);
    expect(await pager.selectedPageSize()).toBe(10);
    expect(await pager.setPageSize(10), 'already 10: nothing is clicked').toBe(false);
    expect(await pager.setPageSize(50)).toBe(true);
    expect(await pager.selectedPageSize()).toBe(50);
    await expect(page.locator('#log')).toHaveText('size 50;');
});

test('pager: the current page and the end buttons; a wrong expectation fails; one page hides the pager', async ({ page }) => {
    await table(page, { size: 10, current: 1, pages: 3, summary: 'Showing 1 to 10 items of 24' });
    const pager = new PagerWidget(page, page.getByTestId('list'));
    await pager.assertPager({ page: 1, pages: 3 });
    expect(await failsFast(pager.assertPager({ page: 2, pages: 3 })), 'page 2 is not current').toBe(true);
    expect(await failsFast(pager.assertPagerHidden()), 'the pager is mounted').toBe(true);
    await pager.goToPage(3);
    await expect(page.locator('#log')).toHaveText('page 3;');
    expect(await pager.summary()).toEqual({ from: 1, to: 10, total: 24 });
    await table(page, { size: 10, current: 3, pages: 3 });
    await pager.assertPager({ page: 3, pages: 3 });
    expect(await pager.summary(), 'no summary line').toBeNull();
    await table(page, { size: 10, current: 1, pages: 1 });
    await pager.assertPagerHidden();
});
