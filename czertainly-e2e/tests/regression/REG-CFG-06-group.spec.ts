/**
 * REG-CFG-06 — a certificate group created through the UI (release checklist: Configuration 6): name, description,
 * e-mail (and any required custom attribute of the tier); the group exists, its detail tabs open, and the same name again
 * is refused. Create-only: nothing is deleted.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { fillRequiredCustomAttributes, fillText, submitButtonOf } from '../../pages/ui/form';
import { dismissToasts, toast } from '../../pages/ui/toast';
import { toolbarButton } from '../../pages/ui/toolbar';
import { apiJson } from '../../utils/regression/apiReads';
import { findByName } from '../../utils/regression/listReads';
import { nameFor, updateRunState } from '../../utils/regression/ledger/runState';
import { recordCreated } from '../../utils/regression/ledger/ledger';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-CFG-06';

test.describe('Certificate group configuration', { tag: tags.regression }, () => {
    test('a group created in the UI is stored with its e-mail, its tabs open and its name is refused twice',
        testMeta({
            id: 'REG-CFG-06', prio: 'P2', issue: 'ilm#428',
            rule: ['release checklist Configuration 6: create a certificate group; a group name is unique (a second create is refused, "already exists")'],
        }),
        async ({ page, api, env }) => {
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
                await submitButtonOf(dialog).click();
                await expect(dialog).toBeHidden();
                await expect.poll(async () => (await findByName(api, '/api/v1/groups', name))?.uuid ?? '').not.toBe('');
                const created = (await findByName(api, '/api/v1/groups', name))!;
                const own = recordCreated('groups', { uuid: created.uuid, name }, SPEC);
                if (becomesRunObject) updateRunState({ group: own });
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
                await submitButtonOf(dialog).click();
                await expect(toast(page, /already exist/i)).toBeVisible();
                const all = await apiJson<Array<{ name: string }>>(api, 'GET', '/api/v1/groups');
                expect(all.filter((g) => g.name === name)).toHaveLength(1);
                await dismissToasts(page);
                if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
            });
        });
});
