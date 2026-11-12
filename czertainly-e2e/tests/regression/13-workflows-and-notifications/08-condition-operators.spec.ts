/**
 * REG-WFL-08 — Condition semantics on a live object. ilm#438.
 *
 * WHAT: 1. One own certificate (two own groups, an owner, the own RA profile, custom attribute a1 = v1 and no a2) and one own trigger per
 *          condition of a 21-row matrix (groups, owner, RA profile, custom attributes, metadata, Common Name; equals, not equals, empty,
 *          not empty, count, contains, starts with, matches), all associated on the RA profile.
 *       2. One revoke fires them once.
 *       3. Every trigger's history row reports the `conditionsMatched` the rules give.
 * WHY: an absent value is empty and equals nothing; list fields (group, owner, RA profile) compare by membership; metadata with no entry is
 *      false for every operator. ilm#438 names the risk of lazy associations, including the inverse owner under Hibernate 7.4. A red row
 *      names the condition whose evaluation changed.
 * HOW: not asserted: date operators (the CA decides validity), a multi-value operator error, EMPTY on absent metadata. All triggers
 *      share one action (a Set field on a sink attribute nothing reads), so one firing evaluates the whole matrix. Own objects only,
 *      recorded before any assertion; the test declares `needs: 'ca'` and skips with the reason when a platform-level trigger already
 *      listens on the events.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { revokeOwnCertificateAndWait, setOwnCustomAttribute, updateOwnCertificate, eventCertificate } from '../../../utils/regression/events/workflowFixtures';
import { runId } from '../../../utils/regression/ledger/runState';
import { associateTriggers } from '../../../utils/regression/events/eventAssociations';
import { waitForFinishedFirings, waitForTriggerRows } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { CERT_FIELD, ConditionItem, conditionItem, createOwnAction, createOwnCondition, createOwnExecution, createOwnRule, createOwnTrigger, setCustomAttributeAction } from '../../../utils/regression/events/workflowObjects';
import { testMeta, tags } from '../../../utils/regression/tags';
import { EVENT_DELIVERY_MS, TRIGGER_ROWS_WAIT_MS } from '../../../utils/regression/timeouts';

test.describe('Condition semantics on a live object', { tag: tags.regression }, () => {
    test('every trigger of the matrix reports the conditionsMatched the rules give, in one firing',
        testMeta({
            id: 'REG-WFL-08', prio: 'P2', issue: 'ilm#438', needs: 'ca',
            rule: [
                'absent value: EMPTY and NOT_EQUALS met; collections: EQUALS any / NOT_EQUALS none; operator sets; property resolution through live associations',
                'ilm#438 risk (lazy associations incl. the inverse owner under Hibernate 7.4)',
            ],
        }),
        async ({ api, own, needs }) => {
            test.setTimeout(EVENT_DELIVERY_MS);
            await needs.platformTriggersFree(EVENT.statusChanged, EVENT.actionPerformed);
            const { ra, g1, g2, owner, other, a1, a2, sink, g3Name, cert } = await test.step('Own RA profile, groups, users and custom attributes; one certificate in both groups with an owner and a1 set', async () => {
                const ra = await own.raProfile('wf08-ra');
                const g1 = await own.group('wf08-g1');
                const g2 = await own.group('wf08-g2');
                const owner = await own.user('wf08-owner');
                const other = await own.user('wf08-other');
                const a1 = await own.customAttribute('wf08-a1', { resources: ['certificates'] });
                const a2 = await own.customAttribute('wf08-a2', { resources: ['certificates'] });
                const sink = await own.customAttribute('wf08-sink', { resources: ['certificates'] });
                const g3Name = `${runId()}-wf08-g3-never`;

                const cert = await own.certificate.issue(ra, eventCertificate('wf08-cert'));
                const prepared = await updateOwnCertificate(api, cert, { groupUuids: [g1.uuid, g2.uuid], ownerUuid: owner.uuid });
                expect(prepared.status, `prepare the certificate (groups, owner): ${prepared.text.slice(0, 300)}`).toBeLessThan(300);
                // The update DTO has no custom attributes (core ignores unknown fields): a1 goes through the attribute's own endpoint.
                const marked = await setOwnCustomAttribute(api, cert, a1, 'v1');
                expect(marked.status, `set the custom attribute a1: ${marked.text.slice(0, 300)}`).toBeLessThan(300);
                return { ra, g1, g2, owner, other, a1, a2, sink, g3Name, cert };
            });

            const prop = (id: string, op: string, value?: unknown): ConditionItem => conditionItem('property', id, op, value);
            const custom = (a: { attributeName: string }, op: string, value?: unknown): ConditionItem => conditionItem('custom', `${a.attributeName}|STRING`, op, value);
            const matrix: Array<[string, ConditionItem, boolean]> = [
                ['groups-eq-g1', prop(CERT_FIELD.group, 'EQUALS', [g1.name]), true],
                ['groups-ne-g1', prop(CERT_FIELD.group, 'NOT_EQUALS', [g1.name]), false],
                ['groups-ne-g3', prop(CERT_FIELD.group, 'NOT_EQUALS', [g3Name]), true],
                ['groups-empty', prop(CERT_FIELD.group, 'EMPTY'), false],
                ['groups-notempty', prop(CERT_FIELD.group, 'NOT_EMPTY'), true],
                ['groups-count2', prop(CERT_FIELD.group, 'COUNT_EQUAL', 2), true],
                ['owner-eq-o', prop(CERT_FIELD.owner, 'EQUALS', [owner.name]), true],
                ['owner-eq-other', prop(CERT_FIELD.owner, 'EQUALS', [other.name]), false],
                ['ra-eq', prop(CERT_FIELD.raProfile, 'EQUALS', [ra.name]), true],
                ['ra-ne', prop(CERT_FIELD.raProfile, 'NOT_EQUALS', [ra.name]), false],
                ['a1-eq-v1', custom(a1, 'EQUALS', 'v1'), true],
                ['a1-eq-other', custom(a1, 'EQUALS', 'other'), false],
                ['a2-empty', custom(a2, 'EMPTY'), true],
                ['a2-ne-x', custom(a2, 'NOT_EQUALS', 'x'), true],
                ['a2-eq-x', custom(a2, 'EQUALS', 'x'), false],
                ['a2-contains-x', custom(a2, 'CONTAINS', 'x'), false],
                ['a2-notempty', custom(a2, 'NOT_EMPTY'), false],
                ['meta-eq-x', conditionItem('meta', 'qa-absent|STRING', 'EQUALS', 'x'), false],
                ['cn-contains', prop(CERT_FIELD.commonName, 'CONTAINS', runId()), true],
                ['cn-starts', prop(CERT_FIELD.commonName, 'STARTS_WITH', runId()), true],
                ['cn-matches', prop(CERT_FIELD.commonName, 'MATCHES', `.*${runId()}.*`), true],
            ];

            const triggers = await test.step('One rule and trigger per condition, all associated on the own RA profile', async () => {
                // One shared action (a Set field on a sink attribute nothing reads); one rule + trigger per condition.
                const execution = await createOwnExecution(api, own.spec, 'wf08-e', { items: [setCustomAttributeAction(sink.attributeName, 'STRING', 'x')] });
                const action = await createOwnAction(api, own.spec, 'wf08-a', { executions: [execution] });
                const triggers: Array<{ key: string; trigger: Awaited<ReturnType<typeof createOwnTrigger>> }> = [];
                for (const [key, item] of matrix) {
                    const condition = await createOwnCondition(api, own.spec, `wf08-${key}-c`, { items: [item] });
                    const rule = await createOwnRule(api, own.spec, `wf08-${key}-r`, { conditions: [condition] });
                    triggers.push({ key, trigger: await createOwnTrigger(api, own.spec, `wf08-${key}-t`, { event: EVENT.actionPerformed, rules: [rule], actions: [action] }) });
                }
                const sent = await associateTriggers(api, own.spec, { event: EVENT.actionPerformed, resource: 'raProfiles', object: ra, triggers: triggers.map((t) => t.trigger) });
                expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
                return triggers;
            });

            await test.step('One revoke fires once; every trigger reports the conditionsMatched the rules give', async () => {
                // One revoke = one firing of Certificate action performed on the RA profile scope.
                const revoked = await revokeOwnCertificateAndWait(api, ra, cert);
                expect(revoked.status, revoked.text.slice(0, 300)).toBeLessThan(300);
                await waitForFinishedFirings(api, { event: EVENT.actionPerformed, scope: { resource: 'raProfiles', objectUuid: ra.uuid } }, 1);
                const rows = await waitForTriggerRows(api, 'certificates', cert.uuid, triggers.map((t) => t.trigger.name), { timeoutMs: TRIGGER_ROWS_WAIT_MS });

                const wrong: string[] = [];
                for (const [i, [key, , expected]] of matrix.entries()) {
                    const row = rows.find((r) => r.trigger.name === triggers[i].trigger.name && r.event === EVENT.actionPerformed) ?? rows.find((r) => r.trigger.name === triggers[i].trigger.name)!;
                    if (row.conditionsMatched !== expected) wrong.push(`${key}: conditionsMatched ${row.conditionsMatched}, the rules give ${expected} (records ${JSON.stringify(row.records.map((x) => x.message))})`);
                }
                expect(wrong, 'every condition of the matrix evaluates as the rules say').toEqual([]);
            });
        });
});
