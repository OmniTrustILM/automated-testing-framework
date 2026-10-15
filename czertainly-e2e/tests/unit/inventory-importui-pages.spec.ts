/**
 * Offline checks of the page objects and browser guards of the import / form-validation / sweep specs (ilm#424 B3, area
 * inventory-api): ImportWizardPage, RaProfileCreatePage and BrowserGuards run against static documents shaped like
 * fe-administrator origin/main (markup read from `ImportWizard/*`, `ra-profiles/form`, `Sidebar`; roles, labels and test ids as
 * the FE writes them). No server: a browser context answers every request itself on a loopback base URL, nothing leaves the
 * machine. Each assertion is shown passing on the right page and failing on a wrong one, so a page object that asserts nothing
 * cannot hide behind a green spec. What no offline test can show is that the REAL front end renders this markup: that is the
 * first live run's job (the report says so).
 */
import { Browser, BrowserContext, expect, Page, Route, test } from '@playwright/test';
import { ImportWizardPage } from '../../pages/ImportWizardPage';
import { authorityCandidates, chooseAuthorityWithRequiredAttribute, RaProfileCreatePage, requiredRaProfileAttributes } from '../../pages/RaProfileCreatePage';
import {
    BrowserGuards, classify, ignorableConsole, isUnexpectedWrite, isWriteMethod, listShapeProblems, matchAllowed, scanForErrorText,
} from '../../utils/regression/browserGuards';
import { randomBytes } from 'node:crypto';
// Run-scoped generated test passwords (merge follow-up 2026-10-15): no password-like literal in the file.
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

// ------------------------------------------------------------------ ImportWizardPage

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

test('ImportWizardPage: open, choose a refused file, read the alert / disabled button / password field, retry with a password', async ({ browser }) => {
    const served = newServed(IMPORT_APP, { inspection: { status: 422, body: ['A PEM file can hold at most one private key.'] } });
    const { context, page } = await serve(browser, served);
    try {
        const wizard = new ImportWizardPage(page);
        await wizard.open();
        await expect(wizard.dialog).toBeVisible();
        const answer = await wizard.chooseFile({ name: 'two-keys.pem', mimeType: 'application/x-pem-file', buffer: Buffer.from('hello') });
        expect(answer.status()).toBe(422);
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
        expect(again.status()).toBe(422);
        expect(served.inspections[1]).toEqual({ file: Buffer.from('hello').toString('base64'), passphrase: GEN_PW_1 });
        await wizard.assertRefused('Failed to read the uploaded file (422): A PEM file can hold at most one private key.');
        await wizard.cancel();
    } finally {
        await context.close();
    }
});

test('ImportWizardPage: a 200 lists the entries; a signing request is disabled with its reason; the alert and the password field are absent', async ({ browser }) => {
    const served = newServed(IMPORT_APP, { inspection: { status: 200, body: { containerDigest: 'x', entries: [CSR_ENTRY] } } });
    const { context, page } = await serve(browser, served);
    try {
        const wizard = new ImportWizardPage(page);
        await wizard.open();
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
        expect(imported.status()).toBe(200);
        await wizard.assertResults(['Imported']);
        expect(await failsFast(wizard.assertResults(['Already in inventory']))).toBe(true);
        await wizard.done();
    } finally {
        await context.close();
    }
});

// ------------------------------------------------------------------ RaProfileCreatePage

