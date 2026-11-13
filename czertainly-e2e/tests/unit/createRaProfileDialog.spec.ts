/**
 * Offline checks of pages/CreateRaProfileDialog.ts against a static document shaped like the admin UI RA-profile form.
 */
import { Browser, BrowserContext, expect, Page, test } from '@playwright/test';
import { RaProfilePage } from '../../pages/RaProfilePage';

test.describe.configure({ timeout: 60_000 });

const BASE = 'http://127.0.0.1:9/';
const NEW_UUID = '11111111-1111-4111-8111-111111111111';

async function serve(browser: Browser, html: string): Promise<{ context: BrowserContext; page: Page; creates: unknown[] }> {
    const creates: unknown[] = [];
    const context = await browser.newContext({ baseURL: BASE });
    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (/\/api\/v1\/authorities\/[^/]+\/raProfiles$/.test(url.pathname) && route.request().method() === 'POST') {
            creates.push(JSON.parse(route.request().postData() ?? '{}'));
            return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ uuid: NEW_UUID }) });
        }
        if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"no"}' });
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    });
    return { context, page: await context.newPage(), creates };
}

const RA_APP = `<!doctype html><html><body>
<main><button data-testid="plus-button" id="plus">+</button></main>
<div id="dlg" role="dialog" aria-label="Create RA Profile" hidden>
  <input data-testid="text-input-name" id="name" readonly onfocus="this.readOnly=false">
  <div data-testid="select-authoritySelect"><label>Select Authority</label><button type="button" aria-haspopup="listbox" data-testid="select-authoritySelect-trigger" id="auth">Select to change RA Profile if needed</button></div>
  <div id="listbox" role="listbox" hidden><div role="option" id="opt1">authority-one</div></div>
  <div role="tablist"><button role="tab" id="tab" disabled>Connector Attributes</button></div>
  <button data-testid="progress-button" id="create">Create</button>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  $('plus').onclick = () => { $('dlg').hidden = false; };
  $('auth').onclick = () => { $('listbox').hidden = false; };
  $('opt1').onclick = () => { $('auth').textContent = 'authority-one'; $('listbox').hidden = true; $('tab').disabled = false; };
  $('create').onclick = () => fetch('/api/v1/authorities/22222222-2222-4222-8222-222222222222/raProfiles', { method: 'POST', body: '{}' });
</script></body></html>`;

test('CreateRaProfileDialog: the list "+" opens it; the name and the authority are filled; submitCreate returns the create answer and no redirect is waited for', async ({ browser }) => {
    const { context, page, creates } = await serve(browser, RA_APP);
    try {
        const list = new RaProfilePage(page);
        await list.goToList();
        const form = await list.openCreateDialog();
        await form.fillName('qa-reg-ra-x');
        await expect(form.nameInput).toHaveValue('qa-reg-ra-x');
        await form.chooseAuthority('authority-one');
        await expect(form.authorityTrigger).toHaveText('authority-one');
        const answer = await form.submitCreate();
        expect(answer).toMatchObject({ status: 201, uuid: NEW_UUID });
        expect(creates).toHaveLength(1);
        await expect(form.dialog, 'the stand-in never redirects: submitCreate returned without waiting for it').toBeVisible();
    } finally {
        await context.close();
    }
});
