/**
 * Platform area — offline checks of the TokenPage and KeyPage assertions against static fixtures shaped like
 * fe-administrator origin/main (Widget = `<section>` with an `<h5>` title; CustomTable rows `tr[data-id]`; the key-level
 * toolbar inside the `Key Details` widget and the item-level toolbar inside the LAST `tab-layout`, both with the same
 * button ids; `key-item-actions` when the R2 hook lands). Each assertion is shown passing on the right page and failing
 * on a wrong one (b1Pages style, Sonnet review F10).
 */
import { expect, Page, test } from '@playwright/test';
import { KeyPage } from '../../pages/KeyPage';
import { TokenPage } from '../../pages/TokenPage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

const button = (id: string, disabled: boolean) => `<button data-testid="${id}-button" ${disabled ? 'disabled' : ''}>${id}</button>`;

/** A key detail: key-level toolbar in Key Details; the shown item inside the last tab-layout. */
function keyDetail(opts: { keyDisabled: string[]; itemDisabled: string[]; state: string; enabled: boolean; hook?: boolean; algorithm?: string }): string {
    const keyIds = ['pencil', 'trash', 'check', 'times', 'compromise', 'destroy'];
    const itemIds = ['delete', 'enable', 'disable', 'key', 'compromise', 'destroy', 'sign', 'verify'];
    const toolbar = itemIds.map((id) => button(id, opts.itemDisabled.includes(id))).join('');
    return `<main>
      <section><div><h5>Key Details</h5>${keyIds.map((id) => button(id, opts.keyDisabled.includes(id))).join('')}</div>
        <table><tbody><tr data-id="name"><td>Name</td><td>k</td></tr></tbody></table></section>
      <div data-testid="tab-layout"><div role="tablist"><button role="tab" aria-selected="true">Private key</button><button role="tab">Public key</button></div>
        <div data-testid="tab-layout">
          ${opts.hook ? `<div data-testid="key-item-actions">${toolbar}</div>` : `<div class="flex justify-end">${toolbar}</div>`}
          <table><tbody>
            <tr data-id="keyAlgorithm"><td>Key Algorithm</td><td>${opts.algorithm ?? 'RSA'}</td></tr>
            <tr data-id="Usages"><td>Key Usages</td><td><span>sign</span><span>decrypt</span></td></tr>
            <tr data-id="enabled"><td>Enabled</td><td><span>${opts.enabled ? 'Enabled' : 'Disabled'}</span></td></tr>
            <tr data-id="state"><td>State</td><td><span>${opts.state}</span></td></tr>
          </tbody></table>
        </div>
      </div></main>`;
}

test('KeyPage: key-level and item-level buttons are separate scopes (same ids); assertKeyButtons / assertItemButtons pass on the right state and fail on the wrong one', async ({ page }) => {
    const keys = new KeyPage(page);
    await page.setContent(keyDetail({ keyDisabled: ['times'], itemDisabled: ['disable', 'sign', 'verify', 'destroy'], state: 'Active', enabled: false }));
    await keys.assertKeyButtons({ enable: 'enabled', disable: 'disabled', compromise: 'enabled' });
    await keys.assertItemButtons({ sign: 'disabled', verify: 'disabled', compromise: 'enabled', destroy: 'disabled', enable: 'enabled' });
    // The key-level compromise is enabled while the item-level one is disabled: the scopes must not bleed into each other.
    await page.setContent(keyDetail({ keyDisabled: [], itemDisabled: ['compromise'], state: 'Active', enabled: true }));
    await keys.assertKeyButtons({ compromise: 'enabled' });
    await keys.assertItemButtons({ compromise: 'disabled' });
    expect(await failsFast(keys.assertItemButtons({ compromise: 'enabled' }))).toBe(true);
    expect(await failsFast(keys.assertKeyButtons({ compromise: 'disabled' }))).toBe(true);
    expect(await failsFast(keys.assertItemButtons({ export: 'enabled' }))).toBe(true);
    await keys.assertItemButtons({ export: 'absent' });
    // The R2 hook wins over the tab-layout fallback.
    await page.setContent(keyDetail({ keyDisabled: [], itemDisabled: ['sign'], state: 'Active', enabled: true, hook: true }));
    await keys.assertItemButtons({ sign: 'disabled' });
    expect(keys.itemButton('sign')).toBeTruthy();
});

