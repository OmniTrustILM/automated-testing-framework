/**
 * REG-CFG-03 — An RA profile on the run's MS ADCS authority created through the UI (release checklist: Configuration 3; ilm#436).
 *
 * Creates the profile (Disabled), enables it, and checks in the API that it is enabled, on the run authority, with the chosen
 * template. The detail tabs Protocols, Attributes, Validation and Events open without an error.
 *
 * Create-only: only the RA profile this test created is enabled; nothing is deleted. Needs a connected MS ADCS authority
 * whose connector answers its live health, otherwise it skips with the named blocker. The create answer is put in the
 * ledger before the redirect is waited for.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { RaProfilePage } from '../../../pages/RaProfilePage';
import { apiJson } from '../../../utils/regression/apiReads';
import { adcsBlocker, ensureAuthority, findAdcsSource, findAdcsTemplate } from '../../../utils/regression/config/authorities';
import { ownName } from '../../../utils/regression/ledger/runState';
import { lookupInList, submitRecordingByNameOnFailure } from '../../../utils/regression/ledger/uiCreates';
import { testMeta, tags } from '../../../utils/regression/tags';
import { RA_PROFILE_CREATE_MS } from '../../../utils/regression/timeouts';


test.describe('RA profile configuration', { tag: tags.regression }, () => {
    test('an RA profile created in the UI on the MS ADCS authority starts disabled and can be enabled',
        testMeta({
            id: 'REG-CFG-03', prio: 'P1', issue: 'ilm#436',
            rule: ['an RA profile on the MS ADCS authority with a template from the CA; RA profiles are created disabled and enabled from the detail'],
        }),
        async ({ signedIn: page, api, own }) => {
            // Needs a connected MS ADCS authority whose connector answers its LIVE health (adcsBlocker); else the named
            // environment blocker (deploy gate, never a pass) and the CA-agnostic run RA profile takes over. Reads only, before any create.
            const blocker = await adcsBlocker(api);
            test.skip(!!blocker, blocker ?? '');
            const authority = await test.step('Prerequisite: the run MS ADCS authority', async () => ensureAuthority(api, own.spec));
            const template = await findAdcsTemplate(api, await findAdcsSource(api));
            const name = ownName('ra');
            const raProfiles = new RaProfilePage(page);

            const dialog = await test.step('RA Profiles → "+" → Create RA Profile → authority → template', async () => {
                await raProfiles.goToList();
                const opened = await raProfiles.openCreateDialog();
                await opened.fillName(name);
                await opened.chooseAuthority(authority.name);
                await opened.chooseTemplate(template.reference);
                await opened.fillRequiredCustomAttributes();
                return opened;
            });

            const ra = await test.step('Create → detail page', async () => {
                const note = `template ${template.data}`;
                const answer = await submitRecordingByNameOnFailure(
                    { type: 'raProfiles', name, spec: own.spec, note, parents: { authority: authority.uuid }, lookup: lookupInList(api, '/api/v1/raProfiles') },
                    () => dialog.submitCreate({ timeout: RA_PROFILE_CREATE_MS }));
                // Ledger before assertion: from the create answer, before the redirect is waited for.
                const created = own.record('raProfiles', answer, { name, note, parents: { authority: authority.uuid } });
                await raProfiles.waitForDetail({ timeout: RA_PROFILE_CREATE_MS });
                return created;
            });

            await test.step('Created disabled → Enable → Enabled', async () => {
                await raProfiles.assertStatus('Disabled');
                await raProfiles.enable();
                await raProfiles.assertStatus('Enabled');
            });

            await test.step('API: enabled, on the run authority, template as chosen', async () => {
                const detail = await apiJson(api, 'GET', `/api/v1/authorities/${authority.uuid}/raProfiles/${ra.uuid}`);
                expect(detail, 'the RA profile is enabled on the run authority').toMatchObject({ enabled: true, authorityInstanceUuid: authority.uuid });
                const chosen = (detail.attributes ?? []).find((a: { name: string }) => a.name === 'data_certificateTemplate');
                expect(chosen?.content?.[0]?.data).toBe(template.data);
            });

            await test.step('Detail tabs open', async () => {
                for (const tab of ['Protocols', 'Attributes', 'Validation', 'Events'] as const) {
                    await raProfiles.openTab(tab);
                    await raProfiles.assertNoErrorShown(tab);
                }
            });
        });
});
