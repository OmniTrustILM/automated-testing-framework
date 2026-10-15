/**
 * API-WFL-01 — create each of the five workflow kinds and read them back (ilm#438 steps 1, 6, 7; T14 W8, W10; TW01).
 *
 * Own objects only: a condition → rule and an execution → action chain, then two triggers — an action trigger bound to
 * `Certificate action performed` and an ignore trigger bound to `Certificate uploaded` whose rule reads an association property
 * (RA profile): the platform accepts it at CREATE time, because the refusal for that event is an association-time rule (T14
 * W25, API-WFL-08). Nothing is associated, so nothing fires. Every create is recorded in the ledger before any assertion and
 * removed by the run-end teardown (utils/workflowUtils.ts).
 *
 * Status of a create: the contract (OpenAPI) says 201, the controller returns the DTO without a `@ResponseStatus`; the test
 * accepts any 2xx and records the observed status as an annotation (open question for the first live run).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnGroup } from '../../utils/regression/eventsDrivers';
import {
    CERT_FIELD, conditionItem, createOwnAction, createOwnCondition, createOwnExecution, createOwnRule, createOwnTrigger, EVENT, getKind, kindPath, listKind,
    setGroups, WorkflowKind,
} from '../../utils/regression/workflowApi';
import { RUN_ID } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-WFL-01';

test.describe('API-WFL-01 workflow objects: create, read back, list', { tag: tags.api }, () => {
    test('API-WFL-01: condition, rule, execution, action and trigger are created with run-prefixed names and read back as sent',
        meta({
            id: 'API-WFL-01', prio: 'P1', issue: 'ilm#438',
            rule: [
                'T14 W8 (validation and names of the five kinds), W10 (names editable and unique), TW01 (create each kind, read it back)',
                'ilm#438 steps 1, 6, 7: build conditions, rules, executions, actions and triggers; a trigger is accepted without any association',
                'T14 W25: Certificate uploaded refuses association-property conditions at ASSOCIATION time, not at creation',
            ],
        }),
        async ({ api }, testInfo) => {
            const group = await test.step('Prerequisite: an own group (the Set field target)', async () => createOwnGroup(api, SPEC, 'wf01-group'));
            const prefixItem = conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', RUN_ID);

            const condition = await createOwnCondition(api, SPEC, { suffix: 'wf01-cond', items: [prefixItem], description: 'API-WFL-01 condition' });
            const rule = await createOwnRule(api, SPEC, { suffix: 'wf01-rule', conditions: [condition], description: 'API-WFL-01 rule' });
            const execution = await createOwnExecution(api, SPEC, { suffix: 'wf01-exec', items: [setGroups([group.uuid])], description: 'API-WFL-01 execution' });
            const action = await createOwnAction(api, SPEC, { suffix: 'wf01-act', executions: [execution], description: 'API-WFL-01 action' });
            const trigger = await createOwnTrigger(api, SPEC, { suffix: 'wf01-trig', event: EVENT.actionPerformed, rules: [rule], actions: [action], description: 'API-WFL-01 trigger' });
            // A rule over an association property (RA profile) on a trigger bound to Certificate uploaded: accepted, never associated.
            const raCondition = await createOwnCondition(api, SPEC, { suffix: 'wf01-racond', items: [conditionItem('property', CERT_FIELD.raProfile, 'EQUALS', [`${RUN_ID}-no-such-ra`])] });
            const raRule = await createOwnRule(api, SPEC, { suffix: 'wf01-rarule', conditions: [raCondition] });
            const uploadTrigger = await createOwnTrigger(api, SPEC, { suffix: 'wf01-upload', event: EVENT.uploaded, ignore: true, rules: [raRule] });

            await test.step('Every create answered 2xx and a uuid (observed status recorded)', async () => {
                testInfo.annotations.push({ type: 'create-status', description: 'see the POST answers in the trace: the OpenAPI declares 201, the controller default is 200' });
                for (const c of [condition, rule, execution, action, trigger, raCondition, raRule, uploadTrigger]) expect(c.body.uuid, 'the create answer names the object').toBe(c.uuid);
            });

            await test.step('Condition: GET returns the same fields and items as sent', async () => {
                const got = (await getKind(api, 'conditions', condition.uuid)).json;
                expect(got).toMatchObject({ uuid: condition.uuid, name: condition.name, description: 'API-WFL-01 condition', type: 'checkField', resource: 'certificates' });
                expect(got.items).toHaveLength(1);
                expect(got.items[0]).toMatchObject({ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', operator: 'CONTAINS', value: RUN_ID });
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
