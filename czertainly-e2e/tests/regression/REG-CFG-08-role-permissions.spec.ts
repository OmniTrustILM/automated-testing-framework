/**
 * REG-CFG-08 — role permissions in the permissions editor (release checklist: Configuration 8): the run role gets
 * Certificates List / Detail / Create / Issue and RA Profiles List, which the API and the reloaded editor show; an
 * object-level permission (Detail and Members on one RA profile) stays on that object and is not granted on every RA
 * profile (fe-administrator#2283, fixed; guarded against its return). Create-only: only this suite's roles change.
 */
import { Page } from '@playwright/test';
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { submitButtonOf } from '../../pages/ui/form';
import { apiJson } from '../../utils/regression/apiReads';
import { createRole, ensureRunRole } from '../../utils/regression/ownRoles';
import { recordCreated } from '../../utils/regression/ledger/ledger';
import { runName } from '../../utils/regression/ledger/runState';
import { actAndWaitForApi, UUID } from '../../pages/ui/waitForResponse';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-CFG-08';

const editor = (page: Page) => {
    const main = page.locator('main');
    return {
        main,
        resource: (label: string) => main.getByRole('button').filter({ has: page.getByText(label, { exact: true }) }).first(),
        action: (label: string) => main.getByLabel(label, { exact: true }).first(),
    };
};

const CERT_ACTIONS = ['List', 'Detail', 'Create', 'Issue'];

