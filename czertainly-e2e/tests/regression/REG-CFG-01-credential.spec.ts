/**
 * REG-CFG-01 — a Basic credential created on the Credentials page (release checklist: Configuration 1): the credential
 * exists with kind Basic, its detail never shows the password, and the same name again is refused.
 * Create-only: the password is random per run and nothing is deleted.
 */
import { randomBytes } from 'node:crypto';
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { fillRequiredCustomAttributes, fillText, submitButtonOf } from '../../pages/ui/form';
import { dismissToasts, toast } from '../../pages/ui/toast';
import { toolbarButton } from '../../pages/ui/toolbar';
import { chooseOption } from '../../pages/ui/select';
import { apiJson } from '../../utils/regression/apiReads';
import { findByName } from '../../utils/regression/listReads';
import { nameFor, updateRunState } from '../../utils/regression/ledger/runState';
import { recordCreated } from '../../utils/regression/ledger/ledger';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-CFG-01';
const PROVIDER = process.env.REG_CREDENTIAL_CONNECTOR ?? 'Common-Credential-Connector';

test.describe('Credential configuration', { tag: tags.regression }, () => {
    test('a Basic credential created in the UI is stored, hides its password and refuses its name twice',
        testMeta({
            id: 'REG-CFG-01', prio: 'P1', issue: 'ilm#436',
            rule: [
                'release checklist Configuration 1: create a Basic credential on the Common Credential Connector',
                'a credential name is unique: a second create with the same name is refused ("already exists")',
            ],
        }),
        async ({ page, api, env }) => {
            const { name, becomesRunObject } = nameFor('credential', 'cred');
            // A random, run-scoped password: no password-like literal in the spec, nothing to leak or reuse.
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
                await submitButtonOf(dialog).click();
                await expect(dialog).toBeHidden();
                await expect.poll(async () => (await findByName(api, '/api/v1/credentials', name))?.uuid ?? '').not.toBe('');
                const created = (await findByName(api, '/api/v1/credentials', name))!;
                const own = recordCreated('credentials', { uuid: created.uuid, name }, SPEC);
                if (becomesRunObject) updateRunState({ credential: own });
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
                await submitButtonOf(dialog).click();
                await expect(toast(page, /already exist/i)).toBeVisible();
                const all = await apiJson<Array<{ name: string }>>(api, 'GET', '/api/v1/credentials');
                expect(all.filter((c) => c.name === name)).toHaveLength(1);
                await dismissToasts(page);
                if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
            });
        });
});
