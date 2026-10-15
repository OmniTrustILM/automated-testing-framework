/**
 * REG-WFL-17 — a PLATFORM-level `Certificate uploaded` trigger with own-property and custom-attribute conditions and Set field
 * (group, owner, custom attribute): the matching upload is categorised, the non-matching one untouched; each certificate's Event
 * History shows fired / not satisfied (ilm#438 steps 8–11, rewritten per T14 C1; T14 W22, W24, W27; TW22; ilm#209).
 *
 * `@local`: the association REPLACES the platform list of the event for every user (T14 0.1 rule 1). The list is READ first and the
 * row skips where something is already associated (guard 3: an existing ignore trigger on uploads would reject the test's own
 * uploads); the list is restored (empty) in `finally`. Conditions are own-property (Common Name contains) and custom attribute
 * only — the platform refuses RA profile / Group / Owner / metadata conditions for this event (API-WFL-08), which is why steps 1–2
 * of ilm#438 cannot run as written. The Set field of an RA profile is NOT exercised here: switching the RA profile of an uploaded
 * certificate needs the authority's identify attributes (P2 follow-up).
 *   matching upload (Common Name carries `-hit-`)   groups = {G}, owner = O, the attribute holds the marker; history row true / true
 *   non-matching upload                             no group, no owner, no attribute; history row false / false
 * Own objects only (the uploads are own certificates, deleted by the teardown); the UI half reads the Event History tab of both.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { EventHistoryWidget } from '../../pages/EventHistoryWidget';
import { createOwnCustomAttribute, createOwnGroup, customAttributeValue, getCertificateDetail, groupUuidsOf } from '../../utils/regression/eventsDrivers';
import { selfSignedPem } from '../../utils/regression/pki';
import { createOwnUser, uploadOwnCertificate } from '../../utils/regression/regressionApi';
import { RUN_ID } from '../../utils/regression/regressionRun';
import { getGuardedApiContext } from '../../utils/regression/guardedApi';
import type { GuardedApi } from '../../utils/regression/guardedApi';
import { describeLocal } from '../../utils/regression/tier';
import {
    CERT_FIELD, conditionItem, createOwnAction, createOwnCondition, createOwnExecution, createOwnRule, createOwnTrigger, EVENT, getObjectHistory, getPlatformAssociations, platformAssociate,
    pollUntil, setCustomAttribute, setGroups, setOwner, wfName,
} from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-17';

test.describe('@regression REG-WFL-17 platform upload trigger categorises matching uploads', () => {
    describeLocal(test);
    // `@local` rows lift the guard's ownership rule on a proven local stack only (`localStack`, `describeLocal`): the guarded
    // context is built per test here, since a spec may not `test.use` the guard options.
    let api: GuardedApi;
    test.beforeEach(async ({ request, env }) => {
        api = await getGuardedApiContext(request, env, { localStack: true });
    });
    test.afterEach(async () => {
        await api?.dispose();
    });

    test('REG-WFL-17: the matching upload is categorised (group, owner, attribute) and the non-matching one is untouched',
        meta({
            id: 'REG-WFL-17', prio: 'P1', issue: 'ilm#438', local: true,
            rule: [
                'T14 W22 (the upload event fires for sync / async upload, imports and user certificates), W24 (platform triggers only; ignore → store → action triggers → request attributes), W25 (own-property + custom-attribute conditions), W27 (upload history)',
                'T14 C1 (steps 1–2 rewritten: association-property conditions are refused for this event); ilm#209, ilm#171 sc. 1–7',
            ],
        }),
        async ({ page, env }) => {
            test.setTimeout(480_000);
            const existing = await getPlatformAssociations(api, EVENT.uploaded);
            test.skip(existing.length > 0, `guard 3: ${existing.length} platform-level trigger(s) already listen on Certificate uploaded; the row stays out of that event`);
            const group = await createOwnGroup(api, SPEC, 'wf17-group');
            const owner = await createOwnUser(api, 'wf17-owner', SPEC);
            const attr = await createOwnCustomAttribute(api, SPEC, { suffix: 'wf17-mark', resources: ['certificates'] });
            const marker = `cat-${Date.now().toString(36)}`;
            const condition = await createOwnCondition(api, SPEC, { suffix: 'wf17-c', items: [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', '-hit-')] });
            const rule = await createOwnRule(api, SPEC, { suffix: 'wf17-r', conditions: [condition] });
            const execution = await createOwnExecution(api, SPEC, { suffix: 'wf17-e', items: [setGroups([group.uuid]), setOwner(owner.uuid), setCustomAttribute(attr.attributeName, 'STRING', marker)] });
            const action = await createOwnAction(api, SPEC, { suffix: 'wf17-a', executions: [execution] });
            const trigger = await createOwnTrigger(api, SPEC, { suffix: 'wf17-t', event: EVENT.uploaded, rules: [rule], actions: [action] });

            try {
                const sent = await platformAssociate(api, SPEC, EVENT.uploaded, [trigger]);
                expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);

                const hitCn = `${wfName('wf17-hit')}.example.test`;
                const missCn = `${wfName('wf17-miss')}.example.test`;
                expect(hitCn).toContain(RUN_ID);
                const hit = await uploadOwnCertificate(api, selfSignedPem(hitCn).pem, hitCn, SPEC, 'matching upload');
                const miss = await uploadOwnCertificate(api, selfSignedPem(missCn).pem, missCn, SPEC, 'non-matching upload');

                await test.step('The matching upload is categorised: group, owner and the attribute marker (async effect: polled)', async () => {
                    const detail = await pollUntil(() => getCertificateDetail(api, hit.uuid), (d) => customAttributeValue(d, attr.attributeName) === marker && groupUuidsOf(d).length === 1, { what: 'the upload trigger effect' });
                    expect(groupUuidsOf(detail)).toEqual([group.uuid]);
                    expect(detail.ownerUuid ?? detail.owner?.uuid).toBe(owner.uuid);
                    expect(customAttributeValue(detail, attr.attributeName)).toBe(marker);
                });

                await test.step('The non-matching upload is untouched', async () => {
                    const detail = await getCertificateDetail(api, miss.uuid);
                    expect(groupUuidsOf(detail)).toEqual([]);
                    expect(detail.ownerUuid ?? detail.owner?.uuid ?? null).toBeNull();
                    expect(customAttributeValue(detail, attr.attributeName)).toBeUndefined();
                });

                await test.step('Each certificate\'s history: true / true for the match, false / false for the other', async () => {
                    const rowOf = async (uuid: string) => {
                        const rows = await pollUntil(async () => (await getObjectHistory(api, 'certificates', uuid)).rows.filter((r) => r.trigger.uuid === trigger.uuid), (r) => r.length > 0, { what: 'the trigger row' });
                        return rows[0];
                    };
                    const hitRow = await rowOf(hit.uuid);
                    expect({ matched: hitRow.conditionsMatched, performed: hitRow.actionsPerformed, event: hitRow.event }).toEqual({ matched: true, performed: true, event: EVENT.uploaded });
                    const missRow = await rowOf(miss.uuid);
                    expect({ matched: missRow.conditionsMatched, performed: missRow.actionsPerformed }).toEqual({ matched: false, performed: false });
                });

                await test.step('UI: the Event History tab of each certificate shows the same marks', async () => {
                    await loginAsSmokeUser(page, env);
                    const hitWidget = await EventHistoryWidget.onTab(page, `/administrator/#/certificates/detail/${hit.uuid}`);
                    expect(await hitWidget.objectRowFlags(trigger.name)).toEqual({ conditions: true, actions: true });
                    const missWidget = await EventHistoryWidget.onTab(page, `/administrator/#/certificates/detail/${miss.uuid}`);
                    expect(await missWidget.objectRowFlags(trigger.name)).toEqual({ conditions: false, actions: false });
                });
            } finally {
                await platformAssociate(api, SPEC, EVENT.uploaded, []);
            }
            expect(await getPlatformAssociations(api, EVENT.uploaded), 'the platform list is restored (empty)').toEqual([]);
        });
});
