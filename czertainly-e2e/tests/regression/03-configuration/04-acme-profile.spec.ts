/**
 * REG-CFG-04 — An ACME profile created through the UI (release checklist: Configuration 4; ilm#430).
 *
 * Creates the profile with one pre-authorized DNS identifier (exact match, a name under the run's prefix), enables it, and
 * checks in the API that the identifier is as entered and no Terms of Service is required. A pre-authorized identifier is
 * what lets an ACME order skip the challenge (as in REG-USE-05, which uses the run's ACME profile, not this one).
 *
 * Create-only: only this test's profile is enabled. The create answer is put in the ledger before the dialog or the list is
 * waited for. The run's ACME profile is made by the run-setup project, not here.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { AcmeProfilePage } from '../../../pages/AcmeProfilePage';
import { apiJson } from '../../../utils/regression/apiReads';
import { findByName } from '../../../utils/regression/listReads';
import { checkedDnsName, ownName } from '../../../utils/regression/ledger/runState';
import { lookupInList, submitRecordingByNameOnFailure } from '../../../utils/regression/ledger/uiCreates';
import { testMeta, tags } from '../../../utils/regression/tags';

test.describe('ACME profile configuration', { tag: tags.regression }, () => {
    test('an ACME profile created in the UI stores its pre-authorized identifier and can be enabled',
        testMeta({
            id: 'REG-CFG-04', prio: 'P1', issue: 'ilm#430',
            rule: ['an ACME profile with a pre-authorized DNS identifier (exact match), created disabled and enabled from the detail'],
        }),
        async ({ signedIn: page, api, own }) => {
            const name = ownName('acme');
            const identifier = checkedDnsName(`${name}.example.test`);
            const acmeProfiles = new AcmeProfilePage(page);

            await test.step('ACME Profiles → "+" → form', async () => {
                await acmeProfiles.goToList();
                await acmeProfiles.openCreateDialog();
                await acmeProfiles.fillName(name);
                await acmeProfiles.assertDefaultsOffered();
                await acmeProfiles.switchOffRequirements();
            });

            await test.step(`Pre-authorized identifier: dns / exact / ${identifier}`, async () => {
                await acmeProfiles.addPreauthorizedIdentifier(identifier);
                await acmeProfiles.fillRequiredCustomAttributes();
            });

            const uuid = await test.step('Create → the profile exists, disabled', async () => {
                const note = `pre-authorized ${identifier}`;
                const answer = await submitRecordingByNameOnFailure({ type: 'acmeProfiles', name, spec: own.spec, note, lookup: lookupInList(api, '/api/v1/acmeProfiles') }, () => acmeProfiles.submitCreateForm());
                // Ledger before assertion: from the create answer, before the dialog or the list is waited for.
                const created = own.record('acmeProfiles', answer, { name, note });
                await acmeProfiles.waitForCreateDialogClosed();
                await expect.poll(async () => (await findByName(api, '/api/v1/acmeProfiles', name))?.uuid ?? '').not.toBe('');
                expect((await findByName(api, '/api/v1/acmeProfiles', name))!.enabled).toBe(false);
                return created.uuid;
            });

            await test.step('Detail page → Enable', async () => {
                await acmeProfiles.goToDetail(uuid);
                await acmeProfiles.assertDetailShows(name);
                await acmeProfiles.enable();
                await expect.poll(async () => (await apiJson(api, 'GET', `/api/v1/acmeProfiles/${uuid}`)).enabled).toBe(true);
            });

            await test.step('API: identifier stored as entered', async () => {
                const detail = await apiJson(api, 'GET', `/api/v1/acmeProfiles/${uuid}`);
                expect(detail.preauthorizedIdentifiers).toEqual([{ type: 'dns', value: identifier, matchType: 'exact', allowWildcard: false }]);
                expect(detail.requireTermsOfService).toBe(false);
            });
        });
});
