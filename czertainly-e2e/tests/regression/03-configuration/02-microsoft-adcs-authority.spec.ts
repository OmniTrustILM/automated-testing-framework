/**
 * REG-CFG-02 — An MS ADCS authority created through the UI (release checklist: Configuration 2; ilm#436).
 *
 * Creates the authority on the MS-ADCS-NG-Connector, waits for the connectivity check (up to 90 s), and checks that the API
 * shows it connected.
 *
 * Create-only. The CA host and name are read at run time from an existing NG authority (only read), never stored in the
 * repository. Needs a connected MS ADCS authority whose connector answers its live health; otherwise it skips with the named
 * blocker, never a pass. The create answer is put in the ledger before the redirect is waited for.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { AuthorityPage } from '../../../pages/AuthorityPage';
import { adcsBlocker, findAdcsSource } from '../../../utils/regression/config/authorities';
import { ownName } from '../../../utils/regression/ledger/runState';
import { lookupInList, submitRecordingByNameOnFailure } from '../../../utils/regression/ledger/uiCreates';
import { apiJson } from '../../../utils/regression/apiReads';
import { testMeta, tags } from '../../../utils/regression/tags';

test.describe('MS ADCS authority configuration', { tag: tags.regression }, () => {
    test('an MS ADCS authority created in the UI with a manual CA host and name is connected',
        testMeta({
            id: 'REG-CFG-02', prio: 'P1', issue: 'ilm#436',
            rule: ['an MS ADCS authority on the MS-ADCS-NG-Connector, CA host and name entered manually; the connector checks connectivity on create'],
        }),
        async ({ signedIn: page, api, own }) => {
            // Needs a connected MS ADCS authority whose connector answers its LIVE health (adcsBlocker); else the named
            // environment blocker (deploy gate, never a pass) and the CA-agnostic run RA profile takes over. Reads only, before any create.
            const blocker = await adcsBlocker(api);
            test.skip(!!blocker, blocker ?? '');
            const source = await test.step('Read the CA of an existing MS ADCS NG authority (read-only)', async () => findAdcsSource(api));
            const name = ownName('adcs');
            const authorities = new AuthorityPage(page);

            await test.step('Authorities → "+" → add page', async () => {
                await authorities.goToList();
                await authorities.openAddPage();
            });

            await test.step(`Provider ${source.connectorName} → manual CA host and name`, async () => {
                await authorities.fillManualCaForm({ name, connectorName: source.connectorName, caHost: source.caHost, caName: source.caName });
            });

            const uuid = await test.step('Create → connectivity check passes → detail page', async () => {
                // The create answer comes after the connector's connectivity check (up to 90 s).
                const answer = await submitRecordingByNameOnFailure(
                    { type: 'authorities', name, spec: own.spec, note: `CA copied from ${source.name}`, lookup: lookupInList(api, '/api/v1/authorities') },
                    () => authorities.submitCreateForm());
                // Ledger before assertion: from the create answer, before the redirect is waited for.
                const created = own.record('authorities', answer, { name, note: `CA copied from ${source.name}` });
                await authorities.waitForDetail();
                await authorities.assertDetailShows(name);
                return created.uuid;
            });

            await test.step('API: connected, on the NG connector', async () => {
                const detail = await apiJson(api, 'GET', `/api/v1/authorities/${uuid}`);
                expect(detail.status).toBe('connected');
                expect(detail.connectorName).toBe(source.connectorName);
            });
        });
});
