/**
 * REG-CFG-02 — Create MS ADCS CA (release checklist: Configuration 2).
 *
 * Flow: Authorities → "+" → add page → provider MS-ADCS-NG-Connector → CA selection method "Enter CA host and
 * name manually" → CA host / CA name (read at runtime from an existing NG authority; never stored in the repo) →
 * Create → the connector checks connectivity → detail page; the authority is `connected`.
 * Create-only: the source authority is only read; nothing is deleted.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { chooseOption, fillRequiredCustomAttributes, fillText, submitButton, toolbarButton } from '../../pages/RegressionUi';
import { adcsBlocker, apiJson, findAdcsSource } from '../../utils/regression/regressionApi';
import { nameFor, recordCreated, updateState } from '../../utils/regression/regressionRun';

const SPEC = 'REG-CFG-02';

test.describe('@regression REG-CFG-02 MS ADCS authority', () => {
    test('create an MS ADCS (NG) authority through the UI', async ({ page, api, env }) => {
        // B1: a connected MS ADCS authority whose connector answers its LIVE health (adcsBlocker); else the named
        // environment blocker (deploy gate, never a pass) and the CA-agnostic run RA profile takes over (ensureRaProfile).
        const blocker = await adcsBlocker(api);
        test.skip(!!blocker, blocker ?? '');
        const source = await test.step('Read the CA of an existing MS ADCS NG authority (read-only)', async () => findAdcsSource(api));
        const { name, becomesRunObject } = nameFor('authority', 'adcs');
        const main = page.locator('main');

        await test.step('Authorities → "+" → add page', async () => {
            await loginAsSmokeUser(page, env);
            await page.goto('administrator/#/authorities');
            await toolbarButton(page, 'plus').click();
            await expect(page).toHaveURL(/\/authorities\/add/);
        });

        await test.step(`Provider ${source.connectorName} → manual CA host and name`, async () => {
            await fillText(main.getByTestId('text-input-name'), name);
            await chooseOption(page, page.getByTestId('select-authorityProviderSelect-trigger'), source.connectorName);
            await chooseOption(page, page.getByTestId('select-__attributes__authority__.data_caSelectMethodSelect-trigger'), 'Enter CA host and name manually');
            const host = main.getByTestId('text-input-__attributes__authority__.data_caHost').or(main.getByLabel(/^CA host/)).first();
            const caName = main.getByTestId('text-input-__attributes__authority__.data_caName').or(main.getByLabel(/^CA name/)).first();
            await fillText(host, source.caHost);
            await fillText(caName, source.caName);
            await fillRequiredCustomAttributes(page, main, 'qa-reg');
        });

        const uuid = await test.step('Create → connectivity check passes → detail page', async () => {
            await submitButton(main).click();
            await expect(page).toHaveURL(/\/authorities\/detail\/[0-9a-f-]{36}/, { timeout: 90_000 });
            const id = /authorities\/detail\/([0-9a-f-]{36})/.exec(page.url())![1];
            const own = recordCreated('authorities', { uuid: id, name }, SPEC, `CA copied from ${source.name}`);
            if (becomesRunObject) updateState({ authority: own });
            await expect(main).toContainText(name);
            return id;
        });

        await test.step('API: connected, on the NG connector', async () => {
            const detail = await apiJson(api, 'GET', `/api/v1/authorities/${uuid}`);
            expect(detail.status).toBe('connected');
            expect(detail.connectorName).toBe(source.connectorName);
        });
    });
});
