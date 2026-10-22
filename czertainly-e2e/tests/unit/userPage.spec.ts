/**
 * userPage — offline checks of pages/UserPage.ts: absence from the users list (after the list showed rows, read fresh
 * even when coming from another list page) on a served stand-in, and the detail's Roles row read as a set.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

/** A loopback server that answers the custom attribute definitions of users with `body` (status `status`). */
async function withDefinitions(status: number, body: unknown, run: (baseURL: string) => Promise<void>): Promise<void> {
    const server: Server = createServer((_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

const EDIT_DIALOG_WITHOUT_EDITOR = '<div role="dialog" aria-label="Edit User"><div role="tablist"><button role="tab" aria-selected="true">Properties</button><button role="tab" aria-selected="false">Custom attributes</button></div></div>';

test('UserPage.waitForCustomAttributeEditor: no definitions for users, no editor to wait for; a failed definitions read fails', async ({ browser }) => {
    await withDefinitions(200, [], async (baseURL) => {
        const context = await browser.newContext({ baseURL });
        try {
            const page = await context.newPage();
            await page.setContent(EDIT_DIALOG_WITHOUT_EDITOR);
            const started = Date.now();
            await new UserPage(page).waitForCustomAttributeEditor(page.getByRole('dialog', { name: 'Edit User' }));
            expect(Date.now() - started, 'returns without the 15 s editor wait').toBeLessThan(5_000);
        } finally {
            await context.close();
        }
    });
    await withDefinitions(500, { message: 'x' }, async (baseURL) => {
        const context = await browser.newContext({ baseURL });
        try {
            const page = await context.newPage();
            await page.setContent(EDIT_DIALOG_WITHOUT_EDITOR);
            expect(await failsFast(new UserPage(page).waitForCustomAttributeEditor(page.getByRole('dialog', { name: 'Edit User' }))), 'an unreadable definition list is no proof of "none"').toBe(true);
        } finally {
            await context.close();
        }
    });
});

test('UserPage.waitForCustomAttributeEditor: a tier whose definitions are all required renders labels only, no add-select, and is not failed', async ({ browser }) => {
    await withDefinitions(200, [{ uuid: 'u', name: 'team', contentType: 'string', properties: { required: true } }], async (baseURL) => {
        const context = await browser.newContext({ baseURL });
        try {
            const page = await context.newPage();
            await page.setContent(`<div role="dialog" aria-label="Edit User"><div role="tablist"><button role="tab" aria-selected="true">Custom attributes</button></div>
              <label for="__attributes__custom__.team">Team *</label><input id="__attributes__custom__.team" value="blue"></div>`);
            await new UserPage(page).waitForCustomAttributeEditor(page.getByRole('dialog', { name: 'Edit User' }));
        } finally {
            await context.close();
        }
    });
});

test('UserPage.waitForCustomAttributeEditor: a tier with definitions waits for the editor and for the stored required value', async ({ browser }) => {
    await withDefinitions(200, [{ uuid: 'u', name: 'team', contentType: 'string', properties: { required: true } }], async (baseURL) => {
        const context = await browser.newContext({ baseURL });
        try {
            const page = await context.newPage();
            await page.setContent(`<div role="dialog" aria-label="Edit User"><div role="tablist"><button role="tab" aria-selected="true">Custom attributes</button></div>
              <button data-testid="select-selectAddCustomAttribute-trigger">Show custom attribute</button>
              <label for="__attributes__custom__.team">Team *</label><input id="__attributes__custom__.team" value="blue"></div>`);
            await new UserPage(page).waitForCustomAttributeEditor(page.getByRole('dialog', { name: 'Edit User' }));
        } finally {
            await context.close();
        }
    });
});
