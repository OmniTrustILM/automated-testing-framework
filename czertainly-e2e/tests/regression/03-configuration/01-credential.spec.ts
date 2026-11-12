/**
 * REG-CFG-01 — A Basic credential created on the Credentials page (release checklist: Configuration 1). ilm#436.
 *
 * WHAT: 1. Credentials → + → Create Credential: name, the Common Credential Connector, kind Basic, user name and password.
 *       2. Create → the credential exists with kind Basic.
 *       3. Detail → the credential is shown and the password appears nowhere, neither on the page nor in the API detail.
 *       4. The same name again → refused ("already exists"); exactly one credential has that name.
 * WHY: credentials hold secrets used by connectors; the password must never come back and a name must be unique.
 * HOW: create-only: the password is random per run and nothing is deleted. The create answer is put in the ledger (`own.record`)
 *      before the dialog or the list is waited for; a duplicate the platform accepted is recorded too, so the test then fails on
 *      it. It is a credential of its own: no later spec reads it.
 */
import { randomBytes } from 'node:crypto';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { CredentialPage } from '../../../pages/CredentialPage';
import { readCredential } from '../../../utils/regression/inventory/credentialsApi';
import { findByName, rowsNamed } from '../../../utils/regression/listReads';
import { ownName } from '../../../utils/regression/ledger/runState';
import { lookupInList, submitRecordingByNameOnFailure } from '../../../utils/regression/ledger/uiCreates';
import { testMeta, tags } from '../../../utils/regression/tags';

test.describe('Credential configuration', { tag: tags.regression }, () => {
    test('a Basic credential created in the UI is stored, hides its password and refuses its name twice',
        testMeta({
            id: 'REG-CFG-01', prio: 'P1', issue: 'ilm#436',
            rule: [
                'create a Basic credential on the Common Credential Connector',
                'a credential name is unique: a second create with the same name is refused ("already exists")',
            ],
        }),
        async ({ signedIn: page, api, own, regressionEnv }) => {
            const name = ownName('cred');
            // A random, run-scoped password: no password-like literal in the spec, nothing to leak or reuse.
            const password = `qa-${randomBytes(12).toString('base64url')}`;
            const credentials = new CredentialPage(page);
            const form = { name, connectorName: regressionEnv.credentialConnector, username: 'qa-reg-user', password };
            const lookup = lookupInList(api, '/api/v1/credentials');

            await test.step('Credentials list → Create Credential dialog → Basic kind fields', async () => {
                await credentials.goToList();
                await credentials.openCreateDialog();
                await credentials.fillBasicForm(form);
            });

            const uuid = await test.step('Create → the credential exists', async () => {
                const answer = await submitRecordingByNameOnFailure({ type: 'credentials', name, spec: own.spec, lookup }, () => credentials.submitCreateForm());
                // Ledger before assertion: from the create answer, before the dialog or the list is waited for.
                const created = own.record('credentials', answer, { name });
                await expect(credentials.createDialog.dialog).toBeHidden();
                await expect.poll(async () => (await findByName(api, '/api/v1/credentials', name))?.uuid ?? '').not.toBe('');
                expect((await findByName(api, '/api/v1/credentials', name))!.kind).toBe('Basic');
                return created.uuid;
            });

            await test.step('Detail page shows the credential; the password is not shown in clear', async () => {
                await credentials.goToDetail(uuid);
                await credentials.assertDetailShows(name);
                await credentials.assertNotShown(password);
                const detail = await readCredential(api, uuid);
                expect(detail.status, 'GET the credential').toBe(200);
                expect(JSON.stringify(detail.json), 'the API detail never carries the password').not.toContain(password);
            });

            await test.step('Negative: the same name again is refused', async () => {
                const note = 'duplicate credential the platform accepted';
                await credentials.goToList();
                await credentials.openCreateDialog();
                await credentials.fillBasicForm(form);
                const again = await submitRecordingByNameOnFailure({ type: 'credentials', name, spec: own.spec, note, lookup }, () => credentials.submitCreateForm());
                // A duplicate the platform accepted is this run's object too; the assertions below then fail. The answer may carry no id:
                // the rows of the name are adopted from the list as well.
                own.probe('credentials', again, { name, note });
                await own.adoptNamed('credentials', name, { note });
                await credentials.assertDuplicateNameRefused();
                expect(await rowsNamed(api, '/api/v1/credentials', name), 'exactly one credential has that name').toHaveLength(1);
                await credentials.closeCreateDialog();
            });
        });
});
