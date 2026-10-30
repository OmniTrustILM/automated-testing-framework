/**
 * TokenPage against a static token detail shaped like fe-administrator (Widget = `<section>` with an `<h5>` title,
 * CustomTable rows `tr[data-id]`, the toolbar icons inside the `Token Details` widget). Each assertion is shown passing
 * on the right page and failing on a wrong one.
 */
import { expect, test } from '@playwright/test';
import { TokenPage } from '../../pages/TokenPage';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

const button = (id: string, disabled: boolean) => `<button data-testid="${id}-button" ${disabled ? 'disabled' : ''}>${id}</button>`;

/** A token detail with its status row and its toolbar. */
function tokenDetail(status: string, disabled: string[]): string {
    const ids = ['pencil', 'trash', 'reload', 'refresh', 'check', 'times', 'random'];
    return `<main><section><div><h5>Token Details</h5>${ids.map((id) => button(id, disabled.includes(id))).join('')}</div>
      <table><tbody><tr data-id="name"><td>Name</td><td>t</td></tr><tr data-id="status"><td>Status</td><td><span class="badge">${status}</span></td></tr></tbody></table></section>
      <section><div><h5>Token Attributes</h5>${button('pencil', false)}</div></section></main>`;
}

test('TokenPage: the status badge is read from the status row; assertButtons judges the Token Details toolbar only; a v1 word or an enabled Activate fails', async ({ page }) => {
    const tokens = new TokenPage(page);
    await page.setContent(tokenDetail('Connected', ['refresh', 'check', 'times', 'random']));
    expect(await tokens.readStatusBadge()).toBe('Connected');
    await tokens.assertStatusBadge(['Connected', 'Disconnected', 'Warning', 'Unknown']);
    await tokens.assertButtons({ sync: 'disabled', activate: 'disabled', deactivate: 'disabled', random: 'disabled', edit: 'enabled', delete: 'enabled', reload: 'enabled' });
    await page.setContent(tokenDetail('Activated', ['check']));
    expect(await failsFast(tokens.assertStatusBadge(['Connected', 'Disconnected', 'Warning', 'Unknown']))).toBe(true);
    expect(await failsFast(tokens.assertButtons({ sync: 'disabled' }))).toBe(true);
    await tokens.assertButtons({ activate: 'disabled', sync: 'enabled' });
});
