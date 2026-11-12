/**
 * REG-WFL-06 — Control: an RA profile without an association fires nothing. ilm#438.
 *
 * WHAT: 1. Own RA profile A with a trigger (Set field Groups = G) associated on `Certificate action performed`; own RA profile B with none.
 *       2. Issue an own certificate on B, then on A.
 *       3. Positive marker: A's scope shows its finished firing (1 evaluated, 1 matched) and A's certificate is in the group.
 *       4. Control: B's certificate has no group and no owner, B's scope has no firing, and A's trigger never evaluated B's certificate.
 * WHY: object-level triggers apply to the objects of their scope only; the absence on B is meaningful only after a positive marker on the
 *      same asynchronous pipeline, so "no firing on B" is not a race.
 * HOW: own objects only: two RA profiles, one group, one trigger, two certificates; the certificates are deleted by the run-end teardown.
 *      The test declares `needs: 'ca'` and skips with the reason when a platform-level trigger already listens on the event.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { groupUuidsOf } from '../../../utils/regression/ownGroups';
import { getCertificateDetail, eventCertificate } from '../../../utils/regression/events/workflowFixtures';
import { associateTriggers } from '../../../utils/regression/events/eventAssociations';
import { getFirings, getObjectHistory, waitForFinishedFirings } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { createOwnChain, setGroupsAction } from '../../../utils/regression/events/workflowObjects';
import { testMeta, tags } from '../../../utils/regression/tags';
import { SLOW_LIFECYCLE_MS } from '../../../utils/regression/timeouts';

test.describe('RA profile without association: control', { tag: tags.regression }, () => {
    test('an issue on an RA profile without association changes nothing and fires nothing',
        testMeta({
            id: 'REG-WFL-06', prio: 'P2', issue: 'ilm#438', needs: 'ca',
            rule: ['object-level triggers apply to the objects of their scope only; ilm#438 step 15 (control)', 'absence needs a positive marker on the same pipeline'],
        }),
        async ({ api, own, needs }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            await needs.platformTriggersFree(EVENT.actionPerformed);
            const raA = await own.raProfile('wf06-a');
            const raB = await own.raProfile('wf06-b');
            const group = await own.group('wf06-group');
            const chain = await createOwnChain(api, own.spec, 'wf06', { event: EVENT.actionPerformed, executionItems: [setGroupsAction([group.uuid])] });
            const assoc = await associateTriggers(api, own.spec, { event: EVENT.actionPerformed, resource: 'raProfiles', object: raA, triggers: [chain.trigger] });
            expect(assoc.status, assoc.text.slice(0, 300)).toBeLessThan(300);

            const certB = await own.certificate.issue(raB, eventCertificate('wf06-c-b'));
            const certA = await own.certificate.issue(raA, eventCertificate('wf06-c-a'));

            await test.step('Positive marker: the associated RA profile A shows its firing and its certificate is in the group', async () => {
                const page = await waitForFinishedFirings(api, { event: EVENT.actionPerformed, scope: { resource: 'raProfiles', objectUuid: raA.uuid } }, 1);
                expect(page.items[0], 'the firing of A finished with 1 evaluated and 1 matched').toMatchObject({ status: 'finished', objectsEvaluated: 1, objectsMatched: 1 });
                expect(groupUuidsOf(await getCertificateDetail(api, certA.uuid)), 'the certificate of A is in the group').toEqual([group.uuid]);
            });

            await test.step('Control: B\'s certificate has no group and no owner, B\'s scope has no firing, the certificate has no trigger row', async () => {
                const detail = await getCertificateDetail(api, certB.uuid);
                expect(groupUuidsOf(detail), 'no group').toEqual([]);
                expect(detail.ownerUuid ?? detail.owner?.uuid ?? null, 'no owner').toBeNull();
                const firings = await getFirings(api, { event: EVENT.actionPerformed, scope: { resource: 'raProfiles', objectUuid: raB.uuid } });
                expect(firings.status, 'the firings of B can be read').toBe(200);
                expect(firings.page?.totalItems, 'no firing in the scope of B').toBe(0);
                expect((await getObjectHistory(api, 'certificates', certB.uuid)).rows.filter((r) => r.trigger.uuid === chain.trigger.uuid), 'the trigger of A never evaluated B\'s certificate').toEqual([]);
            });
        });
});
