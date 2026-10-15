/**
 * B1 fix pass (Sonnet F10) — offline checks of the B1 page-object assertions against static fixtures shaped like
 * fe-administrator origin/main (Widget = `<section>` with an `<h5>` title; CustomTable rows `tr[data-id]`; the RA-profile
 * protocol row with a status badge and a ProgressButton; the list's client-side `Search` box). No server: the fixtures
 * are `page.setContent` documents, or a document every request of a loopback-addressed context is fulfilled with
 * (`context.route`, nothing leaves the browser). Each assertion is shown passing on the right page and failing on a
 * wrong one.
 */
import { Browser, expect, Page, test } from '@playwright/test';
import { AcmeAccountPage } from '../../pages/AcmeAccountPage';
import { CertificatePage } from '../../pages/CertificatePage';
import { RaProfilePage } from '../../pages/RaProfilePage';
import { widget } from '../../pages/RegressionUi';
import { RolePage } from '../../pages/RolePage';
import { UserPage } from '../../pages/UserPage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

test('widget(): the closest <section> around the title heading — nested widgets, exact titles, RegExp titles', async ({ page }) => {
    await page.setContent(`<main>
      <section data-testid="outer"><div><h5>Role Details</h5></div>
        <section data-testid="inner-a"><div><h5>Subject Alternative Names</h5><button data-testid="pencil-button">e</button></div></section>
        <section data-testid="inner-b"><div><h5>Subject Alternative Names extra</h5><button data-testid="pencil-button">e</button></div></section>
        <section data-testid="inner-c"><div><h5>CSR Properties</h5></div></section>
      </section></main>`);
    await expect(widget(page, 'Subject Alternative Names')).toHaveAttribute('data-testid', 'inner-a');
    await expect(widget(page, 'Role Details')).toHaveAttribute('data-testid', 'outer');
    await expect(widget(page.locator('main'), /^(Certificate|CSR) Properties$/)).toHaveAttribute('data-testid', 'inner-c');
    await expect(widget(page, 'Subject Alternative Names').getByTestId('pencil-button')).toHaveCount(1);
    await expect(widget(page, 'Nope')).toHaveCount(0);
    // Regex characters in a title are literal.
    await page.setContent('<main><section data-testid="s"><h5>A (b) [c].*</h5></section></main>');
    await expect(widget(page, 'A (b) [c].*')).toHaveAttribute('data-testid', 's');
});

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

/** A list page whose Search box filters the rows client-side, like CustomTable; `rows` = the names listed. */
const listPage = (title: string, kind: string, rows: string[], loaded = true) => `<!doctype html><html><body><main>
  <section><div><h5>${title}</h5><button data-testid="plus-button">+</button></div>
  <input aria-label="Search" id="search">
  <table><tbody id="rows">${loaded ? rows.map((r, i) => `<tr data-id="u${i}"><td><a href="#/${kind}/detail/u${i}">${r}</a></td></tr>`).join('') : '<tr><td>loading</td></tr>'}</tbody></table>
  </section></main>
  <script>document.getElementById('search').addEventListener('input', (e) => {
    for (const tr of document.querySelectorAll('#rows tr')) tr.style.display = tr.textContent.toLowerCase().includes(e.target.value.toLowerCase()) ? '' : 'none';
  });</script></body></html>`;

/**
 * A browser context that answers every request itself with the current `served` document (a loopback base URL, nothing
 * leaves the machine), so a test can change what "the server" answers between two calls of a page object.
 */
async function withServedPage(browser: Browser, first: string, body: (page: Page, serve: (html: string) => void) => Promise<void>): Promise<void> {
    let served = first;
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9/' });
    try {
        await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: served }));
        await body(await context.newPage(), (html) => { served = html; });
    } finally {
        await context.close();
    }
}

// The rows-loaded wait is the page object's own (`loadTimeout`), so the "never loads" case needs 2 s here, not 30 s.
test('RolePage.assertGone: absent after the list showed rows; present → fails; a list that never loads → fails (positive marker); the list is re-read each time', async ({ browser }) => {
    await withServedPage(browser, listPage('List of Roles', 'roles', ['Administrators', 'Auditors']), async (page, serve) => {
        const rolePage = new RolePage(page);
        await rolePage.assertGone('qa-reg-x-role-delete');
        // The same hash route again: the document the "server" answers NOW must be the one that is judged (a same-hash goto
        // is no navigation, so without the reload the first render would stay).
        serve(listPage('List of Roles', 'roles', ['Administrators', 'qa-reg-x-role-delete']));
        expect(await failsFast(rolePage.assertGone('qa-reg-x-role-delete'))).toBe(true);
        serve(listPage('List of Roles', 'roles', [], false));
        expect(await failsFast(rolePage.assertGone('qa-reg-x-role-delete', { loadTimeout: 2_000 })), 'an unloaded list is no proof of absence').toBe(true);
    });
});

test('UserPage.assertGone: absent after the list showed rows; present → fails; coming from another list page, the new list is the one judged', async ({ browser }) => {
    await withServedPage(browser, listPage('List of Roles', 'roles', ['Administrators', 'Auditors']), async (page, serve) => {
        // The page starts on the roles list (another hash route of the same document): the users list must still be read.
        await new RolePage(page).goToList();
        serve(listPage('List of Users', 'users', ['admin', 'operator']));
        const userPage = new UserPage(page);
        await userPage.assertGone('qa-reg-x-user-delete');
        serve(listPage('List of Users', 'users', ['operator', 'qa-reg-x-user-delete']));
        expect(await failsFast(userPage.assertGone('qa-reg-x-user-delete'))).toBe(true);
        serve(listPage('List of Users', 'users', [], false));
        expect(await failsFast(userPage.assertGone('qa-reg-x-user-delete', { loadTimeout: 2_000 })), 'an unloaded list is no proof of absence').toBe(true);
    });
});

