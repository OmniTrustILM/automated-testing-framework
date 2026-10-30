/**
 * Offline checks of pages/ImportCertificatesDialog.ts against a static document shaped like the admin UI import
 * dialog: refused files, the alert, the disabled button, the password field and the listed entries. A browser
 * context answers every request itself; nothing leaves the machine.
 */
import { Browser, BrowserContext, expect, Page, Route, test } from '@playwright/test';
import { ImportCertificatesDialog } from '../../pages/ImportCertificatesDialog';
import { randomBytes } from 'node:crypto';

// Run-scoped generated test passwords: no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;

test.describe.configure({ timeout: 60_000 });

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);
const BASE = 'http://127.0.0.1:9/';

// ------------------------------------------------------------------ a context that is the "server"

interface Served {
    inspection: { status: number; body: unknown };
    inspections: Array<Record<string, unknown>>;
    raProfiles: Array<Record<string, unknown>>;
    raStatus: number;
    html: string;
    extra: (path: string, method: string) => { status: number; body?: unknown } | undefined;
}

async function serve(browser: Browser, served: Served): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ baseURL: BASE });
    await context.route('**/*', async (route: Route) => {
        const url = new URL(route.request().url());
        const method = route.request().method();
        if (url.pathname === '/api/v1/inspections' && method === 'POST') {
            served.inspections.push(JSON.parse(route.request().postData() ?? '{}'));
            return route.fulfill({ status: served.inspection.status, contentType: 'application/json', body: JSON.stringify(served.inspection.body) });
        }
        if (/\/api\/v1\/authorities\/[^/]+\/raProfiles$/.test(url.pathname) && method === 'POST') {
            served.raProfiles.push(JSON.parse(route.request().postData() ?? '{}'));
            return route.fulfill({ status: served.raStatus, contentType: 'application/json', body: JSON.stringify(served.raStatus < 300 ? { uuid: '11111111-1111-4111-8111-111111111111' } : ['Required attribute Certificate Template not found.']) });
        }
        const extra = served.extra(url.pathname, method);
        if (extra) return route.fulfill({ status: extra.status, contentType: 'application/json', body: JSON.stringify(extra.body ?? {}) });
        if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"no"}' });
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: served.html });
    });
    return { context, page: await context.newPage() };
}

const newServed = (html: string, patch: Partial<Served> = {}): Served => ({
    inspection: { status: 200, body: { containerDigest: 'd', entries: [] } },
    inspections: [],
    raProfiles: [],
    raStatus: 422,
    html,
    extra: () => undefined,
    ...patch,
});

// ------------------------------------------------------------------ ImportCertificatesDialog

const IMPORT_APP = `<!doctype html><html><body>
<main><button data-testid="upload-button" id="open">upload</button></main>
<div id="dlg" role="dialog" aria-label="Import certificates and keys" hidden>
  <h3>Import certificates and keys</h3>
  <form id="form">
    <label for="fc">File content</label><textarea id="fc" data-testid="import-file-content"></textarea>
    <input type="file" aria-label="Select file" id="file" style="display:none">
    <div id="alert"></div>
    <div id="pw" hidden><label for="importPassphrase">File password</label><input id="importPassphrase" type="password"></div>
    <div id="detected"></div>
    <button type="button" id="cancel">Cancel</button>
    <button type="submit" data-testid="import-submit" id="submit" disabled>Import 0 entries</button>
  </form>
  <div id="results" hidden></div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  $('open').onclick = () => { $('dlg').hidden = false; };
  $('cancel').onclick = () => { $('dlg').hidden = true; };
  $('form').onsubmit = async (e) => {
    e.preventDefault();
    const res = await fetch('/api/v1/certificates/import', { method: 'POST', body: '{}' });
    const body = await res.json();
    $('form').hidden = true; $('results').hidden = false;
    $('results').innerHTML = '<section data-testid="import-results"><h4>Import results</h4><ul>' + body.results.map((r) => '<li><span data-testid="import-result-badge">' + r.badge + '</span></li>').join('') + '</ul></section><button data-testid="import-done" id="done">Done</button>';
    $('done').onclick = () => { $('dlg').hidden = true; };
  };
  let content = '';
  async function inspect(b64, passphrase) {
    const res = await fetch('/api/v1/inspections', { method: 'POST', body: JSON.stringify({ file: b64, passphrase: passphrase || undefined }) });
    const body = await res.json();
    $('detected').innerHTML = ''; $('submit').disabled = true; $('submit').textContent = 'Import 0 entries';
    if (!res.ok) {
      $('alert').innerHTML = '<div role="alert">Failed to read the uploaded file (' + res.status + '): ' + (Array.isArray(body) ? body.join('\\n') : body.message) + '</div>';
      $('pw').hidden = res.status !== 422;
      return;
    }
    $('alert').innerHTML = '';
    const n = body.entries.length;
    const selectable = body.entries.filter((x) => x.kind !== 'signingRequest').length;
    $('detected').innerHTML = '<section data-testid="import-detected-content" aria-labelledby="d"><h4 id="d">Detected content – ' + n + ' ' + (n === 1 ? 'entry' : 'entries') + '</h4><ul>' +
      body.entries.map((x) => { const csr = x.kind === 'signingRequest'; return '<li><div><input type="checkbox" id="e' + x.entryReference + '"' + (csr ? ' disabled' : ' checked') + '><label for="e' + x.entryReference + '">' + x.title + '</label>' +
        '<p>' + (csr ? 'Signing request' : 'Certificate') + '</p>' + (csr ? '<p>Certificate requests are not imported</p>' : '') + '</div><span data-testid="badge">' + (csr ? 'Signing request' : 'Certificate') + '</span></li>'; }).join('') + '</ul></section>';
    $('submit').disabled = selectable === 0; $('submit').textContent = 'Import ' + selectable + ' ' + (selectable === 1 ? 'entry' : 'entries');
  }
  $('file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; const r = new FileReader(); r.onload = () => { content = r.result.split(',')[1]; $('pw').hidden = true; inspect(content, ''); }; r.readAsDataURL(f); };
  $('fc').oninput = () => { content = btoa($('fc').value); inspect(content, ''); };
  $('importPassphrase').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); inspect(content, $('importPassphrase').value); } };
</script></body></html>`;

