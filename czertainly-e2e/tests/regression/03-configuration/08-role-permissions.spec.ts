/**
 * REG-CFG-08 — Role permissions in the permissions editor (release checklist: Configuration 8; ilm#427).
 *
 * Sets Certificates and RA Profiles permissions on the run role and checks that the API returns exactly those and the reloaded
 * editor shows them. A fresh role gets RA Profiles List at resource level plus object-level Detail and Members on one RA
 * profile; the object must not get them for every RA profile (fe-administrator#2283, fixed, guarded against its return).
 *
 * Create-only: only this suite's roles change, and each passes the live check first. A fresh role is recorded in the ledger
 * before it is edited. The object-level check uses the run's own RA profile, so it needs a CA (skips without one).
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { RolePermissionsPage } from '../../../pages/RolePermissionsPage';
import { apiJson } from '../../../utils/regression/apiReads';
import { ensureRunRole } from '../../../utils/regression/ownRoles';
import { testMeta, tags } from '../../../utils/regression/tags';

const CERT_ACTIONS = ['List', 'Detail', 'Create', 'Issue'];

test.describe('Role permissions', { tag: tags.regression }, () => {
    test('certificate and RA profile permissions saved in the editor are stored and shown after reload',
        testMeta({
            id: 'REG-CFG-08', row: 'saved in the editor', prio: 'P1', issue: 'ilm#427',
            rule: ['grant Certificates (List, Detail, Create, Issue) and RA Profiles (List) to the role; the API and the editor agree after a reload'],
        }),
        async ({ signedIn: page, api, own, live }, testInfo) => {
            const role = await test.step('Prerequisite: the run role', async () => ensureRunRole(api, own.spec));
            const liveRole = await test.step('Guard: the role is this run\'s own object (live check) before the UI changes it', async () => live('roles', role));
            const editor = new RolePermissionsPage(page);

            await test.step('Open the permissions editor', async () => {
                await editor.goToEditor(liveRole.uuid);
                await editor.assertAllResourcesOff();
            });

            await test.step(`Certificates: ${CERT_ACTIONS.join(', ')}`, async () => {
                await editor.openResource(editor.resource('Certificates'));
                await editor.allowActions(CERT_ACTIONS);
            });

            await test.step('RA Profiles: List', async () => {
                await editor.openResource(editor.raProfilesResource);
                await editor.allowActions(['List']);
            });

            await test.step('Save → the API returns the configured permissions', async () => {
                const saved = await editor.save();
                expect(saved.answer.status, 'the permissions save').toBeLessThan(300);
                await expect
                    .poll(async () => {
                        const stored = await apiJson(api, 'GET', `/api/v1/roles/${liveRole.uuid}/permissions`);
                        return (stored.resources?.find((r: { name: string }) => r.name === 'certificates')?.actions ?? []).slice().sort().join(',');
                    })
                    .toBe('create,detail,issue,list');
                const stored = await apiJson(api, 'GET', `/api/v1/roles/${liveRole.uuid}/permissions`);
                expect(stored.allowAllResources).toBe(false);
                expect(stored.resources.find((r: { name: string }) => r.name === 'raProfiles')?.actions).toContain('list');
                await testInfo.attach('permissions.json', { body: JSON.stringify(stored, null, 2), contentType: 'application/json' });
            });

            await test.step('Reload: the editor shows the saved permissions', async () => {
                await editor.goToEditor(liveRole.uuid);
                await editor.openResource(editor.resource('Certificates'));
                await editor.assertActionsChecked(CERT_ACTIONS);
            });
        });

    test('an object-level permission stays on its object and is not granted on every RA profile',
        testMeta({
            id: 'REG-CFG-08', row: 'object-level permission', prio: 'P1', issue: 'ilm#427', needs: 'ca',
            rule: ['object-level actions apply to the object only; resource-level actions apply to every object of the resource (fe-administrator#2283: a new object took the resource-level list)'],
        }),
        async ({ signedIn: page, api, own, live, ownRaProfile }, testInfo) => {
            const ra = ownRaProfile;
            const role = await test.step('A fresh role for this check', async () => own.role('role-olp', { note: 'object-level permission check (fe-administrator#2283)' }));
            const liveRole = await test.step('Guard: the role is this run\'s own object (live check) before the UI changes it', async () => live('roles', role));
            const editor = new RolePermissionsPage(page);

            await test.step('RA Profiles: List, then add the run RA profile as an object', async () => {
                await editor.goToEditor(liveRole.uuid);
                await editor.openResource(editor.raProfilesResource);
                await editor.allowActions(['List']);
                await editor.addObject(ra.name);
            });

            await test.step('Allow Detail and Members on that object only', async () => {
                await editor.allowOnObject(ra.uuid, ['detail', 'members']);
                await testInfo.attach('object-row', { body: await editor.screenshot(), contentType: 'image/png' });
            });

            await test.step('Save: resource level keeps List only; the object carries Detail and Members', async () => {
                // The save returns before the stored state is read (a GET right after the request races it).
                const saved = await editor.save();
                await testInfo.attach('permissions-save-request.json', { body: saved.sentText, contentType: 'application/json' });
                expect(saved.answer.status, 'the permissions save').toBeLessThan(300);
                const sentRaProfiles = saved.sent.resources.find((r) => r.name === 'raProfiles')!;
                expect(sentRaProfiles.actions, 'resource-level RA profile actions (apply to all RA profiles)').toEqual(['list']);
                const sentObject = sentRaProfiles.objects!.find((o) => o.uuid === ra.uuid)!;
                expect(sentObject.allow).toEqual(expect.arrayContaining(['detail', 'members']));
                await expect
                    .poll(async () => {
                        const stored = await apiJson(api, 'GET', `/api/v1/roles/${liveRole.uuid}/permissions`);
                        return (stored.resources ?? []).find((r: { name: string }) => r.name === 'raProfiles')?.actions ?? null;
                    })
                    .toEqual(['list']);
                const stored = await apiJson(api, 'GET', `/api/v1/roles/${liveRole.uuid}/permissions`);
                const storedRaProfiles = stored.resources.find((r: { name: string }) => r.name === 'raProfiles');
                expect((storedRaProfiles.objects ?? []).map((o: { uuid: string }) => o.uuid)).toContain(ra.uuid);
            });
        });
});
