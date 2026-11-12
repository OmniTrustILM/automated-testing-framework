/**
 * revokeDialog — offline check of pages/RevokeDialog.ts on a stand-in Revoke dialog whose reason Select opens a
 * listbox of options and closes on Escape, like the admin UI's popover Select: the reason labels are read from the open
 * option list and compared as an exact set.
 */
import { expect, test } from '@playwright/test';
import { RevokeDialog } from '../../pages/RevokeDialog';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

/** The Revoke dialog with a popover Select: the trigger shows the listbox, Escape hides it again. */
const revokeDialog = (labels: readonly string[]) => `<main><section><div><h5>Certificate Properties</h5><button data-testid="minus-square-button">r</button></div></section></main>
  <div role="dialog" aria-label="Revoke Certificate"><button data-testid="select-revokeReason-trigger" aria-haspopup="listbox"
    onclick="document.getElementById('reasons').hidden=false">Select</button></div>
  <div id="reasons" role="listbox" hidden>${labels.map((l) => `<div role="option" data-value="${l.replace(/ /g, '')}">${l}</div>`).join('')}</div>
  <script>document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('reasons').hidden = true; });</script>`;

test('RevokeDialog.reasonLabels / assertReasons: the option labels of the open reason Select, exact set', async ({ page }) => {
    test.setTimeout(60_000);
    const revoke = new RevokeDialog(page);
    const labels = ['Unspecified', 'Key compromise', 'CA compromise', 'Affiliation changed', 'Superseded', 'Cessation of operation', 'Certificate hold', 'Privilege withdrawn', 'AA compromise'];
    await page.setContent(revokeDialog(labels));
    expect(await revoke.reasonLabels()).toEqual(labels);
    await expect(page.getByRole('listbox'), 'the option list is closed again').toHaveCount(0);
    await revoke.assertReasons(labels);
    expect(await failsFast(revoke.assertReasons(labels.slice(0, 8)))).toBe(true);
    expect(await failsFast(revoke.assertReasons([...labels, 'Removed from CRL']))).toBe(true);
});

test('RevokeDialog.reasonLabels skips a placeholder option ("Choose …") before the nine labels are compared', async ({ page }) => {
    test.setTimeout(60_000);
    const revoke = new RevokeDialog(page);
    const labels = ['Unspecified', 'Key compromise', 'CA compromise', 'Affiliation changed', 'Superseded', 'Cessation of operation', 'Certificate hold', 'Privilege withdrawn', 'AA compromise'];
    await page.setContent(revokeDialog(['Choose revocation reason', ...labels]));
    expect(await revoke.reasonLabels()).toEqual(labels);
    await revoke.assertReasons(labels);
});