test('UserPage.assertRoles reads the detail\'s Roles row as a set', async ({ page }) => {
    const user = new UserPage(page);
    await page.setContent(`<main><section><div><h5>User Details</h5></div><table><tbody>
      <tr data-id="roles"><td>Roles</td><td>qa-reg-x-role-b, qa-reg-x-role-a</td></tr></tbody></table></section></main>`);
    await user.assertRoles(['qa-reg-x-role-a', 'qa-reg-x-role-b']);
    expect(await failsFast(user.assertRoles(['qa-reg-x-role-a']))).toBe(true);
});

// ------------------------------------------------------------------ incident fixes (B1 live run 1)

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

test('CertificatePage.submitIssueWithWarnings: the redirect gives the uuid and no warnings; the accepted-with-warnings panel is opened through "Open certificate" and its messages returned; a failed issue fails', async ({ page }) => {
    test.setTimeout(60_000);
    const cert = new CertificatePage(page);
    // Each fixture starts on the add route, as the app does (setContent keeps the previous hash otherwise).
    const onAddRoute = async (html: string) => {
        await page.evaluate(() => {
            location.hash = '#/certificates/add';
        });
        await page.setContent(html);
    };
    await onAddRoute(issueForm('redirect'));
    expect(await cert.submitIssueWithWarnings()).toEqual({ uuid: 'a1b2c3d4-0000-4000-8000-000000000001', warnings: [] });
    await onAddRoute(issueForm('warnings', 'a1b2c3d4-0000-4000-8000-000000000002'));
    expect(await cert.submitIssueWithWarnings()).toEqual({
        uuid: 'a1b2c3d4-0000-4000-8000-000000000002',
        warnings: ["SAN iPAddress '192.0.2.10' is not allowed by the request-attribute set", "Subject RDN 'O' is not allowed by the request-attribute set"],
    });
    expect(page.url()).toMatch(/#\/certificates\/detail\/a1b2c3d4-0000-4000-8000-000000000002$/);
    // The plain submitIssue keeps its contract (the uuid) on both outcomes.
    await onAddRoute(issueForm('warnings', 'a1b2c3d4-0000-4000-8000-000000000003'));
    expect(await cert.submitIssue()).toBe('a1b2c3d4-0000-4000-8000-000000000003');
    // A failed issue: neither outcome — the step fails instead of returning a uuid (the 15 s wait is the page object's).
    await onAddRoute(issueForm('error'));
    expect(await failsFast(cert.submitIssueWithWarnings())).toBe(true);
});

/**
 * The ACME accounts list as CustomTable renders it: the Search box filters the rows' text client-side and the table
 * pages by 10, so only the first 10 matching rows are in the DOM (M18: without the search, an account on page 2 is absent).
 */
const acmeAccountsList = (rows: Array<[string, string]>) => `<main><section><div><h5>List of ACME Accounts</h5></div>
  <input id="search" aria-label="Search" placeholder="Search" type="text" />
  <table><thead><tr><th>Account Id</th><th>ACME Profile Name</th></tr></thead><tbody></tbody></table></section></main>
  <script>
    const ROWS = ${JSON.stringify(rows)};
    const render = () => {
      const q = document.getElementById('search').value.toLowerCase();
      const shown = ROWS.filter(([id, profile]) => (id + profile + 'Enabled').toLowerCase().includes(q)).slice(0, 10);
      document.querySelector('tbody').innerHTML = shown.map(([id, profile]) =>
        '<tr data-id="' + id + '"><td><a href="#/acmeaccounts/detail/p/' + id + '">' + id + '</a></td><td><a href="#/acmeprofiles/detail/p">' + profile + '</a></td><td>Enabled</td></tr>').join('');
    };
    document.getElementById('search').addEventListener('input', render);
    render();
  </script>`;
/** Ten foreign accounts sorted first (as the live list does by profile name), then the run's account on page 2. */
const pageOne: Array<[string, string]> = Array.from({ length: 10 }, (_, i) => [`AcctFake00${10 + i}`, 'other-acme-profile']);

test('AcmeAccountPage.assertListed: the row of the account id under the ACME profile name; a page without it, or with it under another profile, fails', async ({ page }) => {
    test.setTimeout(60_000);
    const accounts = new AcmeAccountPage(page);
    await page.setContent(acmeAccountsList([...pageOne, ['AcctFake0002', 'qa-reg-x-acme']]));
    await expect(accounts.listWidget.locator('tbody tr'), 'the run account is on page 2: not in the DOM without a search').toHaveCount(10);
    await accounts.assertListed('AcctFake0002', 'qa-reg-x-acme');
    await expect(accounts.listWidget.getByRole('textbox', { name: 'Search' }), 'the search box is cleared afterwards').toHaveValue('');
    await expect(accounts.listWidget.locator('tbody tr')).toHaveCount(10);
    expect(await failsFast(accounts.assertListed('AcctFake0002', 'other-acme-profile'))).toBe(true);
    expect(await failsFast(accounts.assertListed('AcctFake0003', 'qa-reg-x-acme'))).toBe(true);
    // A row whose id merely contains the searched id is not the account (exact link name).
    await page.setContent(acmeAccountsList([...pageOne, ['AcctFake0002x', 'qa-reg-x-acme']]));
    expect(await failsFast(accounts.assertListed('AcctFake0002', 'qa-reg-x-acme'))).toBe(true);
});
