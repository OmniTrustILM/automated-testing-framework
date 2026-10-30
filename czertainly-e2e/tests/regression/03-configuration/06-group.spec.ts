/**
 * REG-CFG-06 — A certificate group created through the UI (release checklist: Configuration 6; ilm#428).
 *
 * Creates the group, checks it exists with that e-mail, and that the detail tabs Users, Events and Event History open without
 * an error. The same name again is refused, and exactly one group has that name.
 *
 * Create-only: nothing is deleted. The create answer is put in the ledger before the dialog or the list is waited for; a
 * duplicate the platform accepted is recorded too, so the test then fails on it.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { GroupPage } from '../../../pages/GroupPage';
import { findByName, rowsNamed } from '../../../utils/regression/listReads';
import { ownName } from '../../../utils/regression/ledger/runState';
import { lookupInList, submitRecordingByNameOnFailure } from '../../../utils/regression/ledger/uiCreates';
import { testMeta, tags } from '../../../utils/regression/tags';

test.describe('Certificate group configuration', { tag: tags.regression }, () => {
    test('a group created in the UI is stored with its e-mail, its tabs open and its name is refused twice',
        testMeta({
            id: 'REG-CFG-06', prio: 'P1', issue: 'ilm#428',
            rule: ['create a certificate group; a group name is unique (a second create is refused, "already exists")'],
        }),
        async ({ signedIn: page, api, own }) => {
            const name = ownName('group');
            const groups = new GroupPage(page);
            const form = { name, description: 'Main-functionality regression group', email: `${name}@example.test` };
            const lookup = lookupInList(api, '/api/v1/groups');

            await test.step('Groups → "+" → Create Group', async () => {
                await groups.goToList();
                await groups.openCreateDialog();
                await groups.fillCreateForm(form);
            });

            const uuid = await test.step('Create → the group exists', async () => {
                const answer = await submitRecordingByNameOnFailure({ type: 'groups', name, spec: own.spec, lookup }, () => groups.submitCreateForm());
                // Ledger before assertion: from the create answer, before the dialog or the list is waited for.
                const created = own.record('groups', answer, { name });
                await expect(groups.createDialog.dialog).toBeHidden();
                await expect.poll(async () => (await findByName(api, '/api/v1/groups', name))?.uuid ?? '').not.toBe('');
                expect((await findByName(api, '/api/v1/groups', name))!.email).toBe(form.email);
                return created.uuid;
            });

            await test.step('Detail page and its tabs', async () => {
                await groups.goToDetail(uuid);
                await groups.assertDetailShows(name);
                for (const tab of ['Users', 'Events', 'Event History'] as const) {
                    await groups.openTab(tab);
                    await groups.assertNoErrorShown(tab);
                }
            });

            await test.step('Negative: the same name again is refused', async () => {
                const note = 'duplicate group the platform accepted';
                await groups.goToList();
                await groups.openCreateDialog();
                await groups.fillCreateForm(form);
                const again = await submitRecordingByNameOnFailure({ type: 'groups', name, spec: own.spec, note, lookup }, () => groups.submitCreateForm());
                // A duplicate the platform accepted is this run's object too; the assertions below then fail. The answer may carry no id:
                // the rows of the name are adopted from the list as well.
                own.probe('groups', again, { name, note });
                await own.adoptNamed('groups', name, { note });
                await groups.assertDuplicateNameRefused();
                expect(await rowsNamed(api, '/api/v1/groups', name), 'exactly one group has that name').toHaveLength(1);
                await groups.closeCreateDialog();
            });
        });
});
