/**
 * REG-WFL-09 — Set field effects of a fired trigger. ilm#438, ilm#115.
 *
 * WHAT: One test per row, each with its own RA profile and certificate; an issue fires the triggers associated on the RA profile and then
 *       the certificate shows exactly the value the trigger set:
 *       1. Groups {G0} → {Gx}: the second Set field replaces the set.
 *       2. Groups {G0} → {}: an empty list removes every group.
 *       3. Owner → the own user.
 *       4. RA profile → a second own RA profile.
 *       5. A custom attribute holds the value. Every trigger row reports conditions met and actions performed with no record.
 * WHY: Set field of a certificate is the effect operators rely on (ilm#115 UC1); Groups replaces the set and an empty list clears it.
 * HOW: one issue on the own RA profile fires the triggers (it raises `Certificate action performed`); a Set field of the RA profile on a
 *      revoked certificate would be refused for an unrelated reason. The effect is polled until it is committed with the trigger
 *      transaction. Own objects only, recorded before any assertion; every row declares `needs: 'ca'` and skips with the reason when a
 *      platform-level trigger already listens on the event.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { customAttributeValue } from '../../../utils/regression/customAttributes';
import { groupUuidsOf } from '../../../utils/regression/ownGroups';
import { getCertificateDetail, eventCertificate } from '../../../utils/regression/events/workflowFixtures';
import { associateTriggers } from '../../../utils/regression/events/eventAssociations';
import { inEvaluationOrder, waitForFinishedFirings, waitForTriggerRows } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { createOwnChain, ExecutionItem, setCustomAttributeAction, setGroupsAction, setOwnerAction, setRaProfileAction } from '../../../utils/regression/events/workflowObjects';
import { testMeta, tags } from '../../../utils/regression/tags';
import { SLOW_LIFECYCLE_MS, TRIGGER_EFFECT_WAIT_MS } from '../../../utils/regression/timeouts';

test.describe('Set field effects', { tag: tags.regression }, () => {
    type Json = Record<string, any>;
    interface Row {
        key: string;
        what: string;
        /** The first trigger puts the certificate into G0 (rows that start from {G0}). */
        withG0: boolean;
        /** Builds the Set field item of the trigger under test from the row's own objects. */
        item: (o: { g0: { uuid: string }; gx: { uuid: string }; user: { uuid: string }; raB?: { uuid: string }; attr: { attributeName: string } }) => ExecutionItem;
        /** The expectation on the certificate detail. */
        check: (detail: Json, o: { g0: { uuid: string }; gx: { uuid: string }; user: { uuid: string }; raB?: { uuid: string }; attr: { attributeName: string } }) => void;
        needsRaB?: boolean;
    }
    const rows: Row[] = [
        { key: 'group', what: 'replaces the certificate\'s groups with the new one', withG0: true, item: (o) => setGroupsAction([o.gx.uuid]), check: (d, o) => expect(groupUuidsOf(d), 'Groups REPLACES the set: {Gx}, not {G0, Gx}').toEqual([o.gx.uuid]) },
        { key: 'clear', what: 'with an empty Groups list removes every group', withG0: true, item: () => setGroupsAction([]), check: (d) => expect(groupUuidsOf(d), 'an empty list removes every group').toEqual([]) },
        { key: 'owner', what: 'sets the certificate\'s owner', withG0: false, item: (o) => setOwnerAction(o.user.uuid), check: (d, o) => expect(d.ownerUuid ?? d.owner?.uuid, 'the owner is the own user').toBe(o.user.uuid) },
        { key: 'ra', what: 'switches the certificate to the other RA profile', withG0: false, needsRaB: true, item: (o) => setRaProfileAction(o.raB!.uuid), check: (d, o) => expect(d.raProfile?.uuid, 'the RA profile was switched to B').toBe(o.raB!.uuid) },
        { key: 'custom', what: 'sets the certificate\'s custom attribute value', withG0: false, item: (o) => setCustomAttributeAction(o.attr.attributeName, 'STRING', 'v'), check: (d, o) => expect(customAttributeValue(d, o.attr.attributeName)).toBe('v') },
    ];

    for (const row of rows) {
        test(`a fired Set field action ${row.what}`,
            testMeta({
                id: 'REG-WFL-09', row: row.what, prio: 'P2', issue: 'ilm#438', needs: 'ca',
                rule: ['Set field on a certificate: RA profile, Groups REPLACES the set, null / empty removes all, Owner; ilm#115 UC1; custom attribute content via the execution item', `table row ${row.key}`],
            }),
            async ({ api, own, needs }) => {
                test.setTimeout(SLOW_LIFECYCLE_MS);
                await needs.platformTriggersFree(EVENT.actionPerformed);
                const { objects, triggers, ra } = await test.step('Own RA profile(s), groups, user and attribute; the trigger(s) of the row associated on the RA profile', async () => {
                    const ra = await own.raProfile(`wf09-ra-${row.key}`);
                    const raB = row.needsRaB ? await own.raProfile(`wf09-rab-${row.key}`) : undefined;
                    const g0 = await own.group(`wf09-g0-${row.key}`);
                    const gx = await own.group(`wf09-gx-${row.key}`);
                    const user = await own.user(`wf09-user-${row.key}`);
                    const attr = await own.customAttribute(`wf09-attr-${row.key}`, { resources: ['certificates'] });
                    const objects = { g0, gx, user, ...(raB ? { raB } : {}), attr };

                    const triggers: Awaited<ReturnType<typeof createOwnChain>>[] = [];
                    if (row.withG0) triggers.push(await createOwnChain(api, own.spec, `wf09-${row.key}-0`, { event: EVENT.actionPerformed, executionItems: [setGroupsAction([g0.uuid])] }));
                    triggers.push(await createOwnChain(api, own.spec, `wf09-${row.key}-t`, { event: EVENT.actionPerformed, executionItems: [row.item(objects)] }));
                    const sent = await associateTriggers(api, own.spec, { event: EVENT.actionPerformed, resource: 'raProfiles', object: ra, triggers: triggers.map((t) => t.trigger) });
                    expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
                    return { objects, triggers, ra };
                });

                const cert = await test.step('An issue fires the triggers once; each reports conditions met and actions performed', async () => {
                    const cert = await own.certificate.issue(ra, eventCertificate(`w9-${row.key}`));
                    await waitForFinishedFirings(api, { event: EVENT.actionPerformed, scope: { resource: 'raProfiles', objectUuid: ra.uuid } }, 1);
                    const history = await waitForTriggerRows(api, 'certificates', cert.uuid, triggers.map((t) => t.trigger.name));
                    const mine = inEvaluationOrder(history.filter((h) => triggers.some((t) => t.trigger.name === h.trigger.name)));
                    for (const r of mine) expect({ matched: r.conditionsMatched, performed: r.actionsPerformed, records: r.records.map((x) => x.message) }, `${r.trigger.name}`).toEqual({ matched: true, performed: true, records: [] });
                    return cert;
                });

                await test.step('The certificate shows exactly the value the trigger set', async () => {
                    // The effect is committed with the trigger transaction: read it (polled once the last trigger row exists).
                    await expect(async () => row.check(await getCertificateDetail(api, cert.uuid), objects), `the ${row.key} effect on the certificate`).toPass({ timeout: TRIGGER_EFFECT_WAIT_MS });
                });
            });
    }
});
