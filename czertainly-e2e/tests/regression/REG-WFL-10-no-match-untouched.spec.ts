/**
 * REG-WFL-10 — a certificate that does not match is left untouched; Event History records "not satisfied" and the firing still ends
 * Finished (ilm#438 steps 10, 11; T14 W16, W29; TW20): an action trigger on the own RA profile whose rule is false for the
 * certificate (Common Name EQUALS a name nothing carries) and whose Set field would put it into a group.
 *
 *   the certificate has no group and no owner afterwards; its history row for the trigger is `conditionsMatched` false and
 *   `actionsPerformed` false with at least one record "Condition item '<…>' is false." (core#2326 prints the enum key in that
 *   text; the label is not asserted here: REG-WFL-11, P3); the scope's firing is Finished (never Failed for a false condition)
 *   with Obj. Evaluated 1 and Obj. Matched 0.
 * Own objects only: an own RA profile, group, trigger and certificate.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnGroup, createOwnRaProfileOrSkip, getCertificateDetail, groupUuidsOf, issueOwnCertificate } from '../../utils/regression/eventsDrivers';
import { RUN_ID } from '../../utils/regression/regressionRun';
import { associateTriggers, CERT_FIELD, conditionItem, createOwnChain, EVENT, setGroups, waitForFinishedFirings, waitForTriggerRows, getPlatformTriggerGate} from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-10';

test.describe('@regression REG-WFL-10 a certificate that does not match is untouched', () => {
    test('REG-WFL-10: the false condition is recorded, nothing is applied and the firing is Finished with evaluated 1, matched 0',
        meta({
            id: 'REG-WFL-10', prio: 'P1', issue: 'ilm#438',
            rule: ['T14 W16 (a failing condition is RECORDED, never thrown), W29 (a firing ends Finished; Failed only on an exception), W30 (counts); TW20', 'ilm#438 steps 10–11'],
        }),
        async ({ api }) => {
            test.setTimeout(480_000);
            const platformGate = await getPlatformTriggerGate(api, [EVENT.actionPerformed]);
            test.skip(platformGate !== undefined, platformGate ?? '');
            const ra = await createOwnRaProfileOrSkip(api, SPEC, 'wf10-ra', (reason) => test.skip(true, reason));
            const group = await createOwnGroup(api, SPEC, 'wf10-group');
            const chain = await createOwnChain(api, SPEC, {
                suffix: 'wf10', event: EVENT.actionPerformed, items: [conditionItem('property', CERT_FIELD.commonName, 'EQUALS', `${RUN_ID}-nothing-carries-this-name`)], executionItems: [setGroups([group.uuid])],
            });
            const sent = await associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'raProfiles', object: ra, triggers: [chain.trigger] });
            expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);

            const cert = await issueOwnCertificate(api, SPEC, ra, 'wf10-cert');

            const firings = await waitForFinishedFirings(api, { event: EVENT.actionPerformed, scope: { resource: 'raProfiles', objectUuid: ra.uuid } }, 1);
            expect(firings.totalItems).toBe(1);
            expect(firings.items[0], 'a false condition is no failure: Finished, evaluated 1, matched 0').toMatchObject({ status: 'finished', objectsEvaluated: 1, objectsMatched: 0, objectsIgnored: 0 });

            const row = (await waitForTriggerRows(api, 'certificates', cert.uuid, [chain.trigger.name])).find((r) => r.trigger.name === chain.trigger.name)!;
            expect({ matched: row.conditionsMatched, performed: row.actionsPerformed }, 'not satisfied: false / false').toEqual({ matched: false, performed: false });
            expect(row.records.length, 'at least one record names the false condition').toBeGreaterThanOrEqual(1);
            expect(row.records.some((r) => /Condition item '.*' is false\./.test(String(r.message ?? ''))), JSON.stringify(row.records.map((r) => r.message))).toBe(true);

            const detail = await getCertificateDetail(api, cert.uuid);
            expect(groupUuidsOf(detail), 'no group was set').toEqual([]);
            expect(detail.ownerUuid ?? detail.owner?.uuid ?? null, 'no owner was set').toBeNull();
        });
});
