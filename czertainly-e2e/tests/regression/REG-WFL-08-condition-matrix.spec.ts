/**
 * REG-WFL-08 — condition semantics on a LIVE object, one firing (ilm#438 risk: lazy associations incl. the inverse owner under
 * Hibernate 7.4; T14 W13–W15; TW19; table P-08). One own certificate — in two own groups {G1, G2}, with an owner O, on the own RA
 * profile, with a custom attribute a1 = v1 and NO a2 — and one own trigger per condition, all associated after the preparation on
 * the RA profile and fired by ONE revoke. Every trigger's row in the certificate's history carries `conditionsMatched`, which must
 * equal what the rules give (T14 W13: an absent value is empty and equals nothing, so EMPTY and NOT_EQUALS are met and every other
 * operator is not; a collection: EQUALS = any element equals, NOT_EQUALS = none equals; properties resolve through the live
 * associations — the inverse owner too).
 *
 * Derived against `TriggerEvaluator` (core): GROUP_NAME, OWNER and RA_PROFILE_NAME are LIST fields, whose EQUALS / NOT_EQUALS compare
 * with `((Collection) conditionValue).contains(item)` (the filter widget sends a list too), so the value of those rows is `[name]`; a
 * scalar there is a ClassCastException → "not set properly" → conditionsMatched false (which would make a false row pass by
 * coincidence). The group set is a collection (EQUALS any / NOT_EQUALS none, EMPTY / NOT_EMPTY / COUNT_* are the list-specific
 * operators and take no list); OWNER and RA profile resolve to ONE value (`owner.ownerUsername`, `raProfile.name`) that the list
 * operators test for membership. Custom attributes: pending content first, else the stored content; an absent attribute is `missing`
 * content (EMPTY true, negated operators true, the rest false); a scalar condition value is one-element "any of". COMMON_NAME is a
 * STRING property (contains / startsWith / String.matches). Metadata: no entry of that name and content type → false for every operator.
 *   groups   equals [G1] / not equals [G1] / not equals [G3] → true / false / true; empty / not empty / count equals 2 → false / true / true
 *   owner    equals [O] / equals [another user] → true / false;   RA profile  equals [A] / not equals [A] → true / false
 *   a1       equals v1 / equals other → true / false
 *   a2 (absent)  empty / not equals x / equals x / contains x / not empty → true / true / false / false / false
 *   metadata (absent)  equals x → false (core matches metadata by name and content type; none present → not satisfied)
 *   Common Name  contains / starts with / matches `.*<prefix>.*` → true
 * Not asserted (reasons in the report): date operators (the CA decides the validity), a multi-value operator error (API-WFL-16,
 * P2), EMPTY on absent metadata (core answers false for every operator when no metadata entry exists, a deviation from W13's
 * sentence recorded as an observation, not pinned). Own objects only; a 25-trigger run costs ~75 creates.
 */
import { expect, test } from '../../fixtures/testFixtures';
import {
    createOwnCustomAttribute, createOwnGroup, createOwnRaProfileOrSkip, issueOwnCertificate, revokeOwnCertificate, setOwnCustomAttribute, updateOwnCertificate,
} from '../../utils/regression/eventsDrivers';
import { createOwnUser } from '../../utils/regression/regressionApi';
import { RUN_ID } from '../../utils/regression/regressionRun';
import {
    associateTriggers, CERT_FIELD, ConditionItem, conditionItem, createOwnAction, createOwnCondition, createOwnExecution, createOwnRule, createOwnTrigger, EVENT, setCustomAttribute,
    waitForFinishedFirings, waitForTriggerRows, getPlatformTriggerGate,
} from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-08';

