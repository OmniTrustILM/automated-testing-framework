/**
 * REG-CFG-05 — The run's ACME profile activated on an own RA profile (release checklist: Configuration 5; ilm#430).
 *
 * Activation: the row is Enabled, the API says acmeAvailable and the RA-profile directory answers.
 * REG-CFG-05.2: an RA profile whose name holds a space is refused at activation with the backend text; the row stays inactive.
 * The create does not enforce the name rule, so the refusal comes late (core#743); the UI must show the backend text (fe#884).
 *
 * Both profiles pass the live check before the UI changes them. Activation always runs on a fresh copy of the run RA profile.
 * The tests need a CA, so without one they skip before anything exists.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { RaProfilePage } from '../../../pages/RaProfilePage';
import { apiJson } from '../../../utils/regression/apiReads';
import { ensureAcmeProfile } from '../../../utils/regression/config/acmeProfiles';
import { createOwnRaProfileLike } from '../../../utils/regression/ownRaProfiles';
import { escapeRegExp } from '../../../utils/regression/text';
import { testMeta, tags } from '../../../utils/regression/tags';

test.describe('ACME on an RA profile', { tag: tags.regression }, () => {
    test('ACME activated in the UI on an own RA profile is enabled and its directory answers',
        testMeta({
            id: 'REG-CFG-05', prio: 'P1', issue: 'ilm#430', needs: 'ca',
            rule: ['activate the ACME profile on the RA profile; the RA-profile directory lists the RFC 8555 resources'],
        }),
        async ({ signedIn: page, api, own, live, ownRaProfile }) => {
            const ra = await test.step('Prerequisite: an own RA profile of this run without ACME', async () =>
                createOwnRaProfileLike(api, own.spec, 'ra-acme', { source: ownRaProfile, note: 'fresh RA profile for the UI activation' }));
            const acme = await test.step('Prerequisite: the run ACME profile (enabled)', async () => ensureAcmeProfile(api, own.spec));

            const [liveRa, liveAcme] = await test.step('Guard: the RA profile and the ACME profile are this run\'s own objects (live check)', async () =>
                [await live('raProfiles', ra), await live('acmeProfiles', acme)] as const);
            const raProfiles = new RaProfilePage(page);

            await test.step(`RA profile → Protocols tab → ACME row → Activate with ${liveAcme.name}`, async () => {
                await raProfiles.goToDetail(ra.authorityUuid, liveRa.uuid, 'Protocols');
                await raProfiles.activateProtocol('acme', liveAcme.name);
            });

            await test.step('ACME row: Enabled, Deactivate offered', async () => {
                await raProfiles.assertProtocolActive('acme');
            });

            await test.step('API: acmeAvailable and the RA-profile directory answers', async () => {
                const acmeInfo = await apiJson(api, 'GET', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/acme`);
                expect(acmeInfo.acmeAvailable).toBe(true);
                expect(acmeInfo.directoryUrl).toContain(`/protocols/acme/raProfile/${ra.name}/directory`);
                const directory = await (await fetch(acmeInfo.directoryUrl)).json();
                const base = new RegExp(`/protocols/acme/raProfile/${escapeRegExp(ra.name)}/`);
                expect(String(directory.newAccount)).toMatch(new RegExp(`${base.source}new-account$`));
                expect(String(directory.newOrder)).toMatch(new RegExp(`${base.source}new-order$`));
            });
        });

    test('ACME activation on an RA profile whose name holds a space is refused and the row stays inactive',
        testMeta({
            id: 'REG-CFG-05.2', prio: 'P1', issue: 'ilm#430', needs: 'ca',
            rule: [
                '"RA Profile name can contain only unreserved URI characters (alphanumeric, hyphen, period, underscore, and tilde)" at activation (RaProfileServiceImpl; core#743, PR core#776)',
                'the RA profile create does not enforce the alphabet, so the refusal comes late, at activation',
                'fe#884: the UI shows the backend text ("Failed to activate ACME (<status>): <message>")',
            ],
        }),
        async ({ signedIn: page, api, own, live, ownRaProfile }) => {
            // A time suffix keeps the name unique under --repeat-each; the space stays.
            const spaced = await test.step('Prerequisite: an own RA profile named "<run>-ra space-<stamp>" (attributes copied read-only from the run RA profile)', async () =>
                createOwnRaProfileLike(api, own.spec, 'ra space', { source: ownRaProfile, note: 'RA profile with a space in its name', enable: false }));
            // After the CA need: no ACME profile is made on a tier that cannot run the test.
            const acme = await test.step('Prerequisite: the run ACME profile (enabled)', async () => ensureAcmeProfile(api, own.spec));

            const [liveSpaced, liveAcme] = await test.step('Guard: the spaced RA profile and the ACME profile are this run\'s own objects (live check)', async () =>
                [await live('raProfiles', spaced), await live('acmeProfiles', acme)] as const);
            const raProfiles = new RaProfilePage(page);

            await test.step('Protocols tab: ACME is not active yet', async () => {
                await raProfiles.goToDetail(spaced.authorityUuid, liveSpaced.uuid, 'Protocols');
                await raProfiles.assertProtocolInactive('acme');
            });

            await test.step('Activate ACME with the run ACME profile → refused with the backend text', async () => {
                await raProfiles.activateProtocol('acme', liveAcme.name);
                await raProfiles.assertActivationRefused('acme', /RA Profile name can contain only unreserved URI characters/);
            });

            await test.step('After a reload the ACME row is still inactive', async () => {
                await page.reload();
                await raProfiles.assertProtocolInactive('acme');
            });

            await test.step('API: acmeAvailable is false on the spaced RA profile', async () => {
                const acmeInfo = await apiJson(api, 'GET', `/api/v1/authorities/${spaced.authorityUuid}/raProfiles/${spaced.uuid}/protocols/acme`);
                expect(acmeInfo.acmeAvailable).toBe(false);
            });
        });
});
