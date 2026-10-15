/**
 * REG-CFG-08 — Configure role permission (release checklist: Configuration 8).
 *
 * Test 1 (the checklist flow): the run's role → permissions editor (#/roles/permissions/<uuid>) → resource
 * Certificates: List, Detail, Create, Issue → resource RA Profiles: List → Save → the API and the reloaded editor
 * show exactly that.
 *
 * Test 2 (object scope): a fresh role → RA Profiles: List at resource level, plus one RA profile as an object
 * ("Add object" → Edit Object Level Permissions) with Detail and Members allowed on that object only → Save →
 * the request must keep Detail / Members on the object, not on every RA profile.
 * W-11 = fe-administrator#2283 (found 2026-10-08, filed 2026-10-09, fixed by fe-administrator#2305 on 2026-10-13): a new
 * object's `allow` list was the resource-level `actions` array itself, so ticks on the object were also granted on all
 * RA profiles. The second test guards against its return.
 *
 * Create-only: only roles created by this suite are changed; nothing is deleted.
 */
import { Page } from '@playwright/test';
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { submitButton } from '../../pages/RegressionUi';
import { apiJson, createRole, ensureRaProfileOrSkip, ensureRole } from '../../utils/regression/regressionApi';
import { recordCreated, regName } from '../../utils/regression/regressionRun';

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

test.describe('@regression REG-CFG-08 role permissions', () => {
    test('grant certificate and RA-profile permissions to the run role', async ({ page, api, env }, testInfo) => {
        const role = await test.step('Prerequisite: the run role', async () => ensureRole(api, SPEC));
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
            await submitButton(main).click();
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

    test('object-level permission stays on the object (W-11)', async ({ page, api, env }, testInfo) => {
        const ra = await test.step('Prerequisite: the run RA profile (CA-agnostic; no CA: a skip naming the deploy gate)', async () => ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason)));
        const role = await test.step('A fresh role for this check', async () => {
            const ref = await createRole(api, regName(`role-olp-${Date.now().toString(36)}`));
            recordCreated('roles', ref, SPEC, 'object-level permission check (W-11)');
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
            const saveResponse = page.waitForResponse((r) => /\/api\/v1\/roles\/[0-9a-f-]{36}\/permissions/.test(r.url()) && r.request().method() !== 'GET');
            await submitButton(main).click();
            const sent = (await saveResponse).request();
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
