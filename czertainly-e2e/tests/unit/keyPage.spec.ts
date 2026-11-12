/**
 * keyPage — KeyPage against static fixtures shaped like the admin UI (widgets are `<section>`s with a title, rows are
 * `tr[data-id]`): the key toolbar and the item toolbar are separate scopes with the same button ids, and each assertion
 * passes on the right page and fails on a wrong one.
 */
import { expect, test } from '@playwright/test';
import { KeyPage } from '../../pages/KeyPage';

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
    // The dedicated test-id hook wins over the tab-layout fallback.
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
    expect(await keys.readItemUsages()).toEqual(['sign', 'decrypt']);
    expect(await failsFast(keys.assertItemState(/^\s*Active\s*$/))).toBe(true);
    expect(await failsFast(keys.assertItemEnabled(true))).toBe(true);
    expect(await failsFast(keys.assertItemAlgorithm(/RSA/))).toBe(true);
});
