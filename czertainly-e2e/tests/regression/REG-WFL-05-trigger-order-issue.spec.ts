/**
 * REG-WFL-05 — two triggers on an OWN RA profile run in request order on `Certificate action performed`: issue on the RA profile,
 * trigger A (Set field Groups = G1) then trigger B (Groups = G2): the certificate ends in G2 only (a Set field of Groups REPLACES
 * the set, request order) and its Event History shows both rows in that order (ilm#438 step 14, the effect; T14 W5, W18; TW14).
 *
 * Oracles (T14): certificate groups = {G2}; the certificate's own history has a row per trigger, both `conditionsMatched` and
 * `actionsPerformed`, A evaluated before B; the RA profile scope has ONE firing, Finished, Obj. Evaluated 1, Obj. Matched 1.
 * The firing is asynchronous (JMS): every read polls API state. The UI half opens the certificate's Event History tab (the RA
 * profile detail has no Event History widget) and checks both trigger rows with their Conditions / Actions marks.
 *
 * Own objects only: an own RA profile (a clone of an enabled RA profile of the first healthy CA; no healthy CA → the deploy-gate
 * skip), two own groups, two triggers, one own certificate (revoked and deleted by the run-end teardown).
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { EventHistoryWidget } from '../../pages/EventHistoryWidget';
import { createOwnGroup, createOwnRaProfileOrSkip, getCertificateDetail, groupUuidsOf, issueOwnCertificate } from '../../utils/regression/eventsDrivers';
import {
    associateTriggers, createOwnChain, EVENT, getFirings, inEvaluationOrder, pollUntil, setGroups, waitForFinishedFirings, waitForTriggerRows, getPlatformTriggerGate,
} from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-05';

test.describe('@regression REG-WFL-05 trigger order on issue', () => {
    test('REG-WFL-05: issue on the own RA profile runs trigger A then trigger B; the certificate ends in G2 only and the history shows both rows in order',
        meta({
            id: 'REG-WFL-05', prio: 'P1', issue: 'ilm#438',
            rule: [
                'T14 W5 (triggers run in request order; per scope), W18 (Set field Groups REPLACES the set), W34 (issue raises Certificate action performed); TW14',
                'ilm#438 step 14 (the effect): issue on the RA profile, the certificate lands in the last group',
            ],
        }),
        async ({ page, api, env }) => {
            test.setTimeout(480_000);
            const platformGate = await getPlatformTriggerGate(api, [EVENT.actionPerformed]);
            test.skip(platformGate !== undefined, platformGate ?? '');
            const ra = await createOwnRaProfileOrSkip(api, SPEC, 'wf05-ra', (reason) => test.skip(true, reason));
            const g1 = await createOwnGroup(api, SPEC, 'wf05-g1');
            const g2 = await createOwnGroup(api, SPEC, 'wf05-g2');
            const a = await createOwnChain(api, SPEC, { suffix: 'wf05-a', event: EVENT.actionPerformed, executionItems: [setGroups([g1.uuid])] });
            const b = await createOwnChain(api, SPEC, { suffix: 'wf05-b', event: EVENT.actionPerformed, executionItems: [setGroups([g2.uuid])] });
            const scope = { resource: 'raProfiles' as const, objectUuid: ra.uuid };

            await test.step('Associate A then B on the RA profile (event Certificate action performed), request order', async () => {
                const sent = await associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'raProfiles', object: ra, triggers: [a.trigger, b.trigger] });
                expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
            });

            const cert = await test.step('Issue an own certificate on the RA profile (issued within 180 s)', async () => issueOwnCertificate(api, SPEC, ra, 'wf05-cert'));

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
                await loginAsSmokeUser(page, env);
                const widget = await EventHistoryWidget.onTab(page, `/administrator/#/certificates/detail/${cert.uuid}`);
                await expect(widget.rows.first()).toBeVisible();
                for (const t of [a.trigger, b.trigger]) expect(await widget.objectRowFlags(t.name), `${t.name} in the UI`).toEqual({ conditions: true, actions: true });
                const recheck = await getFirings(api, { event: EVENT.actionPerformed, scope });
                expect(recheck.page?.totalItems, 'the UI read added no firing').toBe(1);
            });
        });
});
