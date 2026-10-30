/**
 * approvalsPage — offline checks of pages/ApprovalsPage.ts on stand-in documents.
 *
 * Checks the list row status and checkbox, the detail status and recipient comment, and the override Approve / Reject
 * through the confirm dialog; each override returns the answer of its PATCH. REG-CERT-16 / 17 assert that status, so a wrong
 * button must fail on the wait for the exact request. A loopback-addressed context answers the PATCH itself.
 */
import { expect, test } from '@playwright/test';
import { ApprovalsPage } from '../../pages/ApprovalsPage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

test('ApprovalsPage list and detail: the row status, the row checkbox, the detail status and the recipient comment', async ({ page }) => {
    // Four expected failures wait out the 5 s expect timeout each.
    test.setTimeout(90_000);
    const approvals = new ApprovalsPage(page);
    const U1 = '11111111-1111-4111-8111-111111111111';
    await page.setContent(`<main><section><div><h5>List of Approvals</h5><button data-testid="check-button">a</button><button data-testid="times-button">r</button></div>
      <table><tbody><tr data-id="${U1}"><td><input type="checkbox" id="${U1}__checkbox__"></td><td>${U1}</td><td><span>Pending</span></td></tr></tbody></table></section></main>`);
    await approvals.assertStatus(U1, 'Pending');
    expect(await failsFast(approvals.assertStatus(U1, 'Approved'))).toBe(true);
    await approvals.checkRow(U1);
    await expect(approvals.row(U1).locator('input[type="checkbox"]')).toBeChecked();
    await page.setContent(`<main><section><div><h5>Approval Details</h5><button data-testid="check-button" disabled>a</button><button data-testid="times-button" disabled>r</button></div>
      <table><tbody><tr data-id="status"><td>Status</td><td><span>Approved</span></td></tr></tbody></table></section>
      <section><div><h5>Approvers</h5></div><table><tbody><tr data-id="rcp"><td>1</td><td>admin</td><td></td><td>Approved</td><td>Approval flow overridden</td></tr></tbody></table></section></main>`);
    await approvals.assertDetailStatus('Approved');
    await approvals.assertRecipientComment('Approval flow overridden');
    await approvals.assertRecipientButtons('disabled');
    expect(await failsFast(approvals.assertDetailStatus('Pending'))).toBe(true);
    expect(await failsFast(approvals.assertRecipientComment('a comment nobody wrote'))).toBe(true);
    expect(await failsFast(approvals.assertRecipientButtons('enabled'))).toBe(true);
});

/** A fake approvals list with the override dialogs: the confirm button PATCHes the route the page object waits for. */
const approvalsList = (uuid: string) => `<!doctype html><html><body><main><section><div><h5>List of Approvals</h5>
  <button data-testid="check-button" onclick="openDialog('approve')">a</button><button data-testid="times-button" onclick="openDialog('reject')">r</button></div>
  <table><tbody><tr data-id="${uuid}"><td><input type="checkbox" id="${uuid}__checkbox__"></td><td>${uuid}</td><td><span id="st">Pending</span></td></tr></tbody></table></section></main>
  <div id="dlg" role="dialog" hidden><button id="yes"></button></div>
  <script>
    let decision;
    function openDialog(d) { decision = d; const dlg = document.getElementById('dlg'); dlg.setAttribute('aria-label', d === 'approve' ? 'Accept the selected Approval?' : 'Reject the selected Approval?'); document.getElementById('yes').textContent = d === 'approve' ? 'Yes, approve' : 'Yes, reject'; dlg.hidden = false; }
    document.getElementById('yes').onclick = async () => { const r = await fetch('/api/v1/approvals/${uuid}/' + decision, { method: 'PATCH' }); document.getElementById('dlg').hidden = true; if (r.status === 204) document.getElementById('st').textContent = decision === 'approve' ? 'Approved' : 'Rejected'; };
  </script></body></html>`;

test('ApprovalsPage.overrideApprove / overrideReject: the list toolbar, the confirm dialog and the PATCH …/approve | …/reject the page object waits for', async ({ browser }) => {
    test.setTimeout(60_000);
    const U1 = '11111111-1111-4111-8111-111111111111';
    const patched: string[] = [];
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9/' });
    try {
        await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (route.request().method() === 'PATCH') {
                patched.push(url.pathname);
                return route.fulfill({ status: 204, body: '' });
            }
            return route.fulfill({ contentType: 'text/html', body: approvalsList(U1) });
        });
        const page = await context.newPage();
        const approvals = new ApprovalsPage(page);
        await approvals.goToList();
        await approvals.checkRow(U1);
        expect((await approvals.overrideApprove(U1)).status).toBe(204);
        await approvals.assertStatus(U1, 'Approved');
        expect(patched).toEqual([`/api/v1/approvals/${U1}/approve`]);
        await approvals.goToList();
        expect((await approvals.overrideReject(U1)).status).toBe(204);
        await approvals.assertStatus(U1, 'Rejected');
        expect(patched).toEqual([`/api/v1/approvals/${U1}/approve`, `/api/v1/approvals/${U1}/reject`]);
        // Mutant: Approve on the toolbar must never satisfy a reject (the wrong icon = the wrong route, caught by the wait).
        await approvals.goToList();
        await expect(approvals.row(U1)).toBeVisible();
        await page.evaluate(() => { document.querySelector('[data-testid="times-button"]')!.setAttribute('onclick', "openDialog('approve')"); });
        await expect(approvals.overrideReject(U1)).rejects.toThrow();
    } finally {
        await context.close();
    }
});
