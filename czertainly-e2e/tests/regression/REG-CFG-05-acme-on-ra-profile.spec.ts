/**
 * REG-CFG-05 — Assign ACME profile to RA profile (release checklist: Configuration 5).
 *
 * Flow: an own RA profile of the run → Protocols tab → ACME row → Activate → "Activate ACME protocol" dialog → the run's
 * ACME profile → Activate → the ACME row is Enabled with Deactivate offered → the API reports acmeAvailable and the
 * RA-profile directory URL, which answers with the ACME directory.
 *
 * Own objects only: the UI activation changes the RA profile, and the browser is not behind the API guard, so the RA
 * profile and the ACME profile pass `assertOwnLive` first (ledger line of this run + live run-prefixed name; review
 * R16). The RA profile is the run's own (`ensureOwnRaProfile`: on a local stack with REG_RA_PROFILE_NAME an own clone
 * of that issue-only parent, M4); when ACME is already active on it (a re-run) a fresh own RA profile is made with the
 * same connector attributes (`createRaProfileLike`, copied read-only). Page actions live in pages/RaProfilePage.ts (m4).
 * REG-CFG-05.2 adds the refusal for an RA profile name that is not URI-safe.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { RaProfilePage } from '../../pages/RaProfilePage';
import { assertOwnLive } from '../../utils/regression/ownObjects';
import {
    apiJson, createRaProfileLike, enableOwnRaProfile, ensureAcmeProfile, ensureOwnRaProfile, ensureRaProfile, orSkipWithoutCa,
} from '../../utils/regression/regressionApi';
import { readState, recordCreated, regName, updateState } from '../../utils/regression/regressionRun';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-CFG-05';
const skip = (reason: string) => test.skip(true, reason);

test.describe('@regression REG-CFG-05 ACME on RA profile', () => {
    test('activate the ACME profile on the RA profile through the UI', async ({ page, api, env }) => {
        // The RA profile first: without a CA the test skips before anything else is created (Fable F4).
        const ra = await test.step('Prerequisite: an own RA profile of this run without ACME', async () => {
            const runRa = await orSkipWithoutCa(ensureOwnRaProfile(api, SPEC), skip);
            if (readState().acmeActivatedOn !== runRa.uuid) return { ...runRa, isRunRa: true };
            const fresh = await createRaProfileLike(api, runRa, regName(`ra-acme-${Date.now().toString(36)}`));
            const own = recordCreated('raProfiles', fresh, SPEC, 'fresh RA profile for the UI activation', { authority: runRa.authorityUuid });
            await enableOwnRaProfile(api, runRa.authorityUuid, own);
            return { ...own, authorityUuid: runRa.authorityUuid, isRunRa: false };
        });
        const acme = await test.step('Prerequisite: the run ACME profile (enabled)', async () => ensureAcmeProfile(api, SPEC));

        await test.step('Guard: the RA profile and the ACME profile are this run\'s own objects (live check)', async () => {
            await assertOwnLive(api, 'raProfiles', ra, 'REG-CFG-05 UI activation (RA profile)');
            await assertOwnLive(api, 'acmeProfiles', acme, 'REG-CFG-05 UI activation (ACME profile)');
        });
        const raPage = new RaProfilePage(page);

        await test.step(`RA profile → Protocols tab → ACME row → Activate with ${acme.name}`, async () => {
            await loginAsSmokeUser(page, env);
            await raPage.openDetail(ra.authorityUuid, ra.uuid, 'Protocols');
            await raPage.activateProtocol('acme', acme.name);
        });

        await test.step('ACME row: Enabled, Deactivate offered', async () => {
            await raPage.assertProtocolActive('acme');
            if (ra.isRunRa) updateState({ acmeActivatedOn: ra.uuid });
        });

        await test.step('API: acmeAvailable and the RA-profile directory answers', async () => {
            const acmeInfo = await apiJson(api, 'GET', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/acme`);
            expect(acmeInfo.acmeAvailable).toBe(true);
            expect(acmeInfo.directoryUrl).toContain(`/protocols/acme/raProfile/${ra.name}/directory`);
            const dir = await (await fetch(acmeInfo.directoryUrl)).json();
            expect(dir.newAccount).toBeTruthy();
            expect(dir.newOrder).toBeTruthy();
        });
    });

    test('REG-CFG-05.2: ACME activation on an RA profile whose name holds a space is refused with the backend text; the row stays inactive',
        meta({
            id: 'REG-CFG-05.2', prio: 'P1', issue: 'ilm#430',
            rule: [
                'protocols §3.2 rule 2 / R3c: "RA Profile name can contain only unreserved URI characters (alphanumeric, hyphen, period, underscore, and tilde)" at activation (RaProfileServiceImpl; core#743, PR core#776)',
                'strategy S-06: the RA profile create does not enforce the alphabet, so the refusal comes late, at activation',
                'fe#884: the UI shows the backend text ("Failed to activate ACME (<status>): <message>")',
            ],
        }),
        async ({ page, api, env }) => {
            const spaced = await test.step('Prerequisite: an own RA profile named "<run>-ra space-<stamp>" (attributes copied read-only from the run RA profile)', async () => {
                const runRa = await orSkipWithoutCa(ensureRaProfile(api, SPEC), skip);
                // A time suffix keeps the name unique under --repeat-each (Sonnet F5); the space stays.
                const ref = recordCreated('raProfiles', await createRaProfileLike(api, runRa, regName(`ra space-${Date.now().toString(36)}`)), SPEC,
                    'RA profile with a space in its name (REG-CFG-05.2)', { authority: runRa.authorityUuid });
                return { ...ref, authorityUuid: runRa.authorityUuid };
            });
            // After the CA skip (Fable F4): no ACME profile is made on a tier that cannot run the test.
            const acme = await test.step('Prerequisite: the run ACME profile (enabled)', async () => ensureAcmeProfile(api, SPEC));

            await test.step('Guard: the spaced RA profile and the ACME profile are this run\'s own objects (live check)', async () => {
                await assertOwnLive(api, 'raProfiles', spaced, 'REG-CFG-05.2 UI activation (RA profile)');
                await assertOwnLive(api, 'acmeProfiles', acme, 'REG-CFG-05.2 UI activation (ACME profile)');
            });
            const raPage = new RaProfilePage(page);

            await test.step('Protocols tab: ACME is not active yet', async () => {
                await loginAsSmokeUser(page, env);
                await raPage.openDetail(spaced.authorityUuid, spaced.uuid, 'Protocols');
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