test.describe('@regression REG-WFL-08 condition semantics on a live object', () => {
    test('REG-WFL-08: every trigger of the matrix reports the conditionsMatched the rules give, in one firing',
        meta({
            id: 'REG-WFL-08', prio: 'P1', issue: 'ilm#438',
            rule: [
                'T14 W13 (absent value: EMPTY and NOT_EQUALS met; collections: EQUALS any / NOT_EQUALS none), W14 (operator sets), W15 (property resolution through live associations)',
                'ilm#438 risk (lazy associations incl. the inverse owner under Hibernate 7.4); TW19; P-08',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(900_000);
            const platformGate = await getPlatformTriggerGate(api, [EVENT.statusChanged, EVENT.actionPerformed]);
            test.skip(platformGate !== undefined, platformGate ?? '');
            const ra = await createOwnRaProfileOrSkip(api, SPEC, 'wf08-ra', (reason) => test.skip(true, reason));
            const g1 = await createOwnGroup(api, SPEC, 'wf08-g1');
            const g2 = await createOwnGroup(api, SPEC, 'wf08-g2');
            const owner = await createOwnUser(api, 'wf08-owner', SPEC);
            const other = await createOwnUser(api, 'wf08-other', SPEC);
            const a1 = await createOwnCustomAttribute(api, SPEC, { suffix: 'wf08-a1', resources: ['certificates'] });
            const a2 = await createOwnCustomAttribute(api, SPEC, { suffix: 'wf08-a2', resources: ['certificates'] });
            const sink = await createOwnCustomAttribute(api, SPEC, { suffix: 'wf08-sink', resources: ['certificates'] });
            const g3Name = `${RUN_ID}-wf08-g3-never`;

            const cert = await issueOwnCertificate(api, SPEC, ra, 'wf08-cert');
            const prepared = await updateOwnCertificate(api, cert, { groupUuids: [g1.uuid, g2.uuid], ownerUuid: owner.uuid });
            expect(prepared.status, `prepare the certificate (groups, owner): ${prepared.text.slice(0, 300)}`).toBeLessThan(300);
            // The update DTO has no custom attributes (core ignores unknown fields): a1 goes through the attribute's own endpoint.
            const marked = await setOwnCustomAttribute(api, cert, a1, 'v1');
            expect(marked.status, `set the custom attribute a1: ${marked.text.slice(0, 300)}`).toBeLessThan(300);

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
                ['cn-contains', prop(CERT_FIELD.commonName, 'CONTAINS', RUN_ID), true],
                ['cn-starts', prop(CERT_FIELD.commonName, 'STARTS_WITH', RUN_ID), true],
                ['cn-matches', prop(CERT_FIELD.commonName, 'MATCHES', `.*${RUN_ID}.*`), true],
            ];

            // One shared action (a Set field on a sink attribute nothing reads); one rule + trigger per condition.
            const execution = await createOwnExecution(api, SPEC, { suffix: 'wf08-e', items: [setCustomAttribute(sink.attributeName, 'STRING', 'x')] });
            const action = await createOwnAction(api, SPEC, { suffix: 'wf08-a', executions: [execution] });
            const triggers: Array<{ key: string; trigger: Awaited<ReturnType<typeof createOwnTrigger>> }> = [];
            for (const [key, item] of matrix) {
                const condition = await createOwnCondition(api, SPEC, { suffix: `wf08-${key}-c`, items: [item] });
                const rule = await createOwnRule(api, SPEC, { suffix: `wf08-${key}-r`, conditions: [condition] });
                triggers.push({ key, trigger: await createOwnTrigger(api, SPEC, { suffix: `wf08-${key}-t`, event: EVENT.actionPerformed, rules: [rule], actions: [action] }) });
            }
            const sent = await associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'raProfiles', object: ra, triggers: triggers.map((t) => t.trigger) });
            expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);

            // One revoke = one firing of Certificate action performed on the RA profile scope.
            const revoked = await revokeOwnCertificate(api, ra, cert);
            expect(revoked.status, revoked.text.slice(0, 300)).toBeLessThan(300);
            await waitForFinishedFirings(api, { event: EVENT.actionPerformed, scope: { resource: 'raProfiles', objectUuid: ra.uuid } }, 1);
            const rows = await waitForTriggerRows(api, 'certificates', cert.uuid, triggers.map((t) => t.trigger.name), { timeoutMs: 180_000 });

            const wrong: string[] = [];
            for (const [i, [key, , expected]] of matrix.entries()) {
                const row = rows.find((r) => r.trigger.name === triggers[i].trigger.name && r.event === EVENT.actionPerformed) ?? rows.find((r) => r.trigger.name === triggers[i].trigger.name)!;
                if (row.conditionsMatched !== expected) wrong.push(`${key}: conditionsMatched ${row.conditionsMatched}, the rules give ${expected} (records ${JSON.stringify(row.records.map((x) => x.message))})`);
            }
            expect(wrong, 'every condition of the matrix evaluates as the rules say').toEqual([]);
        });
});
