/**
 * REG-CFG-06 — Create certificate group (release checklist: Configuration 6).
 *
 * Flow: Groups → "+" → Create Group → name, description, e-mail (+ any required custom attribute of the tier) →
 * Create → the group exists (API) and its detail tabs open. Negative: the same name again is refused.
 * Create-only: nothing is deleted.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { dismissToasts, fillRequiredCustomAttributes, fillText, submitButton, toast, toolbarButton } from '../../pages/RegressionUi';
import { apiJson, findByName } from '../../utils/regression/regressionApi';
import { nameFor, recordCreated, updateState } from '../../utils/regression/regressionRun';

const SPEC = 'REG-CFG-06';

test.describe('@regression REG-CFG-06 group', () => {
    test('create a certificate group through the UI', async ({ page, api, env }) => {
        const { name, becomesRunObject } = nameFor('group', 'group');
        const dialog = page.getByRole('dialog', { name: 'Create Group' });

        const fillForm = async () => {
            await toolbarButton(page, 'plus').click();
            await expect(dialog).toBeVisible();
            await fillText(dialog.getByTestId('text-input-name'), name);
            await fillText(dialog.getByTestId('text-input-description'), 'Main-functionality regression group');
            await fillText(dialog.getByTestId('text-input-email'), `${name}@example.test`);
            await fillRequiredCustomAttributes(page, dialog, 'qa-reg');
        };

        await test.step('Groups → "+" → Create Group', async () => {
            await loginAsSmokeUser(page, env);
            await page.goto('administrator/#/groups');
            await fillForm();
        });

        const uuid = await test.step('Create → the group exists', async () => {
            await submitButton(dialog).click();
            await expect(dialog).toBeHidden();
            await expect.poll(async () => (await findByName(api, '/api/v1/groups', name))?.uuid ?? '').not.toBe('');
            const created = (await findByName(api, '/api/v1/groups', name))!;
            const own = recordCreated('groups', { uuid: created.uuid, name }, SPEC);
            if (becomesRunObject) updateState({ group: own });
            expect(created.email).toBe(`${name}@example.test`);
            return created.uuid as string;
        });

        await test.step('Detail page and its tabs', async () => {
            await page.goto(`administrator/#/groups/detail/${uuid}`);
            await expect(page.locator('main')).toContainText(name);
            for (const tab of ['Users', 'Events', 'Event History']) {
                await page.locator('main').getByRole('tab', { name: tab }).click();
                await expect(page.locator('main')).not.toContainText(/unexpected error|internal server error/i);
            }
        });

        await test.step('Negative: the same name again is refused', async () => {
            await page.goto('administrator/#/groups');
            await fillForm();
            await submitButton(dialog).click();
            await expect(toast(page, /already exist/i)).toBeVisible();
            const all = await apiJson<Array<{ name: string }>>(api, 'GET', '/api/v1/groups');
            expect(all.filter((g) => g.name === name)).toHaveLength(1);
            await dismissToasts(page);
            if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        });
    });
});
