/**
 * certificatePage — offline check of pages/CertificatePage.ts on a `page.setContent` Details tab: the SAN widget is
 * read per type, and `assertSans` compares the exact DNS + IP set or, on a CA that rewrites the SAN extension, the DNS
 * names only. Each assertion is shown passing on the right page and failing on a wrong one.
 */
import { expect, test } from '@playwright/test';
import { CertificatePage } from '../../pages/CertificatePage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

/** The Details tab of a certificate with the given SAN rows. */
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
    // An extra DNS name: exact fails, dns passes.
    await page.setContent(certDetails({ dNSName: 'a.example.test, alt.a.example.test, extra.example.test', iPAddress: '192.0.2.10' }));
    expect(await failsFast(cert.assertSans(want, 'exact'))).toBe(true);
    await cert.assertSans(want, 'dns');
    // The IP alone is wrong or missing (the DNS names are right): exact fails, dns passes (mutant: the IP is not compared).
    await page.setContent(certDetails({ dNSName: 'a.example.test, alt.a.example.test', iPAddress: '192.0.2.99' }));
    expect(await failsFast(cert.assertSans(want, 'exact'))).toBe(true);
    await cert.assertSans(want, 'dns');
    await page.setContent(certDetails({ dNSName: 'a.example.test, alt.a.example.test' }));
    expect(await failsFast(cert.assertSans(want, 'exact'))).toBe(true);
    await cert.assertSans(want, 'dns');
    // A DNS name missing: both fail.
    await page.setContent(certDetails({ dNSName: 'a.example.test', iPAddress: '192.0.2.10' }));
    expect(await failsFast(cert.assertSans(want, 'exact'))).toBe(true);
    expect(await failsFast(cert.assertSans(want, 'dns'))).toBe(true);
});
