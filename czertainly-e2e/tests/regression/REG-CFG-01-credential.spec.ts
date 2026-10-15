/**
 * REG-CFG-01 — Create basic credentials (release checklist: Configuration 1).
 *
 * Flow: Credentials → "+" → Create Credential → name, provider Common-Credential-Connector, kind Basic →
 * Username / Password appear → Create → the credential exists (API) and its detail page shows it.
 * Negative: the same name again is refused. Create-only: nothing is deleted.
 */
import { randomBytes } from 'node:crypto';
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { chooseOption, dismissToasts, fillRequiredCustomAttributes, fillText, submitButton, toast, toolbarButton } from '../../pages/RegressionUi';
import { apiJson, findByName } from '../../utils/regression/regressionApi';
import { nameFor, recordCreated, updateState } from '../../utils/regression/regressionRun';

const SPEC = 'REG-CFG-01';
const PROVIDER = process.env.REG_CREDENTIAL_CONNECTOR ?? 'Common-Credential-Connector';

test.describe('@regression REG-CFG-01 credential', () => {
    test('create a Basic credential through the UI', async ({ page, api, env }) => {
        const { name, becomesRunObject } = nameFor('credential', 'cred');
        // A random, run-scoped password (merge item 8): no password-like literal in the spec, nothing to leak or reuse.
        const credentialPassword = `qa-${randomBytes(12).toString('base64url')}`;
        const dialog = page.getByRole('dialog', { name: 'Create Credential' });

        const fillForm = async () => {
            await toolbarButton(page, 'plus').click();
            await expect(dialog).toBeVisible();
            await fillText(dialog.getByTestId('text-input-name'), name);
            await chooseOption(page, page.getByTestId('select-credentialProviderSelect-trigger'), PROVIDER);
            await chooseOption(page, page.getByTestId('select-storeKindSelect-trigger'), 'Basic');
            const username = dialog.locator('input[id$=".username"]');
            const password = dialog.locator('input[id$=".password"]');
            await expect(username).toBeVisible();
            await fillText(username, 'qa-reg-user');
            await fillText(password, credentialPassword);
            await fillRequiredCustomAttributes(page, dialog, 'qa-reg');
        };

        await test.step('Credentials list → Create Credential dialog → Basic kind fields', async () => {
            await loginAsSmokeUser(page, env);
            await page.goto('administrator/#/credentials');
            await fillForm();
        });

        const uuid = await test.step('Create → the credential exists', async () => {
            await submitButton(dialog).click();
            await expect(dialog).toBeHidden();
            await expect.poll(async () => (await findByName(api, '/api/v1/credentials', name))?.uuid ?? '').not.toBe('');
            const created = (await findByName(api, '/api/v1/credentials', name))!;
            const own = recordCreated('credentials', { uuid: created.uuid, name }, SPEC);
            if (becomesRunObject) updateState({ credential: own });
            expect(created.kind).toBe('Basic');
            return created.uuid as string;
        });

        await test.step('Detail page shows the credential; the password is not shown in clear', async () => {
            await page.goto(`administrator/#/credentials/detail/${uuid}`);
            await expect(page.locator('main')).toContainText(name);
            await expect(page.locator('main')).not.toContainText(credentialPassword);
            const detail = await apiJson(api, 'GET', `/api/v1/credentials/${uuid}`);
            expect(JSON.stringify(detail)).not.toContain(credentialPassword);
        });

        await test.step('Negative: the same name again is refused', async () => {
            await page.goto('administrator/#/credentials');
            await fillForm();
            await submitButton(dialog).click();
            await expect(toast(page, /already exist/i)).toBeVisible();
            const all = await apiJson<Array<{ name: string }>>(api, 'GET', '/api/v1/credentials');
            expect(all.filter((c) => c.name === name)).toHaveLength(1);
            await dismissToasts(page);
            if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        });
    });
});