const RA_APP = (kind: 'input' | 'select') => `<!doctype html><html><body>
<main><button data-testid="plus-button" id="plus">+</button></main>
<div id="dlg" role="dialog" aria-label="Create RA Profile" hidden>
  <input data-testid="text-input-name" id="name" readonly onfocus="this.readOnly=false">
  <div data-testid="select-authoritySelect"><label>Select Authority</label><button type="button" aria-haspopup="listbox" data-testid="select-authoritySelect-trigger" id="auth">Select to change RA Profile if needed</button></div>
  <div id="listbox" role="listbox" hidden><div role="option" id="opt1">authority-one</div></div>
  <div role="tablist"><button role="tab" id="tab" disabled>Connector Attributes</button></div>
  <div id="attrs"></div>
  <div id="toast"></div>
  <button type="button" id="cancel">Cancel</button>
  <button data-testid="progress-button" id="create" disabled>Create</button>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  $('plus').onclick = () => { $('dlg').hidden = false; };
  $('cancel').onclick = () => { $('dlg').hidden = true; };
  $('auth').onclick = () => { $('listbox').hidden = false; };
  $('opt1').onclick = () => {
    $('auth').textContent = 'authority-one'; $('listbox').hidden = true; $('tab').disabled = false;
    ${kind === 'input'
        ? `$('attrs').innerHTML = '<label for="__attributes__ra-profile__.tpl">Certificate Template <span class="text-danger"> *</span></label><input id="__attributes__ra-profile__.tpl" data-testid="text-input-__attributes__ra-profile__.tpl"><div id="err"></div>'; $('__attributes__ra-profile__.tpl').onblur = () => { $('err').innerHTML = '<div class="text-danger">Required Field</div>'; };`
        : `$('attrs').innerHTML = '<label for="__attributes__ra-profile__.tplSelect">Certificate Template <span class="text-danger"> *</span></label><div data-testid="select-__attributes__ra-profile__.tplSelect"><button type="button" aria-haspopup="listbox" data-testid="select-__attributes__ra-profile__.tplSelect-trigger" id="__attributes__ra-profile__.tplSelect">Select Certificate Template</button></div>';`}
  };
  $('create').onclick = async () => {
    const res = await fetch('/api/v1/authorities/22222222-2222-4222-8222-222222222222/raProfiles', { method: 'POST', body: '{}' });
    const body = await res.json();
    $('toast').innerHTML = '<div data-testid="alert-1" role="alert">Failed to create RA profile (' + res.status + '): ' + body.join(' ') + '</div>';
  };
</script></body></html>`;

test('RaProfileCreatePage: an input attribute left empty shows "Required Field" after the blur, Create stays disabled, no request leaves', async ({ browser }) => {
    const served = newServed(RA_APP('input'));
    const { context, page } = await serve(browser, served);
    try {
        const form = new RaProfileCreatePage(page);
        await form.open();
        await form.fillName('qa-reg-form-val-ui-x');
        await form.chooseAuthority('authority-one');
        const required = await form.requiredFields();
        expect(required).toEqual([{ label: 'Certificate Template', field: '__attributes__ra-profile__.tpl' }]);
        await form.assertNoRequiredFieldMessage();
        expect(await failsFast(form.assertRequiredAttributeError('Certificate Template'))).toBe(true);
        expect(await form.leaveEmpty(required[0].field)).toBe('input');
        await form.assertCreateBlocked();
        expect(await form.assertRequiredAttributeError('Certificate Template')).toBe('field');
        expect(await form.submitIfEnabled()).toEqual({ sent: false });
        expect(served.raProfiles).toEqual([]);
        await form.cancel();
    } finally {
        await context.close();
    }
});

test('RaProfileCreatePage: a Select attribute shows no text before a submit; when the form lets the request through the 422 toast is the message and the response is handed back', async ({ browser }) => {
    const served = newServed(RA_APP('select'));
    const { context, page } = await serve(browser, served);
    try {
        const form = new RaProfileCreatePage(page);
        await form.open();
        await form.fillName('qa-reg-form-val-ui-y');
        await form.chooseAuthority('authority-one');
        const [field] = await form.requiredFields();
        expect(await form.leaveEmpty(field.field)).toBe('select');
        await form.assertCreateBlocked();
        expect(await failsFast(form.assertRequiredAttributeError('Certificate Template'))).toBe(true);
        // An enabled Create (a form that does not block): clicked, the answer returned, the toast is the validation message.
        await page.locator('#create').evaluate((el: HTMLButtonElement) => { el.disabled = false; });
        const outcome = await form.submitIfEnabled();
        expect(outcome.sent).toBe(true);
        if (outcome.sent) expect(outcome.response.status()).toBe(422);
        expect(await form.assertRequiredAttributeError('Certificate Template')).toBe('toast');
        await form.assertRefusalShown(['Required attribute Certificate Template not found.']);
        expect(await Promise.all([failsFast(form.assertRequiredAttributeError('Another Label')), failsFast(form.assertRefusalShown(['some other message']))])).toEqual([true, true]);
        expect(served.raProfiles).toHaveLength(1);
    } finally {
        await context.close();
    }
});

