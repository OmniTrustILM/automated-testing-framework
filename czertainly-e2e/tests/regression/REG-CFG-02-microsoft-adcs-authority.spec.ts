/**
 * REG-CFG-02 — an MS ADCS authority created through the UI (release checklist: Configuration 2): provider
 * MS-ADCS-NG-Connector with the CA host and name entered by hand (read at run time from an existing NG authority, never
 * stored here); the connector checks connectivity and the authority is connected. Create-only: the source is only read.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { fillRequiredCustomAttributes, fillText, submitButtonOf } from '../../pages/ui/form';
import { toolbarButton } from '../../pages/ui/toolbar';
import { chooseOption } from '../../pages/ui/select';
import { apiJson } from '../../utils/regression/apiReads';
import { adcsBlocker, findAdcsSource } from '../../utils/regression/config/authorities';
import { nameFor, updateRunState } from '../../utils/regression/ledger/runState';
import { recordCreated } from '../../utils/regression/ledger/ledger';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-CFG-02';

test.describe('MS ADCS authority configuration', { tag: tags.regression }, () => {
    test('an MS ADCS authority created in the UI with a manual CA host and name is connected',
        testMeta({
            id: 'REG-CFG-02', prio: 'P1', issue: 'ilm#436',
            rule: ['release checklist Configuration 2: an MS ADCS authority on the MS-ADCS-NG-Connector, CA host and name entered manually; the connector checks connectivity on create'],
        }),
        async ({ page, api, env }) => {
            // Needs a connected MS ADCS authority whose connector answers its LIVE health (adcsBlocker); else the named
            // environment blocker (deploy gate, never a pass) and the CA-agnostic run RA profile takes over.
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
                await submitButtonOf(main).click();
                await expect(page).toHaveURL(/\/authorities\/detail\/[0-9a-f-]{36}/, { timeout: 90_000 });
                const id = /authorities\/detail\/([0-9a-f-]{36})/.exec(page.url())![1];
                const own = recordCreated('authorities', { uuid: id, name }, SPEC, `CA copied from ${source.name}`);
                if (becomesRunObject) updateRunState({ authority: own });
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
