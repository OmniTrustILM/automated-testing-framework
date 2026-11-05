/**
 * acmeAccountPage — offline checks of pages/AcmeAccountPage.ts on a stand-in of the ACME accounts list that pages by 10
 * and searches client-side.
 */
import { expect, test } from '@playwright/test';
import { AcmeAccountPage } from '../../pages/AcmeAccountPage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

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

test('AcmeAccountPage: searchById then assertListed finds the row of the account id under the ACME profile name; a page without it, or with it under another profile, fails', async ({ page }) => {
    test.setTimeout(60_000);
    const accounts = new AcmeAccountPage(page);
    const listed = async (id: string, profile: string): Promise<void> => {
        await accounts.searchById(id);
        await accounts.assertListed(id, profile);
    };
    await page.setContent(acmeAccountsList([...pageOne, ['AcctFake0002', 'qa-reg-x-acme']]));
    await expect(accounts.acmeAccountsList.locator('tbody tr'), 'the run account is on page 2: not in the DOM without a search').toHaveCount(10);
    await listed('AcctFake0002', 'qa-reg-x-acme');
    await accounts.clearSearch();
    await expect(accounts.searchInput, 'the search box is cleared by clearSearch').toHaveValue('');
    await expect(accounts.acmeAccountsList.locator('tbody tr')).toHaveCount(10);
    // assertListed alone never types: without a search the account on page 2 is not there.
    expect(await failsFast(accounts.assertListed('AcctFake0002', 'qa-reg-x-acme'))).toBe(true);
    expect(await failsFast(listed('AcctFake0002', 'other-acme-profile'))).toBe(true);
    expect(await failsFast(listed('AcctFake0003', 'qa-reg-x-acme'))).toBe(true);
    // A row whose id merely contains the searched id is not the account (exact link name).
    await page.setContent(acmeAccountsList([...pageOne, ['AcctFake0002x', 'qa-reg-x-acme']]));
    expect(await failsFast(listed('AcctFake0002', 'qa-reg-x-acme'))).toBe(true);
});
