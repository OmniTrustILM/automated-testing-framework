/**
 * certificatePage — offline check of pages/CertificatePage.ts on a `page.setContent` Details tab.
 */
import { expect, test } from '@playwright/test';
import { CertificatePage } from '../../pages/CertificatePage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

const certDetails = (rows: Record<string, string>) => `<div role="tablist"><button role="tab">Details</button><button role="tab">Request</button></div>
  <main><section><div><h5>Subject Alternative Names</h5></div><table><tbody>
  ${Object.entries(rows).map(([k, v]) => `<tr data-id="${k}"><td>${k}</td><td>${v}</td></tr>`).join('')}
  </tbody></table></section></main>`;

test('CertificatePage.assertSans: exact = set equality of DNS and IP; dns = every expected DNS name shown', async ({ page }) => {
    const cert = new CertificatePage(page);
    const want = { dns: ['a.example.test', 'alt.a.example.test'], ip: ['192.0.2.10'] };
    await page.setContent(certDetails({ dNSName: 'alt.a.example.test, a.example.test', iPAddress: '192.0.2.10' }));
    expect(await cert.sanValues()).toEqual({ dns: ['alt.a.example.test', 'a.example.test'], ip: ['192.0.2.10'] });
    await cert.assertSans(want, 'exact');
    await cert.assertSans(want, 'dns');
    await page.setContent(certDetails({ dNSName: 'a.example.test, alt.a.example.test, extra.example.test', iPAddress: '192.0.2.10' }));
    expect(await failsFast(cert.assertSans(want, 'exact'))).toBe(true);
    await cert.assertSans(want, 'dns');
    await page.setContent(certDetails({ dNSName: 'a.example.test, alt.a.example.test', iPAddress: '192.0.2.99' }));
    expect(await failsFast(cert.assertSans(want, 'exact'))).toBe(true);
    await cert.assertSans(want, 'dns');
    await page.setContent(certDetails({ dNSName: 'a.example.test, alt.a.example.test' }));
    expect(await failsFast(cert.assertSans(want, 'exact'))).toBe(true);
    await cert.assertSans(want, 'dns');
    await page.setContent(certDetails({ dNSName: 'a.example.test', iPAddress: '192.0.2.10' }));
    expect(await failsFast(cert.assertSans(want, 'exact'))).toBe(true);
    expect(await failsFast(cert.assertSans(want, 'dns'))).toBe(true);
});

test('list actions: the page header\'s Create button and its "More actions" Import entry, or the widget buttons of an older build', async ({ page }) => {
    const cert = new CertificatePage(page);
    const mark = (what: string) => `onclick="document.body.dataset.clicked='${what}'"`;
    await page.setContent(`<div id="root"><div data-testid="page-header-actions">
      <button data-testid="page-action-create" ${mark('create')}>Create</button>
      <button id="more" aria-label="More actions" aria-expanded="false"
        onclick="this.setAttribute('aria-expanded','true');document.getElementById('root').setAttribute('aria-hidden','true');
          document.getElementById('menu').hidden=false">more</button></div><main></main></div>
      <div id="menu" role="menu" hidden><div role="menuitem" data-testid="page-action-import" ${mark('import')}>Import certificates and keys</div></div>`);
    await cert.header.click(cert.addCertificateButton);
    await expect(page.locator('body')).toHaveAttribute('data-clicked', 'create');
    await cert.header.click(cert.uploadButton);
    await expect(page.locator('body')).toHaveAttribute('data-clicked', 'import');
    await page.setContent(`<main><button data-testid="add-certificate-button" ${mark('widget-add')}>+</button>
      <button data-testid="upload-button" ${mark('widget-upload')}>up</button></main>`);
    await cert.header.click(cert.uploadButton);
    await expect(page.locator('body')).toHaveAttribute('data-clicked', 'widget-upload');
    await cert.header.click(cert.addCertificateButton);
    await expect(page.locator('body')).toHaveAttribute('data-clicked', 'widget-add');
});

test('deleteFromDetail: the page header\'s Delete entry, then the Delete Certificate confirmation', async ({ page }) => {
    const cert = new CertificatePage(page);
    await page.setContent(`<div id="root"><div data-testid="page-header-actions"><button aria-label="More actions" aria-expanded="false"
      onclick="this.setAttribute('aria-expanded','true');document.getElementById('root').setAttribute('aria-hidden','true');
        document.getElementById('menu').hidden=false">more</button></div><main></main></div>
      <div id="menu" role="menu" hidden><div role="menuitem" data-testid="page-action-delete"
        onclick="document.getElementById('menu').hidden=true;document.getElementById('confirm').hidden=false">Delete</div></div>
      <div role="dialog" id="confirm" hidden>Delete Certificate<button onclick="document.getElementById('confirm').hidden=true">Delete</button></div>`);
    await cert.deleteFromDetail();
    await expect(page.locator('#confirm')).toBeHidden();
});
