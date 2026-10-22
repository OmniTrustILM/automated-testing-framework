/**
 * certificateAddPage — offline checks of pages/CertificateAddPage.ts (the Add Certificate form) on stand-in documents:
 * Create either redirects to the new certificate or shows the "accepted with warnings" panel, and both give the uuid.
 * A failed issue stays on the form and fails the step.
 */
import { expect, test } from '@playwright/test';
import { CertificateAddPage } from '../../pages/CertificateAddPage';
import { CertificatePage } from '../../pages/CertificatePage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

/** The certificate form after Create: `redirect` goes to the detail; `warnings` shows the accepted-with-warnings panel first. */
const issueForm = (outcome: 'redirect' | 'warnings' | 'error', uuid = 'a1b2c3d4-0000-4000-8000-000000000001') => `<main>
  <form><button type="button" data-testid="progress-button" onclick="${
      outcome === 'redirect'
          ? `location.hash='#/certificates/detail/${uuid}'`
          : outcome === 'warnings'
            ? `document.getElementById('after').hidden=false; this.hidden=true`
            : `document.getElementById('err').hidden=false`
  }">Create</button></form>
  <div id="err" hidden role="alert">Failed to issue certificate (422)</div>
  <div id="after" hidden>
    <div data-testid="compliance-errors-panel" data-severity="warning" role="status"><h6>Certificate request accepted with warnings</h6>
      <p>The request was accepted and passed to the authority.</p>
      <ul><li>SAN iPAddress '192.0.2.10' is not allowed by the request-attribute set</li><li>Subject RDN 'O' is not allowed by the request-attribute set</li></ul></div>
    <button type="button">Close</button>
    <button type="button" onclick="location.hash='#/certificates/detail/${uuid}'">Open certificate</button>
  </div></main>`;

test('CertificateAddPage.submitIssueFailingOnWarnings: redirect or warnings panel give the uuid; a failed issue fails', async ({ page }) => {
    test.setTimeout(60_000);
    const add = new CertificateAddPage(page);
    const cert = new CertificatePage(page);
    // Each fixture starts on the add route, as the app does (setContent keeps the previous hash otherwise).
    const onAddRoute = async (html: string) => {
        await page.evaluate(() => {
            location.hash = '#/certificates/add';
        });
        await page.setContent(html);
    };
    await onAddRoute(issueForm('redirect'));
    expect(await add.submitIssueFailingOnWarnings()).toEqual({ uuid: 'a1b2c3d4-0000-4000-8000-000000000001', warnings: [] });
    await onAddRoute(issueForm('warnings', 'a1b2c3d4-0000-4000-8000-000000000002'));
    expect(await add.submitIssueFailingOnWarnings({ acceptWarnings: true })).toEqual({
        uuid: 'a1b2c3d4-0000-4000-8000-000000000002',
        warnings: ["SAN iPAddress '192.0.2.10' is not allowed by the request-attribute set", "Subject RDN 'O' is not allowed by the request-attribute set"],
    });
    expect(page.url()).toMatch(/#\/certificates\/detail\/a1b2c3d4-0000-4000-8000-000000000002$/);
    // CertificatePage.submitIssue (the smoke specs' call) gives the uuid of the redirect, and FAILS on the warnings panel unless
    // the row accepts it explicitly.
    await onAddRoute(issueForm('redirect'));
    expect(await cert.submitIssue()).toBe('a1b2c3d4-0000-4000-8000-000000000001');
    await onAddRoute(issueForm('warnings', 'a1b2c3d4-0000-4000-8000-000000000003'));
    await expect(cert.submitIssue()).rejects.toThrow(/accepted with warnings.*SAN iPAddress/);
    await onAddRoute(issueForm('warnings', 'a1b2c3d4-0000-4000-8000-000000000003'));
    await expect(add.submitIssueFailingOnWarnings()).rejects.toThrow(/accepted with warnings/);
    await onAddRoute(issueForm('warnings', 'a1b2c3d4-0000-4000-8000-000000000003'));
    expect(await cert.submitIssue({ acceptWarnings: true })).toBe('a1b2c3d4-0000-4000-8000-000000000003');
    // A failed issue: neither outcome — the step fails instead of returning a uuid (the 15 s wait is the page object's).
    await onAddRoute(issueForm('error'));
    expect(await failsFast(add.submitIssueFailingOnWarnings())).toBe(true);
});
