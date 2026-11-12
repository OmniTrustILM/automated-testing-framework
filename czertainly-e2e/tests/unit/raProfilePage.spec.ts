/**
 * raProfilePage — offline checks of pages/RaProfilePage.ts on stand-in documents of the RA profile Protocols tab: a
 * protocol is active only with the Enabled badge AND the Deactivate button on its own row, inactive only with both
 * opposites. Each assertion is shown passing on the right page and failing on a wrong one.
 */
import { expect, test } from '@playwright/test';
import { RaProfilePage } from '../../pages/RaProfilePage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

/** The RA profile Protocols tab: the ACME row shows `badge` and offers `button` (the SCEP row is always Enabled / Deactivate). */
const protocols = (badge: 'Enabled' | 'Disabled', button: 'Activate' | 'Deactivate') => `<main><section><div><h5>Available Protocols</h5></div><table><tbody>
  <tr data-id="acme"><td>ACME</td><td><span data-testid="status-badge">${badge}</span></td><td><button data-testid="progress-button">${button}</button></td></tr>
  <tr data-id="scep"><td>SCEP</td><td><span data-testid="status-badge">Enabled</span></td><td><button data-testid="progress-button">Deactivate</button></td></tr>
  </tbody></table></section></main>`;

// Each failing assertion waits the 5 s expect timeout, so the two directions are two tests (20 s limit each).
test('RaProfilePage.assertProtocolInactive needs BOTH the Disabled badge and the Activate button, on the protocol\'s own row', async ({ page }) => {
    const ra = new RaProfilePage(page);
    await page.setContent(protocols('Disabled', 'Activate'));
    await ra.assertProtocolInactive('acme');
    // The button alone says inactive, the badge says Enabled: not inactive (mutant: the badge is not checked).
    await page.setContent(protocols('Enabled', 'Activate'));
    expect(await failsFast(ra.assertProtocolInactive('acme'))).toBe(true);
    // A fully active ACME row is not inactive.
    await page.setContent(protocols('Enabled', 'Deactivate'));
    expect(await failsFast(ra.assertProtocolInactive('acme'))).toBe(true);
});

test('RaProfilePage.assertProtocolActive needs BOTH the Enabled badge and the Deactivate button, on the protocol\'s own row', async ({ page }) => {
    const ra = new RaProfilePage(page);
    await page.setContent(protocols('Enabled', 'Deactivate'));
    await ra.assertProtocolActive('acme');
    // Another row being active does not make ACME active (row scope).
    await page.setContent(protocols('Disabled', 'Activate'));
    await ra.assertProtocolActive('scep');
    expect(await failsFast(ra.assertProtocolActive('acme'))).toBe(true);
    // The badge alone says active, the button offers Activate: not active.
    await page.setContent(protocols('Enabled', 'Activate'));
    expect(await failsFast(ra.assertProtocolActive('acme'))).toBe(true);
});
