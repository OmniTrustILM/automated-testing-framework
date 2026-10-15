/**
 * cert-lifecycle (B3) — offline checks of the lifecycle page-object assertions against static fixtures shaped like
 * fe-administrator origin/main (Widget = `<section>` with an `<h5>` title; CustomTable rows `tr[data-id]`; WidgetButtons
 * `<icon>-button`; the Registration widget rows; the Related Certificates and Approvals tab rows; the approvals list and
 * detail). No server: `page.setContent` documents. Each assertion is shown passing on the right page and failing on a
 * wrong one.
 */
import { expect, test } from '@playwright/test';
import { ApprovalsPage } from '../../pages/ApprovalsPage';
import { CertificateLifecyclePage } from '../../pages/CertificateLifecyclePage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

const properties = (title: string, buttons: Record<string, boolean>) => `<section><div><h5>${title}</h5>
  ${Object.entries(buttons).map(([icon, enabled]) => `<button data-testid="${icon}-button" ${enabled ? '' : 'disabled'}>${icon}</button>`).join('')}
  </div></section>`;

test('assertToolbar: enabled / disabled per icon inside the Certificate / CSR Properties widget, not another widget\'s buttons', async ({ page }) => {
    test.setTimeout(60_000);
    const cert = new CertificateLifecyclePage(page);
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
    const cert = new CertificateLifecyclePage(page);
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
    const cert = new CertificateLifecyclePage(page);
    await page.setContent(`<div role="tablist"><button role="tab">Details</button></div><main><table><tbody><tr data-id="certState"><td>State</td><td><span data-testid="certificate-status">Pending approval</span></td></tr></tbody></table></main>`);
    await cert.assertState('Pending approval');
    expect(await failsFast(cert.assertState('Issued'))).toBe(true);
});

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
        expect(await approvals.overrideApprove(U1)).toBe(204);
        await approvals.assertStatus(U1, 'Approved');
        expect(patched).toEqual([`/api/v1/approvals/${U1}/approve`]);
        await approvals.goToList();
        expect(await approvals.overrideReject(U1)).toBe(204);
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

/** A fake certificate detail with the Renew dialog: renewSubmit POSTs …/renew and the answer carries the successor uuid. */
const renewDetail = (uuid: string) => `<!doctype html><html><body><main><section><div><h5>Certificate Properties</h5><button data-testid="retweet-button" onclick="document.getElementById('dlg').hidden=false">renew</button></div></section></main>
  <div id="dlg" role="dialog" aria-label="Renew Certificate" hidden><div data-testid="switch-registerSuccessor"><input data-testid="switch-registerSuccessor-input" type="checkbox"></div>
  <textarea id="__fileUpload__fileContent"></textarea><button data-testid="renewSubmit" onclick="fetch('/api/v2/operations/authorities/${uuid}/raProfiles/${uuid}/certificates/${uuid}/renew', { method: 'POST' }).then(() => { document.getElementById('dlg').hidden = true; })">Renew</button></div></body></html>`;

test('CertificateLifecyclePage renew dialog: open from the toolbar, register switch off, CSR pasted, submit returns the renew answer', async ({ browser }) => {
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
        const cert = new CertificateLifecyclePage(page);
        await cert.openRenewDialog();
        await cert.assertRenewRegisterOff();
        await cert.pasteRenewCsr('-----BEGIN CERTIFICATE REQUEST-----\nYQ==\n-----END CERTIFICATE REQUEST-----');
        await expect(cert.renewDialog.locator('#__fileUpload__fileContent')).toHaveValue(/BEGIN CERTIFICATE REQUEST/);
        expect(await cert.submitRenew()).toEqual({ status: 200, uuid: U2 });
        await expect(cert.renewDialog).toBeHidden();
        // Mutant: the register switch on is a refusal of assertRenewRegisterOff.
        await cert.openRenewDialog();
        await page.getByTestId('switch-registerSuccessor-input').check();
        expect(await failsFast(cert.assertRenewRegisterOff())).toBe(true);
    } finally {
        await context.close();
    }
});

test('revokeReasonLabels / assertRevokeReasons: the option labels of the reason Select (the native mirror, placeholder dropped), exact set', async ({ page }) => {
    const cert = new CertificateLifecyclePage(page);
    const labels = ['Unspecified', 'Key compromise', 'CA compromise', 'Affiliation changed', 'Superseded', 'Cessation of operation', 'Certificate hold', 'Privilege withdrawn', 'AA compromise'];
    await page.setContent(`<main><section><div><h5>Certificate Properties</h5><button data-testid="minus-square-button">r</button></div></section></main>
      <div role="dialog" aria-label="Revoke Certificate"><button data-testid="select-revokeReason-trigger" aria-haspopup="listbox">Select</button>
      <select id="revokeReason" aria-hidden class="sr-only"><option value="">Choose</option>${labels.map((l) => `<option value="${l.replace(/ /g, '')}">${l}</option>`).join('')}</select></div>`);
    expect(await cert.revokeReasonLabels()).toEqual(labels);
    await cert.assertRevokeReasons(labels);
    expect(await failsFast(cert.assertRevokeReasons(labels.slice(0, 8)))).toBe(true);
    expect(await failsFast(cert.assertRevokeReasons([...labels, 'Removed from CRL']))).toBe(true);
});
