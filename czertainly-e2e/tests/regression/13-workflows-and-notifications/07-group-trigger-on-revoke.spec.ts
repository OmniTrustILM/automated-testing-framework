/**
 * REG-WFL-07 — A group trigger fires when a certificate of the group is revoked. ilm#438.
 * The status change comes from a validation that sees the revoke only through an OCSP or CRL URL: skips on a CA without one.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { EventHistoryWidget } from '../../../pages/EventHistoryWidget';
import { customAttributeValue } from '../../../utils/regression/customAttributes';
import { BLIND_REVOKE_SKIP, eventCertificate, getCertificateDetail, revokeOwnCertificateAndWait, updateOwnCertificate, validateRevoked } from '../../../utils/regression/events/workflowFixtures';
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
            rule: [
                'ilm#438 step 4: revoke a certificate in G1 → its Certificate status changed trigger fires; group scope; firing Finished, counts',
                'a revoke raises Certificate action performed, not status changed: the validation status changes only when OCSP or CRL reports the revocation (core#576; ilm#438 step 4 note)',
            ],
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

            const seen = await test.step('Validate the certificate, as its detail page does: the status changes to revoked', async () => validateRevoked(api, cert));
            test.skip(seen.blind, BLIND_REVOKE_SKIP);
            expect(seen.status, 'the validation status of the revoked certificate').toBe('revoked');

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
                const widget = new EventHistoryWidget(page);
                await widget.goToCertificateHistory(cert.uuid);
                expect(await widget.readObjectRowFlags(chain.trigger.name), 'the Event History tab marks the trigger met and performed').toEqual({ conditions: true, actions: true });
            });
        });
});
