/**
 * REG-CFG-04 — Create ACME profile (release checklist: Configuration 4).
 *
 * Flow: ACME Profiles → "+" → name, defaults for retry / validity, Terms of Service and contact not required,
 * one pre-authorized DNS identifier (exact) → Create → the profile is created disabled → Enable → enabled,
 * identifier stored. The identifier lets REG-USE-05 order without a challenge.
 * Create-only: only the profile this test created is enabled; nothing is deleted.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { fillRequiredCustomAttributes, fillText, submitButton, toolbarButton } from '../../pages/RegressionUi';
import { apiJson, findByName } from '../../utils/regression/regressionApi';
import { nameFor, recordCreated, updateState } from '../../utils/regression/regressionRun';

const SPEC = 'REG-CFG-04';

test.describe('@regression REG-CFG-04 ACME profile', () => {
    test('create an ACME profile with a pre-authorized identifier and enable it', async ({ page, api, env }) => {
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
            await submitButton(dialog).click();
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
            if (becomesRunObject) updateState({ acmeProfile: { ...own, identifier } });
        });
    });
});
