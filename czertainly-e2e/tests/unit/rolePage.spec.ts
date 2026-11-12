/**
 * rolePage — offline checks of pages/RolePage.ts against a served stand-in roles list (every request of a
 * loopback-addressed context is answered by the test, nothing leaves the browser): a role counts as not listed only after
 * the list showed its rows, and the list is read fresh each time.
 */
import { expect, test } from '@playwright/test';
import { RolePage } from '../../pages/RolePage';
import { listPage, withServedPage } from './helpers/fakeListPage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

// The rows-loaded wait is the page object's own (`loadTimeout`), so the "never loads" case needs 2 s here, not 30 s.
test('RolePage.assertNotListed after reloadList: absent once rows show; present or never-loaded fails; reread each time', async ({ browser }) => {
    await withServedPage(browser, listPage('List of Roles', 'roles', ['Administrators', 'Auditors']), async (page, serve) => {
        const rolePage = new RolePage(page);
        await rolePage.reloadList();
        await rolePage.assertNotListed('qa-reg-x-role-delete');
        // The same hash route again: the document the "server" answers NOW must be the one that is judged (a same-hash goto
        // is no navigation, so without the reload the first render would stay).
        serve(listPage('List of Roles', 'roles', ['Administrators', 'qa-reg-x-role-delete']));
        await rolePage.reloadList();
        expect(await failsFast(rolePage.assertNotListed('qa-reg-x-role-delete'))).toBe(true);
        serve(listPage('List of Roles', 'roles', [], false));
        await rolePage.reloadList();
        expect(await failsFast(rolePage.assertNotListed('qa-reg-x-role-delete', { loadTimeout: 2_000 })), 'an unloaded list is no proof of absence').toBe(true);
    });
});
