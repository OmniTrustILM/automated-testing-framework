/**
 * acmeAccountPage — offline checks of pages/AcmeAccountPage.ts on a stand-in of the ACME accounts list that pages by 10
 * and searches client-side: the account is found by its id (also when it sorts onto page 2) under the right ACME
 * profile, and a row whose id only contains the searched id does not count.
 */
import { expect, test } from '@playwright/test';
import { AcmeAccountPage } from '../../pages/AcmeAccountPage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

/**
 * The ACME accounts list as CustomTable renders it: the Search box filters the rows' text client-side and the table
 * pages by 10, so only the first 10 matching rows are in the DOM (without the search, an account on page 2 is absent).
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
    await expect(accounts.list.root.locator('tbody tr'), 'the run account is on page 2: not in the DOM without a search').toHaveCount(10);
    await accounts.assertListed('AcctFake0002', 'qa-reg-x-acme');
    await expect(accounts.list.root.getByRole('textbox', { name: 'Search' }), 'the search box is cleared afterwards').toHaveValue('');
    await expect(accounts.list.root.locator('tbody tr')).toHaveCount(10);
    expect(await failsFast(accounts.assertListed('AcctFake0002', 'other-acme-profile'))).toBe(true);
    expect(await failsFast(accounts.assertListed('AcctFake0003', 'qa-reg-x-acme'))).toBe(true);
    // A row whose id merely contains the searched id is not the account (exact link name).
    await page.setContent(acmeAccountsList([...pageOne, ['AcctFake0002x', 'qa-reg-x-acme']]));
    expect(await failsFast(accounts.assertListed('AcctFake0002', 'qa-reg-x-acme'))).toBe(true);
});
