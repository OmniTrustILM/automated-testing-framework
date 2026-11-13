/**
 * tablePage — offline check of `TablePage.bulkDelete` on both list layouts: the toolbar trash button, and the page header's
 * "More actions" Delete entry of fe-administrator#2426 (rendered in a portal while open, the rest of the page aria-hidden).
 */
import { expect, test } from '@playwright/test';
import { TablePage } from '../../pages/TablePage';

const list = (trigger: string) => `<div id="root">${trigger}<main><table><thead><tr><th><input type="checkbox"></th></tr></thead><tbody>
  <tr><td>qa-reg-x-a</td></tr><tr><td>qa-reg-x-b</td></tr></tbody></table></main></div>
  <div role="dialog" hidden id="confirm"><button onclick="document.getElementById('confirm').hidden=true;document.body.dataset.deleted='yes'">Delete</button></div>`;

const openConfirm = "document.getElementById('confirm').hidden=false";

test('bulkDelete: the toolbar trash button, or the header menu entry of fe-administrator#2426', async ({ page }) => {
    const table = new TablePage(page);
    await page.setContent(list(`<button onclick="${openConfirm}"><svg class="lucide-trash-2"></svg></button>`));
    await table.bulkDelete('legacy', { rows: 2, eachRowContains: 'qa-reg-x' });
    await expect(page.locator('body')).toHaveAttribute('data-deleted', 'yes');

    await page.setContent(`${list(`<div data-testid="page-header-actions"><button aria-label="More actions" aria-expanded="false"
      onclick="this.setAttribute('aria-expanded','true');document.getElementById('root').setAttribute('aria-hidden','true');
        const m=document.createElement('div');m.setAttribute('role','menu');m.innerHTML='<div role=menuitem data-testid=page-action-delete>Delete</div>';
        m.firstChild.addEventListener('click',()=>{${openConfirm};m.remove();});document.body.appendChild(m);">more</button></div>`)}`);
    await table.bulkDelete('header', { rows: 2, eachRowContains: 'qa-reg-x' });
    await expect(page.locator('body')).toHaveAttribute('data-deleted', 'yes');
});