test('RA-profile helpers (pure): required attributes of a schema, the authority order, the lazy choice', async () => {
    const schema = [
        { type: 'data', name: 'a', contentType: 'string', properties: { label: 'A', required: true, readOnly: false, visible: true } },
        { type: 'data', name: 'b', contentType: 'object', properties: { label: 'B', required: true, list: true } },
        { type: 'data', name: 'c', contentType: 'string', properties: { label: 'C', required: false } },
        { type: 'data', name: 'd', contentType: 'string', properties: { label: 'D', required: true, readOnly: true } },
        { type: 'data', name: 'e', contentType: 'string', properties: { label: 'E', required: true, visible: false } },
        { type: 'info', name: 'f', contentType: 'string', properties: { label: 'F', required: true } },
        { type: 'data', name: 'g', contentType: 'string', properties: { required: true }, attributeCallback: { callbackMethod: 'x' } },
    ];
    expect(requiredRaProfileAttributes(schema)).toEqual([
        { name: 'a', label: 'A', contentType: 'string', select: false },
        { name: 'b', label: 'B', contentType: 'object', select: true },
        { name: 'g', label: 'g', contentType: 'string', select: true },
    ]);
    expect(requiredRaProfileAttributes(undefined)).toEqual([]);

    const authorities = [
        { uuid: 'u1', name: 'one', status: 'connected' },
        { uuid: 'u2', name: 'two', status: 'disconnected' },
        { uuid: 'u3', name: 'three', status: 'connected' },
        { uuid: 'u4', name: 'own', status: 'connected' },
    ];
    expect(authorityCandidates(authorities).map((a) => a.uuid)).toEqual(['u1', 'u3', 'u4']);
    expect(authorityCandidates(authorities, 'u4').map((a) => a.uuid), 'the run\'s own first').toEqual(['u4', 'u1', 'u3']);
    expect(authorityCandidates(authorities, 'u2').map((a) => a.uuid), 'an own authority that is not connected is still tried first').toEqual(['u2', 'u1', 'u3', 'u4']);
    const asked: string[] = [];
    const schemas: Record<string, unknown[] | undefined> = { u1: [], u3: schema, u4: schema };
    const choice = await chooseAuthorityWithRequiredAttribute(authorities, async (uuid) => { asked.push(uuid); return schemas[uuid] as never; });
    expect(choice).toMatchObject({ uuid: 'u3', name: 'three' });
    expect(asked, 'schemas are read lazily, one at a time, never a disconnected authority\'s').toEqual(['u1', 'u3']);
    expect(await chooseAuthorityWithRequiredAttribute(authorities, async () => undefined)).toBeUndefined();
});

// ------------------------------------------------------------------ BrowserGuards