test.describe('Role permissions', { tag: tags.regression }, () => {
    test('certificate and RA profile permissions saved in the editor are stored and shown after reload',
        testMeta({
            id: 'REG-CFG-08', prio: 'P1', issue: 'ilm#427',
            rule: ['release checklist Configuration 8: grant Certificates (List, Detail, Create, Issue) and RA Profiles (List) to the role; the API and the editor agree after a reload'],
        }),
        async ({ page, api, env }, testInfo) => {
            const role = await test.step('Prerequisite: the run role', async () => ensureRunRole(api, SPEC));
            const { main, resource, action } = editor(page);

            await test.step('Open the permissions editor', async () => {
                await loginAsSmokeUser(page, env);
                await page.goto(`administrator/#/roles/permissions/${role.uuid}`);
                await expect(resource('Certificates')).toBeVisible();
                await expect(page.locator('[id="allResources"]')).not.toBeChecked();
            });

            await test.step(`Certificates: ${CERT_ACTIONS.join(', ')}`, async () => {
                await resource('Certificates').click();
                for (const a of CERT_ACTIONS) await action(a).check({ force: true });
                for (const a of CERT_ACTIONS) await expect(action(a)).toBeChecked();
            });

            await test.step('RA Profiles: List', async () => {
                await resource('Ra Profiles').or(resource('RA Profiles')).first().click();
                await action('List').check({ force: true });
                await expect(action('List')).toBeChecked();
            });

            await test.step('Save → the API returns the configured permissions', async () => {
                await submitButtonOf(main).click();
                await expect
                    .poll(async () => {
                        const perms = await apiJson(api, 'GET', `/api/v1/roles/${role.uuid}/permissions`);
                        return (perms.resources?.find((r: { name: string }) => r.name === 'certificates')?.actions ?? []).slice().sort().join(',');
                    })
                    .toBe('create,detail,issue,list');
                const perms = await apiJson(api, 'GET', `/api/v1/roles/${role.uuid}/permissions`);
                expect(perms.allowAllResources).toBe(false);
                expect(perms.resources.find((r: { name: string }) => r.name === 'raProfiles')?.actions).toContain('list');
                await testInfo.attach('permissions.json', { body: JSON.stringify(perms, null, 2), contentType: 'application/json' });
            });

            await test.step('Reload: the editor shows the saved permissions', async () => {
                await page.goto(`administrator/#/roles/permissions/${role.uuid}`);
                await resource('Certificates').click();
                for (const a of CERT_ACTIONS) await expect(action(a)).toBeChecked();
            });
        });

    test('an object-level permission stays on its object and is not granted on every RA profile',
        testMeta({
            id: 'REG-CFG-08', prio: 'P1', issue: 'ilm#427',
            rule: ['object-level actions apply to the object only; resource-level actions apply to every object of the resource (fe-administrator#2283: a new object took the resource-level list)'],
        }),
        async ({ page, api, env, ownRaProfile }, testInfo) => {
            const ra = ownRaProfile;
            const role = await test.step('A fresh role for this check', async () => {
                const ref = await createRole(api, runName(`role-olp-${Date.now().toString(36)}`));
                recordCreated('roles', ref, SPEC, 'object-level permission check (fe-administrator#2283)');
                return ref;
            });
            const { main, resource, action } = editor(page);

            await test.step('RA Profiles: List, then add the run RA profile as an object', async () => {
                await loginAsSmokeUser(page, env);
                await page.goto(`administrator/#/roles/permissions/${role.uuid}`);
                await resource('Ra Profiles').or(resource('RA Profiles')).first().click();
                await action('List').check({ force: true });
                const objectsHeading = main.getByRole('heading', { name: 'Object Action Permissions' });
                await objectsHeading.locator('..').locator('button:has(svg.lucide-plus)').first().click(); // "Add object" (icon only)
                const dialog = page.getByRole('dialog', { name: 'Edit Object Level Permissions' });
                await expect(dialog).toBeVisible();
                await dialog.locator('tr', { has: page.getByRole('cell', { name: ra.name, exact: true }) }).getByRole('checkbox').check({ force: true });
                await dialog.getByRole('button', { name: 'Save', exact: true }).click();
                await expect(dialog).toBeHidden();
            });

            await test.step('Allow Detail and Members on that object only', async () => {
                // Each object checkbox sits in a wrapper button that stops click propagation: click the input itself.
                for (const a of ['detail', 'members']) {
                    const box = page.locator(`[id="${ra.uuid}_${a}"]`);
                    if (!(await box.isChecked())) await box.dispatchEvent('click');
                    await expect(box).toBeChecked();
                }
                await testInfo.attach('object-row', { body: await page.screenshot(), contentType: 'image/png' });
            });

            await test.step('Save: resource level keeps List only; the object carries Detail and Members', async () => {
                // Wait for the save to complete before reading the stored state (a GET right after the request races it).
                const saveResponse = await actAndWaitForApi(page, { method: (m) => m !== 'GET', path: new RegExp(`/api/v1/roles/${UUID}/permissions`) }, () => submitButtonOf(main).click());
                const sent = saveResponse.request();
                await testInfo.attach('permissions-save-request.json', { body: sent.postData() ?? '', contentType: 'application/json' });
                const body = JSON.parse(sent.postData() ?? '{}');
                const ras = body.resources.find((r: { name: string }) => r.name === 'raProfiles');
                expect(ras.actions, 'resource-level RA profile actions (apply to all RA profiles)').toEqual(['list']);
                const obj = ras.objects.find((o: { uuid: string }) => o.uuid === ra.uuid);
                expect(obj.allow).toEqual(expect.arrayContaining(['detail', 'members']));
                await expect
                    .poll(async () => {
                        const p = await apiJson(api, 'GET', `/api/v1/roles/${role.uuid}/permissions`);
                        return (p.resources ?? []).find((r: { name: string }) => r.name === 'raProfiles')?.actions ?? null;
                    })
                    .toEqual(['list']);
                const stored = await apiJson(api, 'GET', `/api/v1/roles/${role.uuid}/permissions`);
                const storedRas = stored.resources.find((r: { name: string }) => r.name === 'raProfiles');
                expect((storedRas.objects ?? []).map((o: { uuid: string }) => o.uuid)).toContain(ra.uuid);
            });
        });
});
