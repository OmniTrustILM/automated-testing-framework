/**
 * REG-WFL-09 — Set field effects on a fired object-level trigger (ilm#438 step 9, the object-level analogue; T14 W18; ilm#115 UC1;
 * P-09): after the firing the certificate shows EXACTLY the value the trigger set.
 *
 *   group   {G0} → {Gx}   the second Set field REPLACES the set (G0 was put there by a first trigger of the same scope)
 *   clear   {G0} → {}     data `[]` removes every group
 *   owner   → X           the owner is the own user X
 *   ra      → B           the RA profile is switched to the second own RA profile B (no identify attributes: T14 W18)
 *   custom  → v           the custom attribute holds the value
 * Driver: one issue on the own RA profile A fires the triggers associated on it for `Certificate action performed` (the plan's
 * data column fires them by a revoke on a group scope; a Set field of the RA profile on a REVOKED certificate would be refused for
 * a reason unrelated to the rule, so the issue is the driver of every row). Each row is its own test with its own RA profile
 * and certificate (an association is a replace-all of its scope). Own objects only.
 */
import { expect, test } from '../../fixtures/testFixtures';
import {
    createOwnCustomAttribute, createOwnGroup, createOwnRaProfile, createOwnRaProfileOrSkip, customAttributeValue, getCertificateDetail, groupUuidsOf, issueOwnCertificate,
} from '../../utils/regression/eventsDrivers';
import { createOwnUser } from '../../utils/regression/regressionApi';
import {
    associateTriggers, createOwnChain, EVENT, ExecutionItem, inEvaluationOrder, pollUntil, setCustomAttribute, setGroups, setOwner, setRaProfile, waitForFinishedFirings, waitForTriggerRows, getPlatformTriggerGate,
} from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-09';

test.describe('@regression REG-WFL-09 Set field effects', () => {
    type Json = Record<string, any>;
    interface Row {
        key: string;
        /** The first trigger puts the certificate into G0 (rows that start from {G0}). */
        withG0: boolean;
        /** Builds the Set field item of the trigger under test from the row's own objects. */
        item: (o: { g0: { uuid: string }; gx: { uuid: string }; user: { uuid: string }; raB?: { uuid: string }; attr: { attributeName: string } }) => ExecutionItem;
        /** The expectation on the certificate detail. */
        check: (detail: Json, o: { g0: { uuid: string }; gx: { uuid: string }; user: { uuid: string }; raB?: { uuid: string }; attr: { attributeName: string } }) => void;
        needsRaB?: boolean;
    }
    const rows: Row[] = [
        { key: 'group', withG0: true, item: (o) => setGroups([o.gx.uuid]), check: (d, o) => expect(groupUuidsOf(d), 'Groups REPLACES the set: {Gx}, not {G0, Gx}').toEqual([o.gx.uuid]) },
        { key: 'clear', withG0: true, item: () => setGroups([]), check: (d) => expect(groupUuidsOf(d), 'an empty list removes every group').toEqual([]) },
        { key: 'owner', withG0: false, item: (o) => setOwner(o.user.uuid), check: (d, o) => expect(d.ownerUuid ?? d.owner?.uuid, 'the owner is the own user').toBe(o.user.uuid) },
        { key: 'ra', withG0: false, needsRaB: true, item: (o) => setRaProfile(o.raB!.uuid), check: (d, o) => expect(d.raProfile?.uuid, 'the RA profile was switched to B').toBe(o.raB!.uuid) },
        { key: 'custom', withG0: false, item: (o) => setCustomAttribute(o.attr.attributeName, 'STRING', 'v'), check: (d, o) => expect(customAttributeValue(d, o.attr.attributeName)).toBe('v') },
    ];

    for (const row of rows) {
        test(`REG-WFL-09[${row.key}]: the fired trigger leaves exactly its Set field value on the certificate`,
            meta({
                id: 'REG-WFL-09', prio: 'P1', issue: 'ilm#438',
                rule: ['T14 W18 (Set field on a certificate: RA profile, Groups REPLACES the set, null / empty removes all, Owner); ilm#115 UC1; custom attribute content via the execution item', `P-09 row ${row.key}`],
            }),
            async ({ api }) => {
                test.setTimeout(480_000);
                const platformGate = await getPlatformTriggerGate(api, [EVENT.actionPerformed]);
                test.skip(platformGate !== undefined, platformGate ?? '');
                const ra = await createOwnRaProfileOrSkip(api, SPEC, `wf09-ra-${row.key}`, (reason) => test.skip(true, reason));
                const raB = row.needsRaB ? await createOwnRaProfile(api, SPEC, `wf09-rab-${row.key}`) : undefined;
                const g0 = await createOwnGroup(api, SPEC, `wf09-g0-${row.key}`);
                const gx = await createOwnGroup(api, SPEC, `wf09-gx-${row.key}`);
                const user = await createOwnUser(api, `wf09-user-${row.key}`, SPEC);
                const attr = await createOwnCustomAttribute(api, SPEC, { suffix: `wf09-attr-${row.key}`, resources: ['certificates'] });
                const objects = { g0, gx, user, ...(raB ? { raB } : {}), attr };

                const triggers: Awaited<ReturnType<typeof createOwnChain>>[] = [];
                if (row.withG0) triggers.push(await createOwnChain(api, SPEC, { suffix: `wf09-${row.key}-0`, event: EVENT.actionPerformed, executionItems: [setGroups([g0.uuid])] }));
                triggers.push(await createOwnChain(api, SPEC, { suffix: `wf09-${row.key}-t`, event: EVENT.actionPerformed, executionItems: [row.item(objects)] }));
                const sent = await associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'raProfiles', object: ra, triggers: triggers.map((t) => t.trigger) });
                expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);

                const cert = await issueOwnCertificate(api, SPEC, ra, `wf09-cert-${row.key}`);
                await waitForFinishedFirings(api, { event: EVENT.actionPerformed, scope: { resource: 'raProfiles', objectUuid: ra.uuid } }, 1);
                const history = await waitForTriggerRows(api, 'certificates', cert.uuid, triggers.map((t) => t.trigger.name));
                const mine = inEvaluationOrder(history.filter((h) => triggers.some((t) => t.trigger.name === h.trigger.name)));
                for (const r of mine) expect({ matched: r.conditionsMatched, performed: r.actionsPerformed, records: r.records.map((x) => x.message) }, `${r.trigger.name}`).toEqual({ matched: true, performed: true, records: [] });

                // The effect is committed with the trigger transaction: read it (polled once the last trigger row exists).
                const detail = await pollUntil(() => getCertificateDetail(api, cert.uuid), (d) => {
                    try {
                        row.check(d, objects);
                        return true;
                    } catch {
                        return false;
                    }
                }, { what: `the ${row.key} effect on the certificate`, timeoutMs: 60_000 }).catch(async () => getCertificateDetail(api, cert.uuid));
                row.check(detail, objects);
            });
    }
});
