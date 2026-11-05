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
