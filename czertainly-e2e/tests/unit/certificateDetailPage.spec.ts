/**
 * certificateDetailPage — offline checks of pages/CertificateDetailPage.ts on `page.setContent` documents shaped like
 * the admin UI.
 */
import { expect, test } from '@playwright/test';
import { CertificateDetailPage } from '../../pages/CertificateDetailPage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

const properties = (title: string, buttons: Record<string, boolean>) => `<section><div><h5>${title}</h5>
  ${Object.entries(buttons).map(([icon, enabled]) => `<button data-testid="${icon}-button" ${enabled ? '' : 'disabled'}>${icon}</button>`).join('')}
  </div></section>`;

test('assertToolbar: enabled / disabled per icon inside the Certificate / CSR Properties widget, not another widget\'s buttons', async ({ page }) => {
    test.setTimeout(60_000);
    const cert = new CertificateDetailPage(page);
    await page.setContent(`<main>${properties('Certificate Properties', { retweet: true, rekey: true, 'minus-square': false, check: false, cubes: false })}
      <section><div><h5>Locations</h5><button data-testid="minus-square-button">other</button></div></section></main>`);
    await cert.assertToolbar({ renew: 'enabled', rekey: 'enabled', revoke: 'disabled', complete: 'disabled', issue: 'disabled' });
    expect(await failsFast(cert.assertToolbar({ revoke: 'enabled' }))).toBe(true);
    expect(await failsFast(cert.assertToolbar({ renew: 'disabled' }))).toBe(true);
    await page.setContent(`<main>${properties('CSR Properties', { cubes: true, retweet: false })}</main>`);
    await cert.assertToolbar({ issue: 'enabled', renew: 'disabled' });
});

const registration = (rows: Record<string, string> | undefined) => `<div role="tablist"><button role="tab">Details</button></div><main>
  <section><div><h5>Certificate Properties</h5></div></section>
  ${rows ? `<section><div><h5>Registration</h5></div><table><tbody>${Object.entries(rows).map(([k, v]) => `<tr data-id="${k}"><td>k</td><td>${v}</td></tr>`).join('')}</tbody></table></section>` : ''}
  </main>`;

test('assertRegistration / assertNoRegistration read the Registration widget rows by id; a wrong state or count fails', async ({ page }) => {
    test.setTimeout(90_000);
    const cert = new CertificateDetailPage(page);
    await page.setContent(registration({ registrationState: 'Active', registrationExpiresAt: '2026-10-21T10:00:00Z', registrationFailedAttempts: '0' }));
    await cert.assertRegistration({ state: 'Active', failedAttempts: 0 });
    expect(await failsFast(cert.assertRegistration({ state: 'Locked' }))).toBe(true);
    expect(await failsFast(cert.assertRegistration({ failedAttempts: 1 }))).toBe(true);
    expect(await failsFast(cert.assertNoRegistration())).toBe(true);
    await page.setContent(registration(undefined));
    await cert.assertNoRegistration();
    expect(await failsFast(cert.assertRegistration({ state: 'Active' }))).toBe(true);
});

test('assertState reads the certState row badge', async ({ page }) => {
    const cert = new CertificateDetailPage(page);
    await page.setContent(`<div role="tablist"><button role="tab">Details</button></div><main><table><tbody><tr data-id="certState"><td>State</td><td><span data-testid="certificate-status">Pending approval</span></td></tr></tbody></table></main>`);
    await cert.assertState('Pending approval');
    expect(await failsFast(cert.assertState('Issued'))).toBe(true);
});

// The page header of fe-administrator#2426, the way Radix renders it: a "More actions" trigger, its entries in a portal only while open,
// and the rest of the page (the trigger too) aria-hidden while the menu is open.
const headerPage = (entries: Record<string, boolean>, body: string, primary?: string) => `<div id="root">
  <div data-testid="page-header-actions">${primary ? `<button data-testid="page-action-${primary}">${primary}</button>` : ''}
    <button id="more" aria-label="More actions" aria-expanded="false">more</button></div>${body}</div>
  <script>
    const root = document.getElementById('root');
    const more = document.getElementById('more');
    const entries = ${JSON.stringify(entries)};
    const show = (open) => {
      more.setAttribute('aria-expanded', String(open));
      if (open) root.setAttribute('aria-hidden', 'true'); else root.removeAttribute('aria-hidden');
      document.getElementById('menu')?.remove();
      if (!open) return;
      const menu = document.createElement('div');
      menu.id = 'menu';
      menu.setAttribute('role', 'menu');
      for (const [id, enabled] of Object.entries(entries)) {
        const item = document.createElement('div');
        item.setAttribute('role', 'menuitem');
        item.dataset.testid = 'page-action-' + id;
        if (!enabled) item.setAttribute('aria-disabled', 'true');
        item.textContent = id;
        item.addEventListener('click', () => { if (enabled) { document.body.dataset.clicked = id; show(false); } });
        menu.appendChild(item);
      }
      document.body.appendChild(menu);
    };
    more.addEventListener('click', () => show(more.getAttribute('aria-expanded') !== 'true'));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') show(false); });
  </script>`;

const propertiesWidget = '<main><section><div><h5>Certificate Properties</h5></div></section></main>';

test('page header (fe-administrator#2426): assertToolbar opens "More actions", reads enabled / disabled entries and closes it again', async ({ page }) => {
    test.setTimeout(60_000);
    const cert = new CertificateDetailPage(page);
    const entries = { issue: false, renew: true, rekey: true, revoke: true, complete: false, delete: true };
    await page.setContent(headerPage(entries, propertiesWidget, 'download'));
    await cert.assertToolbar({ renew: 'enabled', revoke: 'enabled', issue: 'disabled', complete: 'disabled' });
    await expect(cert.header.moreActions).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#menu')).toHaveCount(0);
    expect(await failsFast(cert.assertToolbar({ complete: 'enabled' }))).toBe(true);
    await expect(cert.header.moreActions, 'closed after a failed check too').toHaveAttribute('aria-expanded', 'false');
    await cert.header.closeMenu();
    await expect(cert.header.moreActions, 'a closed menu stays closed').toHaveAttribute('aria-expanded', 'false');
});

test('page header: assertToolbar waits for the certificate, not only for the header', async ({ page }) => {
    const cert = new CertificateDetailPage(page);
    await page.setContent(headerPage({ revoke: false }, '<main></main>'));
    expect(await failsFast(cert.assertToolbar({ revoke: 'disabled' })), 'no Certificate Properties yet: no verdict').toBe(true);
});

test('clickAction: a header menu entry after opening the menu; on an older build the widget button directly', async ({ page }) => {
    test.setTimeout(60_000);
    const cert = new CertificateDetailPage(page);
    await page.setContent(headerPage({ renew: true, rekey: true, complete: true, revoke: true }, propertiesWidget));
    for (const action of ['revoke', 'renew', 'rekey', 'complete'] as const) {
        await cert.clickAction(action);
        await expect(page.locator('body')).toHaveAttribute('data-clicked', action);
    }
    await page.setContent(`<main><section><div><h5>Certificate Properties</h5>
      <button data-testid="retweet-button" onclick="document.body.dataset.clicked='widget-renew'">renew</button></div></section></main>`);
    await cert.clickAction('renew');
    await expect(page.locator('body')).toHaveAttribute('data-clicked', 'widget-renew');
});
