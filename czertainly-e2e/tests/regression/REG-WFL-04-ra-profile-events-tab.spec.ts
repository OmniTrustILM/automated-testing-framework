/**
 * REG-WFL-04 — the Events tab of an OWN RA profile: associate two triggers on `Certificate action performed` through the UI;
 * reopening shows them in the chosen order; the Event select offers only the events an RA profile can override (ilm#438 step 14,
 * the association part; T14 W1, W4, W5).
 *
 * Oracles: the UI order equals the request order (A then B) and `GET /v1/workflows/events/raProfiles/{uuid}` returns the same
 * order; the Event select's options equal {Certificate validation status changed, action performed, expiring, not compliant,
 * registered} and contain none of uploaded, discovered, Discovery finished, Approval requested / closed, Scheduled job finished or
 * the comment events (W1: only those five name an RA profile as an overriding object).
 *
 * Own objects only: an own RA profile (the association hangs on it alone; platform level is never touched), two own triggers
 * (built with the API: this row is about the association UI). The association is recorded in the ledger before the UI replaces
 * the scope's list; the run-end teardown clears it before the triggers go.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { EventsAssociationWidget } from '../../pages/EventsAssociationWidget';
import { createOwnGroup, createOwnRaProfileOrSkip } from '../../utils/regression/eventsDrivers';
import { createOwnChain, EVENT, getAssociations, recordAssociation, setGroups } from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-04';

test.describe('@regression REG-WFL-04 association through the RA profile Events tab', () => {
    test('REG-WFL-04: two triggers associated in the UI are stored and shown in the chosen order; only the five RA-profile events are offered',
        meta({
            id: 'REG-WFL-04', prio: 'P1', issue: 'ilm#438',
            rule: ['T14 W1 (events an RA profile can override), W4 (association = replace), W5 (request order); ilm#438 step 14 (association part)'],
        }),
        async ({ page, api, env }) => {
            test.setTimeout(300_000);
            const ra = await createOwnRaProfileOrSkip(api, SPEC, 'wf04-ra', (reason) => test.skip(true, reason));
            const group = await createOwnGroup(api, SPEC, 'wf04-group');
            const a = await createOwnChain(api, SPEC, { suffix: 'wf04-a', event: EVENT.actionPerformed, executionItems: [setGroups([group.uuid])] });
            const b = await createOwnChain(api, SPEC, { suffix: 'wf04-b', event: EVENT.actionPerformed, executionItems: [setGroups([group.uuid])] });
            // Ledger before the UI replaces the scope's list: the teardown clears this association before it deletes the triggers.
            recordAssociation(EVENT.actionPerformed, 'raProfiles', ra, SPEC);

            await loginAsSmokeUser(page, env);
            const widget = await EventsAssociationWidget.openRaProfile(page, ra.authorityUuid, ra.uuid);

            await test.step('The Event select offers exactly the events an RA profile can override', async () => {
                await widget.openAssociateDialog();
                const offered = await widget.eventsOffered();
                expect([...offered].sort(), 'W1: status changed, action performed, expiring, not compliant, registered').toEqual(
                    [EVENT.statusChanged, EVENT.actionPerformed, EVENT.expiring, EVENT.notCompliant, EVENT.registered].sort(),
                );
                for (const not of [EVENT.uploaded, EVENT.discovered, EVENT.discoveryFinished, EVENT.approvalRequested, EVENT.approvalClosed, EVENT.scheduledJobFinished, EVENT.commentCreated, EVENT.commentResolved]) {
                    expect(offered, `${not} is not offered for an RA profile`).not.toContain(not);
                }
                await widget.dialog.getByRole('button', { name: 'Cancel' }).click();
                await expect(widget.dialog).toHaveCount(0);
            });

            await test.step('Associate A then B on Certificate action performed in the dialog', async () => {
                await widget.associate(EVENT.actionPerformed, [a.trigger.name, b.trigger.name]);
            });

            await test.step('The stored order is A then B (API) and the Events tab shows the same after a reload', async () => {
                expect((await getAssociations(api, 'raProfiles', ra.uuid))[EVENT.actionPerformed], 'API order = request order').toEqual([a.trigger.uuid, b.trigger.uuid]);
                await page.reload();
                const reopened = new EventsAssociationWidget(page);
                await expect(reopened.widget).toBeVisible();
                await reopened.assertAssociation(EVENT.actionPerformed, [a.trigger.uuid, b.trigger.uuid]);
            });
        });
});
