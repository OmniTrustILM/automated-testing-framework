/**
 * renewDialog — offline check of pages/RenewDialog.ts on a stand-in certificate detail.
 *
 * WHAT: the dialog opens from the toolbar, the register switch is off, the CSR is pasted and submit returns the renew
 *       answer with its status and the successor uuid.
 * WHY: REG-CERT-07 reads the successor's uuid from the answer and asserts the status; both must come back exactly.
 * HOW: a loopback-addressed context answers the renew POST itself; the stand-in dialog mirrors the product's test ids.
 */
import { expect, test } from '@playwright/test';
import { RenewDialog } from '../../pages/RenewDialog';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

/** A fake certificate detail with the Renew dialog: renewSubmit POSTs …/renew and the answer carries the successor uuid. */
const renewDetail = (uuid: string) => `<!doctype html><html><body><main><section><div><h5>Certificate Properties</h5><button data-testid="retweet-button" onclick="document.getElementById('dlg').hidden=false">renew</button></div></section></main>
  <div id="dlg" role="dialog" aria-label="Renew Certificate" hidden><div data-testid="switch-registerSuccessor"><input data-testid="switch-registerSuccessor-input" type="checkbox"></div>
  <textarea id="__fileUpload__fileContent"></textarea><button data-testid="renewSubmit" onclick="fetch('/api/v2/operations/authorities/${uuid}/raProfiles/${uuid}/certificates/${uuid}/renew', { method: 'POST' }).then(() => { document.getElementById('dlg').hidden = true; })">Renew</button></div></body></html>`;

test('RenewDialog: open from the toolbar, register switch off, CSR pasted, submit returns the renew answer', async ({ browser }) => {
    test.setTimeout(60_000);
    const U1 = '22222222-2222-4222-8222-222222222222';
    const U2 = '33333333-3333-4333-8333-333333333333';
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9/' });
    try {
        await context.route('**/*', (route) => {
            if (route.request().method() === 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ uuid: U2, certificateData: '' }) });
            return route.fulfill({ contentType: 'text/html', body: renewDetail(U1) });
        });
        const page = await context.newPage();
        await page.goto('administrator/#/certificates/detail/' + U1);
        const renew = new RenewDialog(page);
        await renew.open();
        await renew.assertRegisterOff();
        await renew.pasteCsr('-----BEGIN CERTIFICATE REQUEST-----\nYQ==\n-----END CERTIFICATE REQUEST-----');
        await expect(renew.dialog.locator('#__fileUpload__fileContent')).toHaveValue(/BEGIN CERTIFICATE REQUEST/);
        const answer = await renew.submit();
        expect(answer.status).toBe(200);
        expect(answer.uuid).toBe(U2);
        await expect(renew.dialog).toBeHidden();
        // Mutant: the register switch on is a refusal of assertRenewRegisterOff.
        await renew.open();
        await page.getByTestId('switch-registerSuccessor-input').check();
        expect(await failsFast(renew.assertRegisterOff())).toBe(true);
    } finally {
        await context.close();
    }
});