test('KeyPage: item state / enabled / algorithm / usages rows; wrong values fail', async ({ page }) => {
    const keys = new KeyPage(page);
    await page.setContent(keyDetail({ keyDisabled: [], itemDisabled: [], state: 'Destroyed Compromised', enabled: false, algorithm: 'ECDSA' }));
    await keys.assertItemState(/Destroyed.*Compromised/i);
    await keys.assertItemEnabled(false);
    await keys.assertItemAlgorithm(/ECDSA/);
    expect(await keys.itemUsages()).toEqual(['sign', 'decrypt']);
    expect(await failsFast(keys.assertItemState(/^\s*Active\s*$/))).toBe(true);
    expect(await failsFast(keys.assertItemEnabled(true))).toBe(true);
    expect(await failsFast(keys.assertItemAlgorithm(/RSA/))).toBe(true);
});

/** A token detail with its status row and the toolbar of E1. */
function tokenDetail(status: string, disabled: string[]): string {
    const ids = ['pencil', 'trash', 'reload', 'refresh', 'check', 'times', 'random'];
    return `<main><section><div><h5>Token Details</h5>${ids.map((id) => button(id, disabled.includes(id))).join('')}</div>
      <table><tbody><tr data-id="name"><td>Name</td><td>t</td></tr><tr data-id="status"><td>Status</td><td><span class="badge">${status}</span></td></tr></tbody></table></section>
      <section><div><h5>Token Attributes</h5>${button('pencil', false)}</div></section></main>`;
}

test('TokenPage: the status badge is read from the status row; assertButtons judges the Token Details toolbar only; a v1 word or an enabled Activate fails', async ({ page }) => {
    const tokens = new TokenPage(page);
    await page.setContent(tokenDetail('Connected', ['refresh', 'check', 'times', 'random']));
    expect(await tokens.statusBadge()).toBe('Connected');
    await tokens.assertStatusBadge(['Connected', 'Disconnected', 'Warning', 'Unknown']);
    await tokens.assertButtons({ sync: 'disabled', activate: 'disabled', deactivate: 'disabled', random: 'disabled', edit: 'enabled', delete: 'enabled', reload: 'enabled' });
    await page.setContent(tokenDetail('Activated', ['check']));
    expect(await failsFast(tokens.assertStatusBadge(['Connected', 'Disconnected', 'Warning', 'Unknown']))).toBe(true);
    expect(await failsFast(tokens.assertButtons({ sync: 'disabled' }))).toBe(true);
    await tokens.assertButtons({ activate: 'disabled', sync: 'enabled' });
});

test('TokenPage: the profile Enabled row; the Create Key form\'s profile options are read from the open listbox and the listbox is closed again', async ({ page }) => {
    const tokens = new TokenPage(page);
    await page.setContent(`<main><section><div><h5>Token Profile Details</h5>${button('check', false)}${button('times', true)}</div>
      <table><tbody><tr data-id="enabled"><td>Enabled</td><td><span>Disabled</span></td></tr></tbody></table></section></main>`);
    await tokens.assertProfileEnabled(false);
    expect(await failsFast(tokens.assertProfileEnabled(true))).toBe(true);
    await expect(tokens.profileButton('enable')).toBeEnabled();
    await expect(tokens.profileButton('disable')).toBeDisabled();

    const keys = new KeyPage(page);
    await page.setContent(`<div role="dialog"><input data-testid="text-input-name"/>
      <button data-testid="select-tokenProfileSelect-trigger" aria-haspopup="listbox" onclick="document.getElementById('lb').style.display='block'">Select Token Profile</button>
      <div id="lb" role="listbox" style="display:none"><div role="option">qa-reg-x-tp-on</div><div role="option">other-profile</div></div></div>
      <script>document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') document.getElementById('lb').style.display='none'; });</script>`);
    expect(await keys.tokenProfileOptions()).toEqual(['qa-reg-x-tp-on', 'other-profile']);
    await expect(page.getByRole('listbox')).toBeHidden();
});

void ((_: Page) => undefined);
