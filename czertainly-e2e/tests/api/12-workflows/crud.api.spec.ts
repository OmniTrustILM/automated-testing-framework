/**
 * API-WFL-01 — Workflow objects: create each of the five kinds and read them back. ilm#438.
 *
 * WHAT: 1. An own group (the Set field target), a condition and a rule over it, an execution (Set field Groups) and an action over it, and
 *          an action trigger bound to `Certificate action performed` are created and each answers 2xx with its uuid.
 *       2. A trigger bound to `Certificate uploaded` (ignore trigger) whose rule reads an association property (RA profile) is accepted at
 *          create time.
 *       3. Each GET returns the fields and items as sent (condition items, rule conditions, execution item with the group, action
 *          executions, trigger event, rules and actions); every kind lists the new uuid.
 * WHY: names are editable and unique; a trigger is accepted without any association. Certificate uploaded refuses association-property
 *      conditions at association time, not at creation (12-workflows/upload-event-conditions.api.spec.ts). ilm#438 steps 1, 6 and 7 build
 *      conditions, rules, executions, actions and triggers.
 * HOW: own objects only; nothing is associated, so nothing fires; every create is recorded in the ledger before any assertion. A create may
 *      answer any 2xx (the OpenAPI declares 201, the controller default is 200): the observed status is annotated.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { createOwnGroup } from '../../../utils/regression/ownGroups';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { CERT_FIELD, conditionItem, createOwnAction, createOwnCondition, createOwnExecution, createOwnRule, createOwnTrigger, getKind, kindPath, listKind, setGroupsAction, WorkflowKind } from '../../../utils/regression/events/workflowObjects';
import { runId } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';

test.describe('Workflow objects: create, read back, list', { tag: tags.api }, () => {
    test('condition, rule, execution, action and trigger are created with own names and read back as sent',
        testMeta({
            id: 'API-WFL-01', prio: 'P1', issue: 'ilm#438',
            rule: [
                'validation and names of the five kinds; names editable and unique; create each kind, read it back',
                'ilm#438 steps 1, 6, 7: build conditions, rules, executions, actions and triggers; a trigger is accepted without any association',
                'Certificate uploaded refuses association-property conditions at ASSOCIATION time, not at creation',
            ],
        }),
        async ({ api, own }, testInfo) => {
            const group = await test.step('Prerequisite: an own group (the Set field target)', async () => createOwnGroup(api, own.spec, 'wf01-group'));
            const prefixItem = conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', runId());

            const condition = await createOwnCondition(api, own.spec, 'wf01-cond', { items: [prefixItem], description: 'API-WFL-01 condition' });
            const rule = await createOwnRule(api, own.spec, 'wf01-rule', { conditions: [condition], description: 'API-WFL-01 rule' });
            const execution = await createOwnExecution(api, own.spec, 'wf01-exec', { items: [setGroupsAction([group.uuid])], description: 'API-WFL-01 execution' });
            const action = await createOwnAction(api, own.spec, 'wf01-act', { executions: [execution], description: 'API-WFL-01 action' });
            const trigger = await createOwnTrigger(api, own.spec, 'wf01-trig', { event: EVENT.actionPerformed, rules: [rule], actions: [action], description: 'API-WFL-01 trigger' });
            // A rule over an association property (RA profile) on a trigger bound to Certificate uploaded: accepted, never associated.
            const raCondition = await createOwnCondition(api, own.spec, 'wf01-racond', { items: [conditionItem('property', CERT_FIELD.raProfile, 'EQUALS', [`${runId()}-no-such-ra`])] });
            const raRule = await createOwnRule(api, own.spec, 'wf01-rarule', { conditions: [raCondition] });
            const uploadTrigger = await createOwnTrigger(api, own.spec, 'wf01-upload', { event: EVENT.uploaded, ignore: true, rules: [raRule] });

            await test.step('Every create answered 2xx and a uuid (observed status recorded)', async () => {
                testInfo.annotations.push({ type: 'create-status', description: 'see the POST answers in the trace: the OpenAPI declares 201, the controller default is 200' });
                for (const c of [condition, rule, execution, action, trigger, raCondition, raRule, uploadTrigger]) expect(c.body.uuid, 'the create answer names the object').toBe(c.uuid);
            });

            await test.step('Condition: GET returns the same fields and items as sent', async () => {
                const got = (await getKind(api, 'conditions', condition.uuid)).json;
                expect(got).toMatchObject({ uuid: condition.uuid, name: condition.name, description: 'API-WFL-01 condition', type: 'checkField', resource: 'certificates' });
                expect(got.items).toHaveLength(1);
                expect(got.items[0]).toMatchObject({ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', operator: 'CONTAINS', value: runId() });
            });

            await test.step('Rule: GET lists the condition', async () => {
                const got = (await getKind(api, 'rules', rule.uuid)).json;
                expect(got).toMatchObject({ uuid: rule.uuid, name: rule.name, resource: 'certificates' });
                expect(got.conditions.map((c: { uuid: string }) => c.uuid)).toEqual([condition.uuid]);
            });

            await test.step('Execution: GET returns the Set field Groups item (own group)', async () => {
                const got = (await getKind(api, 'executions', execution.uuid)).json;
                expect(got).toMatchObject({ uuid: execution.uuid, name: execution.name, type: 'setField', resource: 'certificates' });
                expect(got.items).toHaveLength(1);
                expect(got.items[0]).toMatchObject({ fieldSource: 'property', fieldIdentifier: 'GROUP_NAME' });
                expect(([] as unknown[]).concat(got.items[0].data)).toEqual([group.uuid]);
            });

            await test.step('Action: GET lists the execution', async () => {
                const got = (await getKind(api, 'actions', action.uuid)).json;
                expect(got).toMatchObject({ uuid: action.uuid, name: action.name, resource: 'certificates' });
                expect(got.executions.map((e: { uuid: string }) => e.uuid)).toEqual([execution.uuid]);
            });

            await test.step('Trigger: GET returns type event, the event, not ignore, its rule and its action', async () => {
                const got = (await getKind(api, 'triggers', trigger.uuid)).json;
                expect(got).toMatchObject({ uuid: trigger.uuid, name: trigger.name, type: 'event', event: EVENT.actionPerformed, resource: 'certificates', ignoreTrigger: false });
                expect(got.rules.map((r: { uuid: string }) => r.uuid)).toEqual([rule.uuid]);
                expect(got.actions.map((a: { uuid: string }) => a.uuid)).toEqual([action.uuid]);
            });

            await test.step('Trigger bound to Certificate uploaded with an RA-profile rule is accepted (no association yet)', async () => {
                const got = (await getKind(api, 'triggers', uploadTrigger.uuid)).json;
                expect(got).toMatchObject({ event: EVENT.uploaded, ignoreTrigger: true, resource: 'certificates' });
                expect(got.actions).toHaveLength(0);
            });

            await test.step('Every kind lists the new uuid', async () => {
                const created: Array<[WorkflowKind, string]> = [
                    ['conditions', condition.uuid], ['rules', rule.uuid], ['executions', execution.uuid], ['actions', action.uuid], ['triggers', trigger.uuid],
                ];
                for (const [kind, uuid] of created) {
                    const rows = await listKind(api, kind);
                    expect(rows.map((r) => r.uuid), `GET ${kindPath(kind)} lists the object`).toContain(uuid);
                }
            });
        });
});
