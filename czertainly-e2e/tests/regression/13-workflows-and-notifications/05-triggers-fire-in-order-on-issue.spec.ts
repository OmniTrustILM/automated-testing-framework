/**
 * REG-WFL-05 — Two triggers on an RA profile run in request order on issue. ilm#438.
 *
 * WHAT: 1. Associate trigger A (Set field Groups = G1) and then trigger B (Groups = G2) on `Certificate action performed` of
 *          an own RA profile.
 *       2. Issue an own certificate on the RA profile → the profile scope has exactly one firing: finished, 1 evaluated, 1 matched.
 *       3. Both trigger rows are true / true and A was evaluated before B.
 *       4. The certificate is in G2 only: a Set field of Groups replaces the set.
 *       5. The certificate's Event History tab shows both triggers with met conditions and performed actions; the UI read adds no firing.
 * WHY: triggers run in request order per scope, and an issue raises `Certificate action performed`; the last Set field wins.
 * HOW: the firing is asynchronous, so every read polls API state. Own objects only: an RA profile cloned from the first healthy CA (`needs:
 *      'ca'`), two groups, two triggers and one certificate (revoked and deleted by the run-end teardown). Skips with the reason when a
 *      platform-level trigger already listens on the event.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { EventHistoryWidget } from '../../../pages/EventHistoryWidget';
import { groupUuidsOf } from '../../../utils/regression/ownGroups';
import { getCertificateDetail, eventCertificate } from '../../../utils/regression/events/workflowFixtures';
import { associateTriggers } from '../../../utils/regression/events/eventAssociations';
import { getFirings, inEvaluationOrder, waitForFinishedFirings, waitForTriggerRows } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { createOwnChain, setGroupsAction } from '../../../utils/regression/events/workflowObjects';
import { pollUntil } from '../../../utils/regression/wait';
import { testMeta, tags } from '../../../utils/regression/tags';
import { SLOW_LIFECYCLE_MS } from '../../../utils/regression/timeouts';

test.describe('Trigger order on issue', { tag: tags.regression }, () => {
    test('two triggers run in request order on issue: the certificate ends in G2 and its history lists both',
        testMeta({
            id: 'REG-WFL-05', prio: 'P2', issue: 'ilm#438', needs: 'ca',
            rule: [
                'triggers run in request order, per scope; Set field Groups REPLACES the set; issue raises Certificate action performed',
                'ilm#438 step 14 (the effect): issue on the RA profile, the certificate lands in the last group',
            ],
        }),
        async ({ signedIn: page, api, own, needs }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            await needs.platformTriggersFree(EVENT.actionPerformed);
            const ra = await own.raProfile('wf05-ra');
            const g1 = await own.group('wf05-g1');
            const g2 = await own.group('wf05-g2');
            const a = await createOwnChain(api, own.spec, 'wf05-a', { event: EVENT.actionPerformed, executionItems: [setGroupsAction([g1.uuid])] });
            const b = await createOwnChain(api, own.spec, 'wf05-b', { event: EVENT.actionPerformed, executionItems: [setGroupsAction([g2.uuid])] });
            const scope = { resource: 'raProfiles' as const, objectUuid: ra.uuid };

            await test.step('Associate A then B on the RA profile (event Certificate action performed), request order', async () => {
                const sent = await associateTriggers(api, own.spec, { event: EVENT.actionPerformed, resource: 'raProfiles', object: ra, triggers: [a.trigger, b.trigger] });
                expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
            });

            const cert = await test.step('Issue an own certificate on the RA profile', async () => own.certificate.issue(ra, eventCertificate('wf05-cert')));

            await test.step('The RA profile scope has one firing: Finished, evaluated 1, matched 1 (the firing is asynchronous: polled)', async () => {
                const page1 = await waitForFinishedFirings(api, { event: EVENT.actionPerformed, scope }, 1);
                expect(page1.totalItems, 'exactly one firing of Certificate action performed in the scope').toBe(1);
                expect(page1.items[0]).toMatchObject({ status: 'finished', objectsEvaluated: 1, objectsMatched: 1, objectsIgnored: 0 });
            });

            await test.step('Both trigger rows are true / true and A was evaluated before B', async () => {
                const rows = await waitForTriggerRows(api, 'certificates', cert.uuid, [a.trigger.name, b.trigger.name]);
                const mine = inEvaluationOrder(rows.filter((r) => [a.trigger.name, b.trigger.name].includes(r.trigger.name)));
                expect(mine.map((r) => r.trigger.name), 'evaluation order = request order').toEqual([a.trigger.name, b.trigger.name]);
                for (const r of mine) expect({ matched: r.conditionsMatched, performed: r.actionsPerformed }, `${r.trigger.name}`).toEqual({ matched: true, performed: true });
            });

            await test.step('The certificate is in G2 only (the second Set field replaced the first)', async () => {
                const groups = await pollUntil(async () => groupUuidsOf(await getCertificateDetail(api, cert.uuid)), (g) => g.length === 1 && g[0] === g2.uuid, { what: 'certificate groups = {G2}' });
                expect(groups).toEqual([g2.uuid]);
            });

            await test.step('UI: the certificate\'s Event History tab shows both triggers with met conditions and performed actions', async () => {
                const widget = await EventHistoryWidget.goToObjectHistory(page, `/administrator/#/certificates/detail/${cert.uuid}`);
                await expect(widget.rows.first()).toBeVisible();
                for (const t of [a.trigger, b.trigger]) expect(await widget.readObjectRowFlags(t.name), `${t.name} in the UI`).toEqual({ conditions: true, actions: true });
                const recheck = await getFirings(api, { event: EVENT.actionPerformed, scope });
                expect(recheck.page?.totalItems, 'the UI read added no firing').toBe(1);
            });
        });
});
