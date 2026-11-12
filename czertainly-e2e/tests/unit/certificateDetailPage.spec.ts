/**
 * certificateDetailPage — offline checks of pages/CertificateDetailPage.ts on `page.setContent` documents shaped like the
 * admin UI: the toolbar states inside the Certificate / CSR Properties widget, the Registration widget rows and the state
 * badge. Each assertion is shown passing on the right page and failing on a wrong one.
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
    // Four expected failures wait out the 5 s expect timeout each.
    test.setTimeout(90_000);
    const cert = new CertificateDetailPage(page);
    await page.setContent(registration({ registrationState: 'Active', registrationExpiresAt: '2026-10-21T10:00:00Z', registrationFailedAttempts: '0' }));
    await cert.assertRegistration({ state: 'Active', failedAttempts: 0 });
    expect((await cert.registrationExpires()).toISOString()).toBe('2026-10-21T10:00:00.000Z');
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
