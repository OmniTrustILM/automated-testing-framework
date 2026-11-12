/**
 * REG-WFL-03 — A rule, an action and two triggers built in the UI forms. ilm#438.
 *
 * WHAT: 1. Rules → Create Rule with an own condition; Actions → Create Action with an own execution; each opens its detail page.
 *       2. Triggers → Create Trigger: type Event, resource Certificate, event Certificate uploaded, the rule and the
 *          action (an action trigger).
 *       3. A second trigger on the same event with the rule and no action (an ignore trigger).
 *       4. The API read-back holds what the forms sent: the rule's conditions, the action's executions, the action trigger's rule, action,
 *          type, event and `ignoreTrigger: false`, the ignore trigger's rule, no actions and `ignoreTrigger: true`.
 *       5. The lists name both triggers; the UI detail shows the ignore switch on for the ignore trigger only.
 *       6. Nothing is associated: the platform-level association of Certificate uploaded names neither trigger.
 * WHY: an ignore trigger has no actions and an action trigger at least one; a trigger without an association never fires, and the refusal
 *      of association conditions happens at association time only (tests/api/12-workflows/upload-event-conditions.api.spec.ts).
 * HOW: prerequisites (group, condition, execution) are own objects created through the API; each object made in the forms is recorded in
 *      the ledger from the form's answer, before the detail route is waited for and before any assertion. The API read-back is the oracle.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { WorkflowPage } from '../../../pages/WorkflowPage';
import { lookupInList, submitRecordingByNameOnFailure } from '../../../utils/regression/ledger/uiCreates';
import { runId, ownName } from '../../../utils/regression/ledger/runState';
import { getPlatformAssociations } from '../../../utils/regression/events/eventAssociations';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { CERT_FIELD, conditionItem, createOwnCondition, createOwnExecution, getKind, kindPath, listKind, setGroupsAction } from '../../../utils/regression/events/workflowObjects';
import { testMeta, tags } from '../../../utils/regression/tags';
import { FORM_FLOW_MS } from '../../../utils/regression/timeouts';

type Json = Record<string, any>;

test.describe('Rule, action and triggers built in the UI', { tag: tags.regression }, () => {
    test('an action trigger and an ignore trigger built in the forms are stored as entered and fire nothing',
        testMeta({
            id: 'REG-WFL-03', prio: 'P2', issue: 'ilm#438',
            rule: ['trigger validation: an ignore trigger has no actions, an action trigger has ≥ 1; a trigger without association never fires; refusal happens at association time only', 'ilm#438 steps 7 and 12'],
        }),
        async ({ signedIn: page, api, own, live }) => {
            test.setTimeout(FORM_FLOW_MS);
            const group = await own.group('wf03-group');
            const condition = await createOwnCondition(api, own.spec, 'wf03-cond', { items: [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', runId())] });
            const execution = await createOwnExecution(api, own.spec, 'wf03-exec', { items: [setGroupsAction([group.uuid])] });
            const workflow = new WorkflowPage(page);

            const ruleName = ownName('wf03-rule');
            const rule = await test.step('Rules → Create Rule: the own condition', async () => {
                await live('conditions', condition); // the form picks this own object
                const created = await submitRecordingByNameOnFailure({ type: 'rules', name: ruleName, spec: own.spec, note: 'built in the UI form', lookup: lookupInList(api, kindPath('rules')) }, () => workflow.createRule({ name: ruleName, resource: 'certificates', conditions: [condition.name] }));
                // the ledger line comes from the form's answer
                const ref = own.record('rules', created, { name: ruleName, note: 'built in the UI form' });
                await workflow.waitForDetailRoute('rule');
                return { ...ref, body: created.body };
            });
            const actionName = ownName('wf03-act');
            const action = await test.step('Actions → Create Action: the own execution', async () => {
                await live('executions', execution);
                const created = await submitRecordingByNameOnFailure({ type: 'actions', name: actionName, spec: own.spec, note: 'built in the UI form', lookup: lookupInList(api, kindPath('actions')) }, () => workflow.createAction({ name: actionName, resource: 'certificates', executions: [execution.name] }));
                // the ledger line comes from the form's answer
                const ref = own.record('actions', created, { name: actionName, note: 'built in the UI form' });
                await workflow.waitForDetailRoute('action');
                return { ...ref, body: created.body };
            });

            const actionTriggerName = ownName('wf03-trig');
            const actionTrigger = await test.step('Triggers → Create Trigger: type Event, Certificate uploaded, the rule and the action', async () => {
                await live('rules', rule);
                await live('actions', action);
                const created = await submitRecordingByNameOnFailure({ type: 'triggers', name: actionTriggerName, spec: own.spec, note: 'built in the UI form (action trigger)', lookup: lookupInList(api, kindPath('triggers')) }, () => workflow.createTrigger({ name: actionTriggerName, resource: 'certificates', event: EVENT.uploaded, rules: [ruleName], actions: [actionName] }));
                // the ledger line comes from the form's answer
                const ref = own.record('triggers', created, { name: actionTriggerName, note: 'built in the UI form (action trigger)' });
                await workflow.waitForDetailRoute('trigger');
                return { ...ref, body: created.body };
            });
            const ignoreTriggerName = ownName('wf03-ign');
            const ignoreTrigger = await test.step('Triggers → Create Trigger: an ignore trigger with the rule and no action', async () => {
                await live('rules', rule);
                const created = await submitRecordingByNameOnFailure({ type: 'triggers', name: ignoreTriggerName, spec: own.spec, note: 'built in the UI form (ignore trigger)', lookup: lookupInList(api, kindPath('triggers')) }, () => workflow.createTrigger({ name: ignoreTriggerName, resource: 'certificates', event: EVENT.uploaded, ignore: true, rules: [ruleName] }));
                // the ledger line comes from the form's answer
                const ref = own.record('triggers', created, { name: ignoreTriggerName, note: 'built in the UI form (ignore trigger)' });
                await workflow.waitForDetailRoute('trigger');
                return { ...ref, body: created.body };
            });

            await test.step('API read-back: the rule and the action hold what the forms sent', async () => {
                const r = (await getKind(api, 'rules', rule.uuid)).json as Json;
                expect(r, 'the stored rule').toMatchObject({ name: ruleName, resource: 'certificates' });
                expect(r.conditions.map((c: Json) => c.uuid), 'the rule holds the own condition').toEqual([condition.uuid]);
                const a = (await getKind(api, 'actions', action.uuid)).json as Json;
                expect(a, 'the stored action').toMatchObject({ name: actionName, resource: 'certificates' });
                expect(a.executions.map((e: Json) => e.uuid), 'the action holds the own execution').toEqual([execution.uuid]);
            });

            await test.step('API read-back: the action trigger holds the rule, the action, type event and the event code', async () => {
                const t = (await getKind(api, 'triggers', actionTrigger.uuid)).json as Json;
                expect(t, 'the stored action trigger').toMatchObject({ name: actionTriggerName, type: 'event', event: EVENT.uploaded, resource: 'certificates', ignoreTrigger: false });
                expect(t.rules.map((x: Json) => x.uuid), 'the action trigger holds the rule').toEqual([rule.uuid]);
                expect(t.actions.map((x: Json) => x.uuid), 'the action trigger holds the action').toEqual([action.uuid]);
                expect(actionTrigger.body, 'the form sent the same rule and action uuids').toMatchObject({ rulesUuids: [rule.uuid], actionsUuids: [action.uuid], ignoreTrigger: false });
            });

            await test.step('API read-back: the ignore trigger holds the rule and no action', async () => {
                const t = (await getKind(api, 'triggers', ignoreTrigger.uuid)).json as Json;
                expect(t, 'the stored ignore trigger').toMatchObject({ name: ignoreTriggerName, type: 'event', event: EVENT.uploaded, resource: 'certificates', ignoreTrigger: true });
                expect(t.rules.map((x: Json) => x.uuid), 'the ignore trigger holds the rule').toEqual([rule.uuid]);
                expect(t.actions, 'the ignore trigger has no action').toHaveLength(0);
            });

            await test.step('The lists name both triggers; the UI detail shows the ignore switch on for the ignore trigger only', async () => {
                const names = (await listKind(api, 'triggers')).map((x) => x.name);
                expect(names, 'the trigger list names both triggers').toEqual(expect.arrayContaining([actionTriggerName, ignoreTriggerName]));
                await workflow.goToDetail('trigger', ignoreTrigger.uuid);
                await expect(workflow.ignoreSwitch, 'the ignore trigger shows the switch on').toBeChecked();
                await workflow.goToDetail('trigger', actionTrigger.uuid);
                await expect(workflow.ignoreSwitch, 'the action trigger shows the switch off').not.toBeChecked();
            });

            await test.step('Nothing is associated: the platform-level list of Certificate uploaded names neither trigger (they cannot fire)', async () => {
                const platform = await getPlatformAssociations(api, EVENT.uploaded);
                expect(platform, 'the action trigger is not associated at platform level').not.toContain(actionTrigger.uuid);
                expect(platform, 'the ignore trigger is not associated at platform level').not.toContain(ignoreTrigger.uuid);
            });
        });
});