const CSR_ENTRY = { entryReference: 'a'.repeat(64), kind: 'signingRequest', title: 'CN=csr' };
const CERT_ENTRY = { entryReference: 'b'.repeat(64), kind: 'certificate', title: 'CN=cert' };

test('ImportCertificatesDialog: open, choose a refused file, read the alert / disabled button / password field, retry with a password', async ({ browser }) => {
    const served = newServed(IMPORT_APP, { inspection: { status: 422, body: ['A PEM file can hold at most one private key.'] } });
    const { context, page } = await serve(browser, served);
    try {
        const wizard = new ImportCertificatesDialog(page);
        await wizard.goToList();
        await wizard.openDialog();
        await expect(wizard.dialog).toBeVisible();
        const answer = await wizard.chooseFile({ name: 'two-keys.pem', mimeType: 'application/x-pem-file', buffer: Buffer.from('hello') });
        expect(answer.status).toBe(422);
        expect(served.inspections[0]).toEqual({ file: Buffer.from('hello').toString('base64') });
        await wizard.assertRefused('Failed to read the uploaded file (422): A PEM file can hold at most one private key.');
        await wizard.assertNoEntries();
        await wizard.assertSubmitDisabled();
        await wizard.assertPasswordFieldShown();
        // The wrong text, a missing alert, an enabled button and a hidden password field all fail.
        expect(
            await Promise.all([
                failsFast(wizard.assertRefused('Failed to read the uploaded file (422): another text')),
                failsFast(wizard.assertRefused('Failed to read the uploaded file (400): A PEM file can hold at most one private key.')),
                failsFast(wizard.assertNotRefused()),
                failsFast(wizard.assertDetected(1)),
                failsFast(wizard.assertPasswordFieldHidden()),
            ]),
            'the wrong text / status, a missing refusal, entries that are not there and a hidden password field all fail',
        ).toEqual([true, true, true, true, true]);
        // Enter in the password field reads the file again WITH the passphrase and never submits.
        const again = await wizard.enterPassword(GEN_PW_1);
        expect(again.status).toBe(422);
        expect(served.inspections[1]).toEqual({ file: Buffer.from('hello').toString('base64'), passphrase: GEN_PW_1 });
        await wizard.assertRefused('Failed to read the uploaded file (422): A PEM file can hold at most one private key.');
        await wizard.cancel();
    } finally {
        await context.close();
    }
});

test('ImportCertificatesDialog: a 200 lists the entries; a signing request is disabled with its reason; the alert and the password field are absent', async ({ browser }) => {
    const served = newServed(IMPORT_APP, { inspection: { status: 200, body: { containerDigest: 'x', entries: [CSR_ENTRY] } } });
    const { context, page } = await serve(browser, served);
    try {
        const wizard = new ImportCertificatesDialog(page);
        await wizard.goToList();
        await wizard.openDialog();
        await wizard.pasteContent('-----BEGIN CERTIFICATE REQUEST-----');
        await wizard.assertDetected(1);
        await wizard.assertSigningRequest('Certificate requests are not imported');
        await wizard.assertNotRefused();
        await wizard.assertPasswordFieldHidden();
        expect(await Promise.all([failsFast(wizard.assertRefused('x')), failsFast(wizard.assertPasswordFieldShown()), failsFast(wizard.assertSigningRequest('another reason'))])).toEqual([true, true, true]);

        // A certificate entry is no signing request: its checkbox is enabled, the button too.
        served.inspection = { status: 200, body: { containerDigest: 'y', entries: [CERT_ENTRY] } };
        await wizard.pasteContent('-----BEGIN CERTIFICATE-----');
        await wizard.assertDetected(1);
        expect(await Promise.all([failsFast(wizard.assertSigningRequest('Certificate requests are not imported')), failsFast(wizard.assertSubmitDisabled())])).toEqual([true, true]);
        // Import (only specs that import their own objects use it): one request, the results region lists the badges.
        served.inspection = { status: 200, body: { containerDigest: 'y', entries: [CERT_ENTRY] } };
        await context.route('**/api/v1/certificates/import', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [{ badge: 'Imported' }] }) }));
        const imported = await wizard.submit();
        expect(imported.status).toBe(200);
        await wizard.assertResults(['Imported']);
        expect(await failsFast(wizard.assertResults(['Already in inventory']))).toBe(true);
        await wizard.done();
    } finally {
        await context.close();
    }
});
