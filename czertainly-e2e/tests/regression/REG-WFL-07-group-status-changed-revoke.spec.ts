/**
 * REG-WFL-07 — a trigger on `Certificate status changed` associated on an OWN GROUP fires when an own certificate of that group is
 * revoked (revoke raises the status change; ilm#438 step 16; T14 W34; TW16): the group scope has a firing Finished with Obj.
 * Evaluated 1 and Obj. Matched 1, the certificate's own history has the trigger row `true / true`, and the trigger's Set field
 * (custom attribute = a run marker) is visible on the certificate.
 *
 * Revoke is only the DRIVER here (the lifecycle area covers revoke itself). The certificate may also be validated later by the
 * platform and fire again, so the oracle is "at least one firing with evaluated 1 / matched 1", never an exact count. Own objects
 * only: an own RA profile (clone), group, custom attribute (not required), trigger and certificate. The UI half opens the
 * certificate's Event History tab and checks the trigger row's marks.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { EventHistoryWidget } from '../../pages/EventHistoryWidget';
import {
    createOwnCustomAttribute, createOwnGroup, createOwnRaProfileOrSkip, customAttributeValue, getCertificateDetail, issueOwnCertificate, revokeOwnCertificate, updateOwnCertificate,
} from '../../utils/regression/eventsDrivers';
import { associateTriggers, createOwnChain, EVENT, pollUntil, setCustomAttribute, waitForFinishedFirings, waitForTriggerRows, getPlatformTriggerGate} from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-07';

test.describe('@regression REG-WFL-07 group trigger on status changed (revoke)', () => {
    test('REG-WFL-07: revoking an own certificate of the group fires the Certificate status changed trigger of that group',
        meta({
            id: 'REG-WFL-07', prio: 'P1', issue: 'ilm#438',
            rule: ['T14 W34 (revoke raises Certificate status changed and action performed), W5 (group scope), W29–W30 (firing Finished, counts); TW16', 'ilm#438 step 16 (group-level trigger on status change)'],
        }),
        async ({ page, api, env }) => {
            test.setTimeout(480_000);
            const platformGate = await getPlatformTriggerGate(api, [EVENT.statusChanged, EVENT.actionPerformed]);
            test.skip(platformGate !== undefined, platformGate ?? '');
            const ra = await createOwnRaProfileOrSkip(api, SPEC, 'wf07-ra', (reason) => test.skip(true, reason));
            const group = await createOwnGroup(api, SPEC, 'wf07-g1');
            const attr = await createOwnCustomAttribute(api, SPEC, { suffix: 'wf07-mark', resources: ['certificates'] });
            const marker = `marker-${Date.now().toString(36)}`;
            const chain = await createOwnChain(api, SPEC, { suffix: 'wf07', event: EVENT.statusChanged, executionItems: [setCustomAttribute(attr.attributeName, 'STRING', marker)] });
            const sent = await associateTriggers(api, SPEC, { event: EVENT.statusChanged, resource: 'groups', object: group, triggers: [chain.trigger] });
            expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);

            const cert = await issueOwnCertificate(api, SPEC, ra, 'wf07-cert');
            const moved = await updateOwnCertificate(api, cert, { groupUuids: [group.uuid] });
            expect(moved.status, `put the certificate into the group: ${moved.text.slice(0, 200)}`).toBeLessThan(300);

            await test.step('Revoke the certificate (the driver)', async () => {
                const revoked = await revokeOwnCertificate(api, ra, cert);
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
                expect({ matched: row.conditionsMatched, performed: row.actionsPerformed, records: row.records }).toEqual({ matched: true, performed: true, records: [] });
                const value = await pollUntil(async () => customAttributeValue(await getCertificateDetail(api, cert.uuid), attr.attributeName), (v) => v === marker, { what: 'the marker on the certificate' });
                expect(value).toBe(marker);
            });

            await test.step('UI: the Event History tab of the certificate lists the trigger with met conditions and performed actions', async () => {
                await loginAsSmokeUser(page, env);
                const widget = await EventHistoryWidget.onTab(page, `/administrator/#/certificates/detail/${cert.uuid}`);
                expect(await widget.objectRowFlags(chain.trigger.name)).toEqual({ conditions: true, actions: true });
            });
        });
});
