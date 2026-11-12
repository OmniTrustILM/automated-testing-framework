/**
 * REG-WFL-10 — A certificate that does not match is left untouched. ilm#438, core#2326.
 *
 * WHAT: 1. An action trigger on an own RA profile has a rule that is false for the certificate (Common Name equals a name nothing carries)
 *          and a Set field that would put it into a group.
 *       2. Issue an own certificate → the scope's firing is finished with 1 object evaluated, 0 matched, 0 ignored.
 *       3. The certificate's history row is `conditionsMatched` false and `actionsPerformed` false with a record "Condition item '…' is
 *          false." (core#2326: the record prints the enum key; the label is not asserted).
 *       4. The certificate has no group and no owner.
 * WHY: a failing condition is recorded, never thrown; a firing ends Finished, and Failed only on an exception.
 * HOW: own objects only (RA profile, group, trigger, certificate), recorded before any assertion; the test declares `needs: 'ca'` and skips
 *      with the reason when a platform-level trigger already listens on the event. The firing is asynchronous, so reads poll API state.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { groupUuidsOf } from '../../../utils/regression/ownGroups';
import { getCertificateDetail, eventCertificate } from '../../../utils/regression/events/workflowFixtures';
import { runId } from '../../../utils/regression/ledger/runState';
import { associateTriggers } from '../../../utils/regression/events/eventAssociations';
import { waitForFinishedFirings, waitForTriggerRows } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { CERT_FIELD, conditionItem, createOwnChain, setGroupsAction } from '../../../utils/regression/events/workflowObjects';
import { testMeta, tags } from '../../../utils/regression/tags';
import { SLOW_LIFECYCLE_MS } from '../../../utils/regression/timeouts';

test.describe('A certificate that does not match is untouched', { tag: tags.regression }, () => {
    test('a false condition is recorded, nothing is applied, the firing is Finished (evaluated 1, matched 0)',
        testMeta({
            id: 'REG-WFL-10', prio: 'P2', issue: 'ilm#438', needs: 'ca',
            rule: ['a failing condition is RECORDED, never thrown; a firing ends Finished, Failed only on an exception; the counts are recorded', 'ilm#438 steps 10–11'],
        }),
        async ({ api, own, needs }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            await needs.platformTriggersFree(EVENT.actionPerformed);
            const { ra, chain } = await test.step('Own RA profile and a trigger whose condition matches nothing, associated on it', async () => {
                const ra = await own.raProfile('wf10-ra');
                const group = await own.group('wf10-group');
                const chain = await createOwnChain(api, own.spec, 'wf10', { event: EVENT.actionPerformed, items: [conditionItem('property', CERT_FIELD.commonName, 'EQUALS', `${runId()}-nothing-carries-this-name`)], executionItems: [setGroupsAction([group.uuid])] });
                const sent = await associateTriggers(api, own.spec, { event: EVENT.actionPerformed, resource: 'raProfiles', object: ra, triggers: [chain.trigger] });
                expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
                return { ra, chain };
            });

            const cert = await test.step('An issue fires once: the firing is Finished, evaluated 1, matched 0', async () => {
                const cert = await own.certificate.issue(ra, eventCertificate('wf10-cert'));

                const firings = await waitForFinishedFirings(api, { event: EVENT.actionPerformed, scope: { resource: 'raProfiles', objectUuid: ra.uuid } }, 1);
                expect(firings.totalItems, 'exactly one firing in the scope').toBe(1);
                expect(firings.items[0], 'a false condition is no failure: Finished, evaluated 1, matched 0').toMatchObject({ status: 'finished', objectsEvaluated: 1, objectsMatched: 0, objectsIgnored: 0 });
                return cert;
            });

            await test.step('The trigger row records the false condition; no group and no owner were set', async () => {
                const row = (await waitForTriggerRows(api, 'certificates', cert.uuid, [chain.trigger.name])).find((r) => r.trigger.name === chain.trigger.name)!;
                expect({ matched: row.conditionsMatched, performed: row.actionsPerformed }, 'not satisfied: false / false').toEqual({ matched: false, performed: false });
                expect(row.records.length, 'at least one record names the false condition').toBeGreaterThanOrEqual(1);
                expect(row.records.some((r) => /Condition item '.*' is false\./.test(String(r.message ?? ''))), JSON.stringify(row.records.map((r) => r.message))).toBe(true);

                const detail = await getCertificateDetail(api, cert.uuid);
                expect(groupUuidsOf(detail), 'no group was set').toEqual([]);
                expect(detail.ownerUuid ?? detail.owner?.uuid ?? null, 'no owner was set').toBeNull();
            });
        });
});
