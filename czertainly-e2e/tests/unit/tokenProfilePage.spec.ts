/**
 * tokenProfilePage — TokenProfilePage against a static profile detail shaped like the admin UI: the `Enabled` row and
 * the toolbar buttons; plus the Create Key form's profile select, whose options are read from the open listbox and
 * which is closed again.
 */
import { expect, test } from '@playwright/test';
import { KeyPage } from '../../pages/KeyPage';
import { TokenProfilePage } from '../../pages/TokenProfilePage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

const button = (id: string, disabled: boolean) => `<button data-testid="${id}-button" ${disabled ? 'disabled' : ''}>${id}</button>`;

test('TokenProfilePage: the profile Enabled row; the Create Key form\'s profile options are read from the open listbox and the listbox is closed again', async ({ page }) => {
    const profiles = new TokenProfilePage(page);
    await page.setContent(`<main><section><div><h5>Token Profile Details</h5>${button('check', false)}${button('times', true)}</div>
      <table><tbody><tr data-id="enabled"><td>Enabled</td><td><span>Disabled</span></td></tr></tbody></table></section></main>`);
    await profiles.assertProfileEnabled(false);
    expect(await failsFast(profiles.assertProfileEnabled(true))).toBe(true);
    await expect(profiles.profileButton('enable')).toBeEnabled();
    await expect(profiles.profileButton('disable')).toBeDisabled();

    const keys = new KeyPage(page);
    await page.setContent(`<div role="dialog" aria-label="Create Key"><input data-testid="text-input-name"/>
      <button data-testid="select-tokenProfileSelect-trigger" aria-haspopup="listbox" onclick="document.getElementById('lb').style.display='block'">Select Token Profile</button>
      <div id="lb" role="listbox" style="display:none"><div role="option">qa-reg-x-tp-on</div><div role="option">other-profile</div></div></div>
      <script>document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') document.getElementById('lb').style.display='none'; });</script>`);
    expect(await keys.offeredTokenProfiles()).toEqual(['qa-reg-x-tp-on', 'other-profile']);
    await expect(page.getByRole('listbox')).toBeHidden();
});
