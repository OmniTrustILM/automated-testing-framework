/**
 * REG-WFL-07 — A group trigger fires when a certificate of the group is revoked. ilm#438.
 *
 * WHAT: 1. A trigger on `Certificate status changed` (Set field: a custom attribute = a run marker) is associated on an own group.
 *       2. An own certificate is put into the group and revoked.
 *       3. The group scope has a finished firing with 1 object evaluated and 1 matched.
 *       4. The certificate's own history has the trigger row true / true, and the marker is on the certificate.
 *       5. The certificate's Event History tab lists the trigger with met conditions and performed actions.
 * WHY: a revoke raises the status change and the action performed events; a group-level trigger must act on the certificates of its group.
 * HOW: the revoke only starts the event: the platform may validate the certificate later and fire again, so the oracle is "at least one
 *      firing", never an exact count. Own objects only (RA profile clone, group, attribute, trigger, certificate), recorded before any
 *      assertion; the test declares `needs: 'ca'` and skips with the reason when a platform-level trigger already listens on the events.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { EventHistoryWidget } from '../../../pages/EventHistoryWidget';
import { customAttributeValue } from '../../../utils/regression/customAttributes';
import { getCertificateDetail, revokeOwnCertificateAndWait, updateOwnCertificate, eventCertificate } from '../../../utils/regression/events/workflowFixtures';
import { associateTriggers } from '../../../utils/regression/events/eventAssociations';
import { waitForFinishedFirings, waitForTriggerRows } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { createOwnChain, setCustomAttributeAction } from '../../../utils/regression/events/workflowObjects';
import { pollUntil } from '../../../utils/regression/wait';
import { testMeta, tags } from '../../../utils/regression/tags';
import { SLOW_LIFECYCLE_MS } from '../../../utils/regression/timeouts';
import { uniqueSuffix } from '../../../utils/regression/text';

test.describe('Group trigger on status changed (revoke)', { tag: tags.regression }, () => {
    test('revoking an own certificate of the group fires the Certificate status changed trigger of that group',
        testMeta({
            id: 'REG-WFL-07', prio: 'P2', issue: 'ilm#438', needs: 'ca',
            rule: ['revoke raises Certificate status changed and action performed; group scope; firing Finished, counts', 'ilm#438 step 16 (group-level trigger on status change)'],
        }),
        async ({ signedIn: page, api, own, needs }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            await needs.platformTriggersFree(EVENT.statusChanged, EVENT.actionPerformed);
            const ra = await own.raProfile('wf07-ra');
            const group = await own.group('wf07-g1');
            const attr = await own.customAttribute('wf07-mark', { resources: ['certificates'] });
            const marker = `marker-${uniqueSuffix()}`;
            const chain = await createOwnChain(api, own.spec, 'wf07', { event: EVENT.statusChanged, executionItems: [setCustomAttributeAction(attr.attributeName, 'STRING', marker)] });
            const sent = await associateTriggers(api, own.spec, { event: EVENT.statusChanged, resource: 'groups', object: group, triggers: [chain.trigger] });
            expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);

            const cert = await own.certificate.issue(ra, eventCertificate('wf07-cert'));
            const moved = await updateOwnCertificate(api, cert, { groupUuids: [group.uuid] });
            expect(moved.status, `put the certificate into the group: ${moved.text.slice(0, 200)}`).toBeLessThan(300);

            await test.step('Revoke the certificate', async () => {
                const revoked = await revokeOwnCertificateAndWait(api, ra, cert);
                expect(revoked.status, revoked.text.slice(0, 300)).toBeLessThan(300);
            });

            await test.step('The group scope has a finished firing of Certificate status changed with evaluated 1 and matched 1', async () => {
                const firings = await waitForFinishedFirings(api, { event: EVENT.statusChanged, scope: { resource: 'groups', objectUuid: group.uuid } }, 1);
                const hit = firings.items.find((f) => f.status === 'finished' && f.objectsEvaluated === 1 && f.objectsMatched === 1);
                expect(hit, `a finished firing with evaluated 1 / matched 1 among ${JSON.stringify(firings.items.map((f) => [f.status, f.objectsEvaluated, f.objectsMatched]))}`).toBeTruthy();
            });

            await test.step('The certificate\'s own history has the trigger row true / true and the Set field marker is on the certificate', async () => {
                const rows = await waitForTriggerRows(api, 'certificates', cert.uuid, [chain.trigger.name]);
                const row = rows.find((r) => r.trigger.name === chain.trigger.name)!;
                expect({ matched: row.conditionsMatched, performed: row.actionsPerformed, records: row.records }, 'the trigger row is true / true with no record').toEqual({ matched: true, performed: true, records: [] });
                const value = await pollUntil(async () => customAttributeValue(await getCertificateDetail(api, cert.uuid), attr.attributeName), (v) => v === marker, { what: 'the marker on the certificate' });
                expect(value, 'the Set field marker is on the certificate').toBe(marker);
            });

            await test.step('UI: the Event History tab of the certificate lists the trigger with met conditions and performed actions', async () => {
                const widget = await EventHistoryWidget.goToObjectHistory(page, `/administrator/#/certificates/detail/${cert.uuid}`);
                expect(await widget.readObjectRowFlags(chain.trigger.name), 'the Event History tab marks the trigger met and performed').toEqual({ conditions: true, actions: true });
            });
        });
});