test('browserGuards (pure): classification, the allow-list, the console noise, write detection, the error texts, the list shapes', () => {
    const allow = [{ method: 'GET', path: /\/v1\/branding$/, status: 404, expected: 'x', reason: 'y' }, { path: /\/v1\/things$/, status: [403, 404], bug: 'core#1', reason: 'z' }];
    expect(classify(200, 'GET', '/api/v1/x', allow)).toBeUndefined();
    expect(classify(500, 'GET', '/api/v1/branding', allow), 'a 5xx is never allowed').toBe('server');
    expect(classify(503, 'POST', '/api/v1/x', allow)).toBe('server');
    expect(classify(404, 'GET', '/api/v1/branding', allow)).toBeUndefined();
    expect(classify(404, 'POST', '/api/v1/branding', allow), 'the method matters').toBe('client');
    expect(classify(401, 'GET', '/api/v1/branding', allow), 'the status matters').toBe('client');
    expect(classify(403, 'PUT', '/api/v1/things', allow)).toBeUndefined();
    expect(classify(422, 'POST', '/api/v1/things', allow)).toBe('client');
    expect(matchAllowed(allow, 'get', '/api/v1/branding', 404)).toBe(allow[0]);
    expect(ignorableConsole('Failed to load resource: the server responded with a status of 404 (Not Found)')).toBe(true);
    expect(ignorableConsole('TypeError: x is not a function')).toBe(false);
    expect(ignorableConsole('boom', [/boom/])).toBe(true);
    expect(isWriteMethod('patch')).toBe(true);
    expect(isWriteMethod('GET')).toBe(false);
    const reads = [/\/v1\/certificates$/];
    expect(isUnexpectedWrite('POST', '/api/v1/certificates', reads)).toBe(false);
    expect(isUnexpectedWrite('POST', '/api/v1/certificates/upload', reads)).toBe(true);
    expect(isUnexpectedWrite('DELETE', '/api/v1/certificates', reads)).toBe(true);
    expect(isUnexpectedWrite('GET', '/api/v1/certificates', reads)).toBe(false);
    expect(scanForErrorText('All fine')).toEqual([]);
    expect(scanForErrorText('An UNEXPECTED ERROR occurred. Internal Server Error')).toEqual(['unexpected error', 'internal server error']);
    expect(scanForErrorText('value: undefined')).toEqual(['undefined']);
    expect(scanForErrorText('Undefined behaviour is fine, undefinedX too')).toEqual([]);
    expect(scanForErrorText('clean chrome', 'table says internal server error and undefined')).toEqual(['undefined']);
    expect(listShapeProblems('bare', [])).toEqual([]);
    expect(listShapeProblems('bare', {})).toEqual(['not a bare array']);
    expect(listShapeProblems('single', { a: 1 })).toEqual([]);
    expect(listShapeProblems('single', [])).toEqual(['not a single object']);
    expect(listShapeProblems('paged', { items: [1, 2], itemsPerPage: 10, pageNumber: 1, totalPages: 1, totalItems: 2 })).toEqual([]);
    expect(listShapeProblems('paged', { certificates: [], itemsPerPage: 10, pageNumber: 1, totalPages: 0, totalItems: 0 })).toEqual([]);
    expect(listShapeProblems('paged', { items: [], other: [], itemsPerPage: 10, pageNumber: 1, totalPages: 0, totalItems: 0 })).toEqual(['2 array members (exactly one list of rows expected)']);
    expect(listShapeProblems('paged', { items: [1, 2, 3], itemsPerPage: 2, pageNumber: 1, totalPages: 2, totalItems: 3 })).toEqual(['3 rows on a page of 2']);
    expect(listShapeProblems('paged', { items: [1, 2], itemsPerPage: 10, pageNumber: 1, totalPages: 1, totalItems: 1 })).toEqual(['2 rows but totalItems 1']);
    expect(listShapeProblems('paged', { items: [], itemsPerPage: '10' })).toEqual(['itemsPerPage is not a number', 'pageNumber is not a number', 'totalPages is not a number', 'totalItems is not a number']);
    expect(listShapeProblems('paged', [])).toEqual(['not an object']);
});

const GUARD_APP = `<!doctype html><html><body><main><h1>Page</h1><div id="out"></div>
<table><tbody><tr><td>Internal server error. (a log line in a table)</td></tr></tbody></table></main>
<script>
  const call = (method, path) => fetch(path, { method }).catch(() => {});
  window.run = async (what) => {
    if (what === 'ok') await call('GET', '/api/v1/ok');
    if (what === 'branding') await call('GET', '/api/v1/branding');
    if (what === 'client') await call('GET', '/api/v1/missing');
    if (what === 'server') await call('GET', '/api/v1/boom');
    if (what === 'write') { await call('PATCH', '/api/v1/things/1'); await call('POST', '/api/v1/certificates/upload'); await call('POST', '/api/v1/certificates'); }
    if (what === 'console') console.error('qa: something broke');
    if (what === 'pageerror') setTimeout(() => { throw new Error('qa: uncaught'); }, 0);
    if (what === 'text') document.getElementById('out').textContent = 'An unexpected error occurred. total: undefined';
    if (what === 'external') await fetch('http://example.invalid/x').catch(() => {});
  };
</script></body></html>`;

