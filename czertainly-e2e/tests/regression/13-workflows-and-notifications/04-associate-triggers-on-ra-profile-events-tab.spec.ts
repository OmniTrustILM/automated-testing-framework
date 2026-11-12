/**
 * REG-WFL-04 — Triggers associated on an RA profile's Events tab. ilm#438.
 *
 * WHAT: 1. Open the Events tab of an own RA profile → the Event select offers exactly the five events an RA profile can override (status
 *          changed, action performed, expiring, not compliant, registered) and none of the platform-only events.
 *       2. Associate trigger A and then trigger B on `Certificate action performed` in the dialog → saved.
 *       3. The API returns the order A, B and, after a reload, the Events tab shows the same order.
 * WHY: association replaces the list and its order is the evaluation order, so the UI order must equal the request order
 *      and the stored one.
 * HOW: the association hangs on an own RA profile (the platform level is never touched) and is recorded in the ledger before the UI
 *      replaces the scope's list, so the teardown clears it before it deletes the triggers. Triggers and group are own objects; the
 *      test declares `needs: 'ca'`.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { AssociatedEventsWidget } from '../../../pages/AssociatedEventsWidget';
import { getAssociations, recordAssociation } from '../../../utils/regression/events/eventAssociations';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { createOwnChain, setGroupsAction } from '../../../utils/regression/events/workflowObjects';
import { testMeta, tags } from '../../../utils/regression/tags';
import { FORM_FLOW_MS } from '../../../utils/regression/timeouts';

test.describe('Association through the RA profile Events tab', { tag: tags.regression }, () => {
    test('two triggers associated in the UI keep their order, and only the five RA-profile events are offered',
        testMeta({
            id: 'REG-WFL-04', prio: 'P2', issue: 'ilm#438', needs: 'ca',
            rule: ['events an RA profile can override; association = replace; request order; ilm#438 step 14 (association part)'],
        }),
        async ({ signedIn: page, api, own, live }) => {
            test.setTimeout(FORM_FLOW_MS);
            const ra = await own.raProfile('wf04-ra');
            const group = await own.group('wf04-group');
            const a = await createOwnChain(api, own.spec, 'wf04-a', { event: EVENT.actionPerformed, executionItems: [setGroupsAction([group.uuid])] });
            const b = await createOwnChain(api, own.spec, 'wf04-b', { event: EVENT.actionPerformed, executionItems: [setGroupsAction([group.uuid])] });
            // Ledger before the UI replaces the scope's list: the teardown clears this association before it deletes the triggers.
            recordAssociation(EVENT.actionPerformed, 'raProfiles', ra, own.spec);

            await live('raProfiles', ra); // the Events tab of this own RA profile is changed in the browser
            await live('triggers', a.trigger);
            await live('triggers', b.trigger);
            const widget = await AssociatedEventsWidget.goToRaProfileEvents(page, ra.authorityUuid, ra.uuid);

            await test.step('The Event select offers exactly the events an RA profile can override', async () => {
                await widget.openAssociateDialog();
                const offered = await widget.offeredEvents();
                expect([...offered].sort(), 'offered events: status changed, action performed, expiring, not compliant, registered').toEqual(
                    [EVENT.statusChanged, EVENT.actionPerformed, EVENT.expiring, EVENT.notCompliant, EVENT.registered].sort(),
                );
                for (const not of [EVENT.uploaded, EVENT.discovered, EVENT.discoveryFinished, EVENT.approvalRequested, EVENT.approvalClosed, EVENT.scheduledJobFinished, EVENT.commentCreated, EVENT.commentResolved]) {
                    expect(offered, `${not} is not offered for an RA profile`).not.toContain(not);
                }
                await widget.cancelDialog();
            });

            await test.step('Associate A then B on Certificate action performed in the dialog', async () => {
                const saved = await widget.associateTriggers(EVENT.actionPerformed, [a.trigger.name, b.trigger.name]);
                expect(saved.status, `the association was stored: ${saved.text.slice(0, 300)}`).toBeLessThan(300);
            });

            await test.step('The stored order is A then B (API) and the Events tab shows the same after a reload', async () => {
                expect((await getAssociations(api, 'raProfiles', ra.uuid))[EVENT.actionPerformed], 'API order = request order').toEqual([a.trigger.uuid, b.trigger.uuid]);
                await page.reload();
                const reopened = new AssociatedEventsWidget(page);
                await expect(reopened.widget).toBeVisible();
                expect(await reopened.readTriggerCount(EVENT.actionPerformed), 'the Triggers Count of the event').toBe(2);
                expect(await reopened.readTriggerOrder(EVENT.actionPerformed), 'the Events tab shows the stored order A, B').toEqual([a.trigger.uuid, b.trigger.uuid]);
            });
        });
});
