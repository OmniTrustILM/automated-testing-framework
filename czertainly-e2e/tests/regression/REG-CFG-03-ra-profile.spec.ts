/**
 * REG-CFG-03 — an RA profile on the run's MS ADCS authority created through the UI (release checklist: Configuration 3):
 * the certificate template loads from the CA, the profile is created disabled and the UI enables it; the detail tabs open.
 * Create-only: only the RA profile this test created is enabled; nothing is deleted.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { fillRequiredCustomAttributes, fillText, submitButtonOf } from '../../pages/ui/form';
import { toolbarButton } from '../../pages/ui/toolbar';
import { chooseOption, selectTriggerByLabel } from '../../pages/ui/select';
import { apiJson } from '../../utils/regression/apiReads';
import { adcsBlocker, ensureAuthority, findAdcsSource, findAdcsTemplate } from '../../utils/regression/config/authorities';
import { nameFor, updateRunState } from '../../utils/regression/ledger/runState';
import { recordCreated } from '../../utils/regression/ledger/ledger';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-CFG-03';

test.describe('RA profile configuration', { tag: tags.regression }, () => {
    test('an RA profile created in the UI on the MS ADCS authority starts disabled and can be enabled',
        testMeta({
            id: 'REG-CFG-03', prio: 'P1', issue: 'ilm#436',
            rule: ['release checklist Configuration 3: an RA profile on the MS ADCS authority with a template from the CA; RA profiles are created disabled and enabled from the detail'],
        }),
        async ({ page, api, env }) => {
            // Needs a connected MS ADCS authority whose connector answers its LIVE health (adcsBlocker); else the named
            // environment blocker (deploy gate, never a pass) and the CA-agnostic run RA profile takes over.
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
                const tpl = page.getByTestId('select-__attributes__ra-profile__.data_certificateTemplateSelect-trigger').or(selectTriggerByLabel(dialog, /Certificate template/)).first();
                await chooseOption(page, tpl, template.reference);
                await fillRequiredCustomAttributes(page, dialog, 'qa-reg');
            });

            const ra = await test.step('Create → detail page', async () => {
                await submitButtonOf(dialog).click();
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
                if (becomesRunObject) updateRunState({ raProfile: { ...ra, authorityUuid: authority.uuid } });
            });

            await test.step('Detail tabs open', async () => {
                for (const tab of ['Protocols', 'Attributes', 'Validation', 'Events']) {
                    await page.locator('main').getByRole('tab', { name: tab }).click();
                    await expect(page.locator('main')).not.toContainText(/unexpected error|internal server error/i);
                }
            });
        });
});