test('BrowserGuards counts console errors, page errors, 5xx, unexpected 4xx, writes and error text per label; allowed 4xx and table text are not findings', async ({ browser }) => {
    const served = newServed(GUARD_APP, {
        extra: (path) => (path === '/api/v1/ok' ? { status: 200 } : path === '/api/v1/branding' ? { status: 404 } : path === '/api/v1/boom' ? { status: 500 } : path === '/api/v1/certificates' ? { status: 200 } : path.startsWith('/api/v1/things') ? { status: 204 } : path === '/api/v1/certificates/upload' ? { status: 201 } : undefined),
    });
    const { context, page } = await serve(browser, served);
    try {
        await page.goto(BASE);
        const guards = new BrowserGuards(page, {
            allow: [{ method: 'GET', path: /\/v1\/branding$/, status: 404, expected: 'unbranded tier', reason: 'by design' }],
            readPosts: [/\/v1\/certificates$/],
        }).start();
        const run = async (label: string, what: string) => {
            guards.mark(label);
            await page.evaluate((w) => (window as unknown as { run(x: string): Promise<void> }).run(w), what);
            await guards.settle(2_000);
        };
        await run('clean', 'ok');
        await run('allowed', 'branding');
        await run('client', 'client');
        await run('server', 'server');
        await run('write', 'write');
        await run('console', 'console');
        await run('pageerror', 'pageerror');
        await run('external', 'external');
        guards.mark('text');
        await page.evaluate(() => (window as unknown as { run(x: string): Promise<void> }).run('text'));
        expect(await guards.scanText()).toEqual(['unexpected error', 'undefined']);

        expect(guards.counts('clean')).toMatchObject({ console: 0, pageerror: 0, server: 0, client: 0, failed: 0, text: 0, write: 0 });
        expect(guards.counts('allowed'), 'the allow-listed 404 is no finding (and its console line is the browser\'s own noise)').toMatchObject({ client: 0, console: 0 });
        expect(guards.all({ label: 'client' }).map((f) => f.text)).toEqual(['GET /api/v1/missing answered 404']);
        expect(guards.all({ label: 'server' }).map((f) => f.text)).toEqual(['GET /api/v1/boom answered 500']);
        expect(guards.all({ label: 'write', counter: 'write' }).map((f) => f.text)).toEqual(['PATCH /api/v1/things/1', 'POST /api/v1/certificates/upload']);
        expect(guards.all({ label: 'console' }).map((f) => `${f.counter}: ${f.text}`)).toEqual(['console: qa: something broke']);
        expect(guards.all({ label: 'pageerror' }).map((f) => f.counter)).toEqual(['pageerror']);
        expect(guards.all({ label: 'external' }), 'a request to another origin is not a finding of the page').toEqual([]);
        expect(guards.all({ label: 'text' }).map((f) => f.text)).toEqual(['visible text "unexpected error"', 'visible text "undefined"']);
        expect(guards.allowedSeen()).toHaveLength(1);
        // The table's "Internal server error." line is data, not chrome: no finding under 'clean' for it.
        guards.mark('clean2');
        await page.evaluate(() => { document.getElementById('out')!.textContent = ''; });
        expect(await guards.scanText()).toEqual([]);
        // assertZero names every finding of a label, and passes for a clean one.
        guards.assertZero('clean');
        expect(await failsFast(Promise.resolve().then(() => guards.assertZero('client')))).toBe(true);
        expect(await failsFast(Promise.resolve().then(() => guards.assertZero()))).toBe(true);
        guards.dispose();
        const before = guards.all().length;
        await page.evaluate(() => (window as unknown as { run(x: string): Promise<void> }).run('client'));
        await page.evaluate(() => (window as unknown as { run(x: string): Promise<void> }).run('console'));
        expect(guards.all().length, 'disposed: nothing more is counted').toBe(before);
    } finally {
        await context.close();
    }
});
