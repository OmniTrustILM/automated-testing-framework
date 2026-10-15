/**
 * REG-CFG-03 — Create RA profile with MS ADCS CA (release checklist: Configuration 3).
 *
 * Flow: RA Profiles → "+" → Create RA Profile → name → the run's MS ADCS authority → Certificate template
 * (loaded from the CA) → Create → detail page shows Disabled (RA profiles are created disabled) → Enable →
 * Enabled. Create-only: only the RA profile this test created is enabled; nothing is deleted.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { chooseOption, fillRequiredCustomAttributes, fillText, selectTrigger, submitButton, toolbarButton } from '../../pages/RegressionUi';
import { adcsBlocker, apiJson, ensureAuthority, findAdcsSource, findAdcsTemplate } from '../../utils/regression/regressionApi';
import { nameFor, recordCreated, updateState } from '../../utils/regression/regressionRun';

const SPEC = 'REG-CFG-03';

test.describe('@regression REG-CFG-03 RA profile on MS ADCS', () => {
    test('create an RA profile on the MS ADCS authority and enable it', async ({ page, api, env }) => {
        // B1: a connected MS ADCS authority whose connector answers its LIVE health (adcsBlocker); else the named
        // environment blocker (deploy gate, never a pass) and the CA-agnostic run RA profile takes over (ensureRaProfile).
        const blocker = await adcsBlocker(api);
        test.skip(!!blocker, blocker ?? '');
        const authority = await test.step('Prerequisite: the run MS ADCS authority', async () => ensureAuthority(api, SPEC));
        const template = await findAdcsTemplate(api, await findAdcsSource(api));
        const { name, becomesRunObject } = nameFor('raProfile', 'ra');
        const dialog = page.getByRole('dialog', { name: 'Create RA Profile' });

        await test.step('RA Profiles → "+" → Create RA Profile → authority → template', async () => {
            await loginAsSmokeUser(page, env);
            await page.goto('administrator/#/raprofiles');
            await toolbarButton(page, 'plus').click();
            await expect(dialog).toBeVisible();
            await fillText(dialog.getByTestId('text-input-name'), name);
            await chooseOption(page, page.getByTestId('select-authoritySelect-trigger'), authority.name);
            const tpl = page.getByTestId('select-__attributes__ra-profile__.data_certificateTemplateSelect-trigger').or(selectTrigger(dialog, /Certificate template/)).first();
            await chooseOption(page, tpl, template.reference);
            await fillRequiredCustomAttributes(page, dialog, 'qa-reg');
        });

        const ra = await test.step('Create → detail page', async () => {
            await submitButton(dialog).click();
            await expect(page).toHaveURL(/\/raprofiles\/detail\/[0-9a-f-]{36}\/[0-9a-f-]{36}/, { timeout: 60_000 });
            const id = /raprofiles\/detail\/[0-9a-f-]{36}\/([0-9a-f-]{36})/.exec(page.url())![1];
            return recordCreated('raProfiles', { uuid: id, name }, SPEC, `template ${template.data}`, { authority: authority.uuid });
        });

        const status = page.locator('main tr[data-id="enabled"] [data-testid="status-badge"]');
        await test.step('Created disabled → Enable → Enabled', async () => {
            await expect(status).toHaveText('Disabled');
            await toolbarButton(page, 'enable').click();
            await expect(status).toHaveText('Enabled');
        });

        await test.step('API: enabled, on the run authority, template as chosen', async () => {
            const detail = await apiJson(api, 'GET', `/api/v1/authorities/${authority.uuid}/raProfiles/${ra.uuid}`);
            expect(detail.enabled).toBe(true);
            expect(detail.authorityInstanceUuid).toBe(authority.uuid);
            const tpl = (detail.attributes ?? []).find((a: { name: string }) => a.name === 'data_certificateTemplate');
            expect(tpl?.content?.[0]?.data).toBe(template.data);
            if (becomesRunObject) updateState({ raProfile: { ...ra, authorityUuid: authority.uuid } });
        });

        await test.step('Detail tabs open', async () => {
            for (const tab of ['Protocols', 'Attributes', 'Validation', 'Events']) {
                await page.locator('main').getByRole('tab', { name: tab }).click();
                await expect(page.locator('main')).not.toContainText(/unexpected error|internal server error/i);
            }
        });
    });
});
