/**
 * REG-WFL-06 — control: an issue on a second own RA profile B that carries NO association leaves the certificate untouched and B's
 * scope has no firing (ilm#438 step 15; T14 W5). The absence is asserted only AFTER a positive marker (guard 3, T14 0.1): a
 * second issue on RA profile A, whose trigger is associated, shows its firing, so "no firing on B" is not a race with the
 * asynchronous pipeline.
 *
 * Own objects only: two own RA profiles, one own group, one own trigger (Set field Groups = G) associated on A, two own
 * certificates.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnGroup, createOwnRaProfileOrSkip, getCertificateDetail, groupUuidsOf, issueOwnCertificate } from '../../utils/regression/eventsDrivers';
import { associateTriggers, createOwnChain, EVENT, getFirings, getObjectHistory, setGroups, waitForFinishedFirings, getPlatformTriggerGate} from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-06';

test.describe('@regression REG-WFL-06 RA profile without association: control', () => {
    test('REG-WFL-06: an issue on an RA profile without association changes nothing and fires nothing (after the marker on the associated one)',
        meta({
            id: 'REG-WFL-06', prio: 'P1', issue: 'ilm#438',
            rule: ['T14 W5 (object-level triggers apply to the objects of their scope only); ilm#438 step 15 (control)', 'T14 0.1 guard 3 (absence needs a positive marker on the same pipeline)'],
        }),
        async ({ api }) => {
            test.setTimeout(480_000);
            const platformGate = await getPlatformTriggerGate(api, [EVENT.actionPerformed]);
            test.skip(platformGate !== undefined, platformGate ?? '');
            const raA = await createOwnRaProfileOrSkip(api, SPEC, 'wf06-a', (reason) => test.skip(true, reason));
            const raB = await createOwnRaProfileOrSkip(api, SPEC, 'wf06-b', (reason) => test.skip(true, reason));
            const group = await createOwnGroup(api, SPEC, 'wf06-group');
            const chain = await createOwnChain(api, SPEC, { suffix: 'wf06', event: EVENT.actionPerformed, executionItems: [setGroups([group.uuid])] });
            const assoc = await associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'raProfiles', object: raA, triggers: [chain.trigger] });
            expect(assoc.status, assoc.text.slice(0, 300)).toBeLessThan(300);

            const certB = await issueOwnCertificate(api, SPEC, raB, 'wf06-cert-b');
            const certA = await issueOwnCertificate(api, SPEC, raA, 'wf06-cert-a');

            await test.step('Positive marker: the associated RA profile A shows its firing and its certificate is in the group', async () => {
                const page = await waitForFinishedFirings(api, { event: EVENT.actionPerformed, scope: { resource: 'raProfiles', objectUuid: raA.uuid } }, 1);
                expect(page.items[0]).toMatchObject({ status: 'finished', objectsEvaluated: 1, objectsMatched: 1 });
                expect(groupUuidsOf(await getCertificateDetail(api, certA.uuid))).toEqual([group.uuid]);
            });

            await test.step('Control: B\'s certificate has no group and no owner, B\'s scope has no firing, the certificate has no trigger row', async () => {
                const detail = await getCertificateDetail(api, certB.uuid);
                expect(groupUuidsOf(detail), 'no group').toEqual([]);
                expect(detail.ownerUuid ?? detail.owner?.uuid ?? null, 'no owner').toBeNull();
                const firings = await getFirings(api, { event: EVENT.actionPerformed, scope: { resource: 'raProfiles', objectUuid: raB.uuid } });
                expect(firings.status).toBe(200);
                expect(firings.page?.totalItems, 'no firing in the scope of B').toBe(0);
                expect((await getObjectHistory(api, 'certificates', certB.uuid)).rows.filter((r) => r.trigger.uuid === chain.trigger.uuid), 'the trigger of A never evaluated B\'s certificate').toEqual([]);
            });
        });
});
