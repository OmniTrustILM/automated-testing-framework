/**
 * REG-CFG-04 — an ACME profile created through the UI (release checklist: Configuration 4): default retry interval
 * and order validity, no Terms of Service or contact required, one exact pre-authorized DNS identifier (so REG-USE-05
 * orders without a challenge); created disabled, then enabled. Create-only: only this test's profile is enabled.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { fillRequiredCustomAttributes, fillText, submitButtonOf } from '../../pages/ui/form';
import { toolbarButton } from '../../pages/ui/toolbar';
import { apiJson } from '../../utils/regression/apiReads';
import { findByName } from '../../utils/regression/listReads';
import { nameFor, updateRunState } from '../../utils/regression/ledger/runState';
import { recordCreated } from '../../utils/regression/ledger/ledger';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-CFG-04';

test.describe('ACME profile configuration', { tag: tags.regression }, () => {
    test('an ACME profile created in the UI stores its pre-authorized identifier and can be enabled',
        testMeta({
            id: 'REG-CFG-04', prio: 'P1', issue: 'ilm#430',
            rule: ['release checklist Configuration 4: an ACME profile with a pre-authorized DNS identifier (exact match), created disabled and enabled from the detail'],
        }),
        async ({ page, api, env }) => {
            const { name, becomesRunObject } = nameFor('acmeProfile', 'acme');
            const identifier = `${name}.example.test`;
            const dialog = page.getByRole('dialog').last();

            await test.step('ACME Profiles → "+" → form', async () => {
                await loginAsSmokeUser(page, env);
                await page.goto('administrator/#/acmeprofiles');
                await toolbarButton(page, 'plus').click();
                await expect(dialog).toBeVisible();
                await fillText(dialog.getByTestId('text-input-name'), name);
                await expect(dialog.getByTestId('text-input-retryInterval')).not.toHaveValue('');
                await expect(dialog.getByTestId('text-input-orderValidity')).not.toHaveValue('');
                for (const id of ['requireTermsOfService', 'requireContact']) {
                    const box = dialog.locator(`[id="${id}"]`);
                    if (await box.isChecked()) await box.uncheck({ force: true });
                }
            });

            await test.step(`Pre-authorized identifier: dns / exact / ${identifier}`, async () => {
                await dialog.getByTestId('add-identifier').click();
                await expect(dialog.getByTestId('identifier-row')).toHaveCount(1);
                await fillText(dialog.getByTestId('identifier-0-value'), identifier);
                await fillRequiredCustomAttributes(page, dialog, 'qa-reg');
            });

            const own = await test.step('Create → the profile exists, disabled', async () => {
                await submitButtonOf(dialog).click();
                await expect(dialog).toBeHidden({ timeout: 30_000 });
                await expect.poll(async () => (await findByName(api, '/api/v1/acmeProfiles', name))?.uuid ?? '').not.toBe('');
                const created = (await findByName(api, '/api/v1/acmeProfiles', name))!;
                const ref = recordCreated('acmeProfiles', { uuid: created.uuid, name }, SPEC, `pre-authorized ${identifier}`);
                expect(created.enabled).toBe(false);
                return ref;
            });
            const uuid = own.uuid;

            await test.step('Detail page → Enable', async () => {
                await page.goto(`administrator/#/acmeprofiles/detail/${uuid}`);
                await expect(page.locator('main')).toContainText(name);
                await toolbarButton(page, 'check').click();
                await expect.poll(async () => (await apiJson(api, 'GET', `/api/v1/acmeProfiles/${uuid}`)).enabled).toBe(true);
            });

            await test.step('API: identifier stored as entered', async () => {
                const detail = await apiJson(api, 'GET', `/api/v1/acmeProfiles/${uuid}`);
                expect(detail.preauthorizedIdentifiers).toEqual([{ type: 'dns', value: identifier, matchType: 'exact', allowWildcard: false }]);
                expect(detail.requireTermsOfService).toBe(false);
                if (becomesRunObject) updateRunState({ acmeProfile: { ...own, identifier } });
            });
        });
});
