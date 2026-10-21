/**
 * REG-CFG-05 — the run's ACME profile activated on an own RA profile through the Protocols tab (release checklist:
 * Configuration 5): the ACME row is Enabled and the RA-profile directory answers; an RA profile name with a space is
 * refused at activation with the backend text. The browser is not behind the API guard, so both profiles pass
 * `assertOwnLive` before the UI changes them; a re-run that finds ACME active uses a fresh own RA profile.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { RaProfilePage } from '../../pages/RaProfilePage';
import { assertOwnLive } from '../../utils/regression/ledger/ownership';
import { apiJson } from '../../utils/regression/apiReads';
import { ensureAcmeProfile } from '../../utils/regression/config/acmeProfiles';
import { createRaProfileLike, enableOwnRaProfile, ensureOwnRaProfile, orSkipWithoutCa } from '../../utils/regression/ownRaProfiles';
import { readRunState, runName, updateRunState } from '../../utils/regression/ledger/runState';
import { recordCreated } from '../../utils/regression/ledger/ledger';
import { escapeRegExp } from '../../utils/regression/text';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-CFG-05';

test.describe('ACME on an RA profile', { tag: tags.regression }, () => {
    test('ACME activated in the UI on an own RA profile is enabled and its directory answers',
        testMeta({
            id: 'REG-CFG-05', prio: 'P1', issue: 'ilm#430',
            rule: ['release checklist Configuration 5: activate the ACME profile on the RA profile; the RA-profile directory lists the RFC 8555 resources'],
        }),
        async ({ page, api, env }) => {
            // The RA profile first: without a CA the test skips before anything else is created.
            const ra = await test.step('Prerequisite: an own RA profile of this run without ACME', async () => {
                const runRa = await orSkipWithoutCa(ensureOwnRaProfile(api, SPEC), (reason) => test.skip(true, reason));
                if (readRunState().acmeActivatedOn !== runRa.uuid) return { ...runRa, isRunRa: true };
                const fresh = await createRaProfileLike(api, runRa, runName(`ra-acme-${Date.now().toString(36)}`));
                const own = recordCreated('raProfiles', fresh, SPEC, 'fresh RA profile for the UI activation', { authority: runRa.authorityUuid });
                await enableOwnRaProfile(api, runRa.authorityUuid, own);
                return { ...own, authorityUuid: runRa.authorityUuid, isRunRa: false };
            });
            const acme = await test.step('Prerequisite: the run ACME profile (enabled)', async () => ensureAcmeProfile(api, SPEC));

            await test.step('Guard: the RA profile and the ACME profile are this run\'s own objects (live check)', async () => {
                await assertOwnLive(api, 'raProfiles', ra, 'UI activation (RA profile)');
                await assertOwnLive(api, 'acmeProfiles', acme, 'UI activation (ACME profile)');
            });
            const raPage = new RaProfilePage(page);

            await test.step(`RA profile → Protocols tab → ACME row → Activate with ${acme.name}`, async () => {
                await loginAsSmokeUser(page, env);
                await raPage.goToDetail(ra.authorityUuid, ra.uuid, 'Protocols');
                await raPage.activateProtocol('acme', acme.name);
            });

            await test.step('ACME row: Enabled, Deactivate offered', async () => {
                await raPage.assertProtocolActive('acme');
                if (ra.isRunRa) updateRunState({ acmeActivatedOn: ra.uuid });
            });

            await test.step('API: acmeAvailable and the RA-profile directory answers', async () => {
                const acmeInfo = await apiJson(api, 'GET', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/acme`);
                expect(acmeInfo.acmeAvailable).toBe(true);
                expect(acmeInfo.directoryUrl).toContain(`/protocols/acme/raProfile/${ra.name}/directory`);
                const dir = await (await fetch(acmeInfo.directoryUrl)).json();
                const base = new RegExp(`/protocols/acme/raProfile/${escapeRegExp(ra.name)}/`);
                expect(String(dir.newAccount)).toMatch(new RegExp(`${base.source}new-account$`));
                expect(String(dir.newOrder)).toMatch(new RegExp(`${base.source}new-order$`));
            });
        });

    test('ACME activation on an RA profile whose name holds a space is refused and the row stays inactive',
        testMeta({
            id: 'REG-CFG-05.2', prio: 'P1', issue: 'ilm#430',
            rule: [
                '"RA Profile name can contain only unreserved URI characters (alphanumeric, hyphen, period, underscore, and tilde)" at activation (RaProfileServiceImpl; core#743, PR core#776)',
                'the RA profile create does not enforce the alphabet, so the refusal comes late, at activation',
                'fe#884: the UI shows the backend text ("Failed to activate ACME (<status>): <message>")',
            ],
        }),
        async ({ page, api, env, ownRaProfile }) => {
            const spaced = await test.step('Prerequisite: an own RA profile named "<run>-ra space-<stamp>" (attributes copied read-only from the run RA profile)', async () => {
                const runRa = ownRaProfile;
                // A time suffix keeps the name unique under --repeat-each; the space stays.
                const ref = recordCreated('raProfiles', await createRaProfileLike(api, runRa, runName(`ra space-${Date.now().toString(36)}`)), SPEC,
                    'RA profile with a space in its name', { authority: runRa.authorityUuid });
                return { ...ref, authorityUuid: runRa.authorityUuid };
            });
            // After the CA skip: no ACME profile is made on a tier that cannot run the test.
            const acme = await test.step('Prerequisite: the run ACME profile (enabled)', async () => ensureAcmeProfile(api, SPEC));

            await test.step('Guard: the spaced RA profile and the ACME profile are this run\'s own objects (live check)', async () => {
                await assertOwnLive(api, 'raProfiles', spaced, 'UI activation of the spaced RA profile');
                await assertOwnLive(api, 'acmeProfiles', acme, 'UI activation on the spaced RA profile (ACME profile)');
            });
            const raPage = new RaProfilePage(page);

            await test.step('Protocols tab: ACME is not active yet', async () => {
                await loginAsSmokeUser(page, env);
                await raPage.goToDetail(spaced.authorityUuid, spaced.uuid, 'Protocols');
                await raPage.assertProtocolInactive('acme');
            });

            await test.step('Activate ACME with the run ACME profile → refused with the backend text', async () => {
                await raPage.activateProtocol('acme', acme.name);
                await raPage.assertActivationRefused('acme', /RA Profile name can contain only unreserved URI characters/);
            });

            await test.step('After a reload the ACME row is still inactive', async () => {
                await page.reload();
                await raPage.assertProtocolInactive('acme');
            });

            await test.step('API: acmeAvailable is false on the spaced RA profile', async () => {
                const acmeInfo = await apiJson(api, 'GET', `/api/v1/authorities/${spaced.authorityUuid}/raProfiles/${spaced.uuid}/protocols/acme`);
                expect(acmeInfo.acmeAvailable).toBe(false);
            });
        });
});
