/**
 * REG-WFL-17 — A platform-level upload trigger categorises matching uploads (local stack). ilm#438, ilm#209, ilm#171.
 *
 * WHAT: 1. A platform trigger on `Certificate uploaded` has the rule "Common Name contains -hit-" and a Set field
 *          (group, owner, custom attribute).
 *       2. Upload a matching and a non-matching own certificate.
 *       3. The matching one is categorised: group, owner and the attribute marker (polled, the effect is asynchronous).
 *       4. The non-matching one is untouched.
 *       5. Each certificate's history is true / true for the match and false / false for the other; the UI's Event History
 *          tab shows the same.
 * WHY: the upload event fires for uploads, imports and user certificates and applies platform triggers only (ignore, store, action
 *      triggers, request attributes); own-property and custom-attribute conditions are allowed, association-property conditions are refused
 *      for this event (tests/api/12-workflows/upload-event-conditions.api.spec.ts).
 * HOW: `@local`: the association REPLACES the platform list of the event for every user, so the list is read first, the test skips where
 *      a platform-level trigger already listens (an existing ignore trigger would reject its own uploads) and the list is restored
 *      (empty) in `finally`. The platform calls go through the `localApi` fixture, everything else through `own`. Own objects only,
 *      recorded before any assertion.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { EventHistoryWidget } from '../../../pages/EventHistoryWidget';
import { customAttributeValue } from '../../../utils/regression/customAttributes';
import { groupUuidsOf } from '../../../utils/regression/ownGroups';
import { getCertificateDetail } from '../../../utils/regression/events/workflowFixtures';
import { selfSignedPem } from '../../../utils/regression/pkiBuilders';
import { runId, ownCommonName } from '../../../utils/regression/ledger/runState';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { getPlatformAssociations, platformAssociate } from '../../../utils/regression/events/eventAssociations';
import { getObjectHistory } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { CERT_FIELD, conditionItem, createOwnAction, createOwnCondition, createOwnExecution, createOwnRule, createOwnTrigger, setCustomAttributeAction, setGroupsAction, setOwnerAction } from '../../../utils/regression/events/workflowObjects';
import { pollUntil } from '../../../utils/regression/wait';
import { testMeta, tags } from '../../../utils/regression/tags';
import { SLOW_LIFECYCLE_MS } from '../../../utils/regression/timeouts';
import { uniqueSuffix } from '../../../utils/regression/text';

test.describe('Platform upload trigger categorises matching uploads', { tag: tags.regression }, () => {
    describeLocalOnly(test);

    test('the matching upload is categorised (group, owner, attribute) and the non-matching one is untouched',
        testMeta({
            id: 'REG-WFL-17', prio: 'P2', issue: 'ilm#438', local: true,
            rule: [
                'the upload event fires for sync / async upload, imports and user certificates; platform triggers only (ignore → store → action triggers → request attributes); own-property + custom-attribute conditions; upload history',
                'association-property conditions are refused for this event; ilm#209, ilm#171 sc. 1–7',
            ],
        }),
        async ({ signedIn: page, api, localApi, own, needs }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            await needs.platformTriggersFree(EVENT.uploaded);
            const group = await own.group('wf17-group');
            const owner = await own.user('wf17-owner');
            const attr = await own.customAttribute('wf17-mark', { resources: ['certificates'] });
            const marker = `cat-${uniqueSuffix()}`;
            const condition = await createOwnCondition(api, own.spec, 'wf17-c', { items: [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', '-hit-')] });
            const rule = await createOwnRule(api, own.spec, 'wf17-r', { conditions: [condition] });
            const execution = await createOwnExecution(api, own.spec, 'wf17-e', { items: [setGroupsAction([group.uuid]), setOwnerAction(owner.uuid), setCustomAttributeAction(attr.attributeName, 'STRING', marker)] });
            const action = await createOwnAction(api, own.spec, 'wf17-a', { executions: [execution] });
            const trigger = await createOwnTrigger(api, own.spec, 'wf17-t', { event: EVENT.uploaded, rules: [rule], actions: [action] });

            try {
                const sent = await platformAssociate(localApi, own.spec, EVENT.uploaded, [trigger]);
                expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);

                const hitCn = ownCommonName('wf17-hit');
                const missCn = ownCommonName('wf17-no');
                expect(hitCn).toContain(runId());
                const hit = await own.certificate.upload(selfSignedPem(hitCn).pem, hitCn, 'matching upload');
                const miss = await own.certificate.upload(selfSignedPem(missCn).pem, missCn, 'non-matching upload');

                await test.step('The matching upload is categorised: group, owner and the attribute marker (async effect: polled)', async () => {
                    const detail = await pollUntil(() => getCertificateDetail(api, hit.uuid), (d) => customAttributeValue(d, attr.attributeName) === marker && groupUuidsOf(d).length === 1, { what: 'the upload trigger effect' });
                    expect(groupUuidsOf(detail), 'the matching upload is in the group').toEqual([group.uuid]);
                    expect(detail.ownerUuid ?? detail.owner?.uuid, 'the matching upload has the owner').toBe(owner.uuid);
                    expect(customAttributeValue(detail, attr.attributeName), 'the matching upload carries the attribute marker').toBe(marker);
                });

                await test.step('The non-matching upload is untouched', async () => {
                    const detail = await getCertificateDetail(api, miss.uuid);
                    expect(groupUuidsOf(detail), 'the non-matching upload has no group').toEqual([]);
                    expect(detail.ownerUuid ?? detail.owner?.uuid ?? null, 'the non-matching upload has no owner').toBeNull();
                    expect(customAttributeValue(detail, attr.attributeName), 'the non-matching upload has no marker').toBeUndefined();
                });

                await test.step('Each certificate\'s history: true / true for the match, false / false for the other', async () => {
                    const rowOf = async (uuid: string) => {
                        const rows = await pollUntil(async () => (await getObjectHistory(api, 'certificates', uuid)).rows.filter((r) => r.trigger.uuid === trigger.uuid), (r) => r.length > 0, { what: 'the trigger row' });
                        return rows[0];
                    };
                    const hitRow = await rowOf(hit.uuid);
                    expect({ matched: hitRow.conditionsMatched, performed: hitRow.actionsPerformed, event: hitRow.event }, 'the matching upload: true / true on Certificate uploaded').toEqual({ matched: true, performed: true, event: EVENT.uploaded });
                    const missRow = await rowOf(miss.uuid);
                    expect({ matched: missRow.conditionsMatched, performed: missRow.actionsPerformed }, 'the non-matching upload: false / false').toEqual({ matched: false, performed: false });
                });

                await test.step('UI: the Event History tab of each certificate shows the same marks', async () => {
                    const hitWidget = await EventHistoryWidget.goToObjectHistory(page, `/administrator/#/certificates/detail/${hit.uuid}`);
                    expect(await hitWidget.readObjectRowFlags(trigger.name), 'the matching upload shows met and performed in its Event History').toEqual({ conditions: true, actions: true });
                    const missWidget = await EventHistoryWidget.goToObjectHistory(page, `/administrator/#/certificates/detail/${miss.uuid}`);
                    expect(await missWidget.readObjectRowFlags(trigger.name), 'the non-matching upload shows not met and not performed in its Event History').toEqual({ conditions: false, actions: false });
                });
            } finally {
                await platformAssociate(localApi, own.spec, EVENT.uploaded, []);
            }
            expect(await getPlatformAssociations(localApi, EVENT.uploaded), 'the platform list is restored (empty)').toEqual([]);
        });
});
