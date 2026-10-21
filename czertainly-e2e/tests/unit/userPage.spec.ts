/**
 * userPage — offline checks of pages/UserPage.ts: absence from the users list (after the list showed rows, read fresh
 * even when coming from another list page) on a served stand-in, and the detail's Roles row read as a set.
 */
import { expect, test } from '@playwright/test';
import { RolePage } from '../../pages/RolePage';
import { UserPage } from '../../pages/UserPage';
import { listPage, withServedPage } from './helpers/fakeListPage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

test('UserPage.assertNotListed after reloadList: absent once rows show; from another list page the users list is judged', async ({ browser }) => {
    await withServedPage(browser, listPage('List of Roles', 'roles', ['Administrators', 'Auditors']), async (page, serve) => {
        // The page starts on the roles list (another hash route of the same document): the users list must still be read.
        await new RolePage(page).goToList();
        serve(listPage('List of Users', 'users', ['admin', 'operator']));
        const userPage = new UserPage(page);
        await userPage.reloadList();
        await userPage.assertNotListed('qa-reg-x-user-delete');
        serve(listPage('List of Users', 'users', ['operator', 'qa-reg-x-user-delete']));
        await userPage.reloadList();
        expect(await failsFast(userPage.assertNotListed('qa-reg-x-user-delete'))).toBe(true);
        serve(listPage('List of Users', 'users', [], false));
        await userPage.reloadList();
        expect(await failsFast(userPage.assertNotListed('qa-reg-x-user-delete', { loadTimeout: 2_000 })), 'an unloaded list is no proof of absence').toBe(true);
    });
});

test('UserPage.assertRoles reads the detail\'s Roles row as a set', async ({ page }) => {
    const user = new UserPage(page);
    await page.setContent(`<main><section><div><h5>User Details</h5></div><table><tbody>
      <tr data-id="roles"><td>Roles</td><td>qa-reg-x-role-b, qa-reg-x-role-a</td></tr></tbody></table></section></main>`);
    await user.assertRoles(['qa-reg-x-role-a', 'qa-reg-x-role-b']);
    expect(await failsFast(user.assertRoles(['qa-reg-x-role-a']))).toBe(true);
});
