/**
 * Offline checks of pages/CreateRaProfileDialog.ts against a static document shaped like the admin UI RA-profile
 * form: a required attribute left empty blocks Create, a Select shows no text before a submit. A browser context
 * answers every request itself; nothing leaves the machine.
 */
import { Browser, BrowserContext, expect, Page, Route, test } from '@playwright/test';
import { RaProfilePage } from '../../pages/RaProfilePage';

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

// ------------------------------------------------------------------ CreateRaProfileDialog

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

test('CreateRaProfileDialog: an input attribute left empty shows "Required Field" after the blur, Create stays disabled, no request leaves', async ({ browser }) => {
    const served = newServed(RA_APP('input'));
    const { context, page } = await serve(browser, served);
    try {
        const list = new RaProfilePage(page);
        await list.goToList();
        const form = await list.openCreateDialog();
        await form.fillName('qa-reg-form-val-ui-x');
        await form.chooseAuthority('authority-one');
        const required = await form.requiredFields();
        expect(required).toEqual([{ label: 'Certificate Template', field: '__attributes__ra-profile__.tpl' }]);
        await form.assertNoRequiredFieldMessage();
        expect(await failsFast(form.assertRequiredAttributeError('Certificate Template'))).toBe(true);
        expect(await form.focusAndLeaveRequiredField(required[0].field)).toBe('input');
        await form.assertCreateDisabled();
        expect(await form.assertRequiredAttributeError('Certificate Template')).toBe('field');
        expect(await form.submitIfEnabled()).toEqual({ sent: false });
        expect(served.raProfiles).toEqual([]);
        await form.cancel();
    } finally {
        await context.close();
    }
});

test('CreateRaProfileDialog: a Select attribute shows no text before a submit; when the form lets the request through the 422 toast is the message and the response is handed back', async ({ browser }) => {
    const served = newServed(RA_APP('select'));
    const { context, page } = await serve(browser, served);
    try {
        const list = new RaProfilePage(page);
        await list.goToList();
        const form = await list.openCreateDialog();
        await form.fillName('qa-reg-form-val-ui-y');
        await form.chooseAuthority('authority-one');
        const [field] = await form.requiredFields();
        expect(await form.focusAndLeaveRequiredField(field.field)).toBe('select');
        await form.assertCreateDisabled();
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
