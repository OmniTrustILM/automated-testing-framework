/**
 * REG-WFL-03 — an own rule, action and trigger assembled in the UI forms: an ACTION trigger (type Event, resource Certificate, event
 * Certificate uploaded) and an IGNORE trigger without actions, reopened (ilm#438 steps 7, 12, the build part; T14 W8, W11; TW02).
 * A trigger whose rule uses association conditions is accepted too: the refusal is at association time (API-WFL-08) and NOTHING is
 * associated here, so neither trigger fires.
 *
 * Prerequisites through the API (own objects): a condition (Common Name contains the run prefix), a group and a Set field
 * execution. The UI builds the rule (Create Rule), the action (Create Action) and the two triggers (Create Trigger); after each
 * Create the form redirects to the object's detail page, where the uuid is read and the object is recorded in the ledger before
 * any assertion. Oracles (API read-back): the trigger holds the rule and action uuids, `ignoreTrigger`, type `event`, the event
 * code; the lists name both; the platform-level list of the event does NOT name them (nothing associated, nothing fires).
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { WorkflowPage } from '../../pages/WorkflowPage';
import { createOwnGroup } from '../../utils/regression/eventsDrivers';
import { recordCreated, RUN_ID } from '../../utils/regression/regressionRun';
import {
    CERT_FIELD, conditionItem, createOwnCondition, createOwnExecution, EVENT, getKind, getPlatformAssociations, listKind, setGroups, wfName,
} from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-03';
type Json = Record<string, any>;

test.describe('@regression REG-WFL-03 rule, action and triggers built in the UI', () => {
    test('REG-WFL-03: an action trigger and an ignore trigger built in the forms are stored as entered and fire nothing',
        meta({
            id: 'REG-WFL-03', prio: 'P1', issue: 'ilm#438',
            rule: ['T14 W8 (trigger validation: ignore trigger has no actions, an action trigger has ≥ 1), W11 (a trigger without association never fires), W25 (association-time refusal only)', 'ilm#438 steps 7 and 12 (build part); TW02'],
        }),
        async ({ page, api, env }) => {
            test.setTimeout(300_000);
            const group = await createOwnGroup(api, SPEC, 'wf03-group');
            const condition = await createOwnCondition(api, SPEC, { suffix: 'wf03-cond', items: [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', RUN_ID)] });
            const execution = await createOwnExecution(api, SPEC, { suffix: 'wf03-exec', items: [setGroups([group.uuid])] });
            const workflow = new WorkflowPage(page);
            await loginAsSmokeUser(page, env);

            const ruleName = wfName('wf03-rule');
            const rule = await test.step('Rules → Create Rule: the own condition', async () => {
                const created = await workflow.createRule({ name: ruleName, resource: 'certificates', conditions: [condition.name] });
                return { ...recordCreated('rules', { uuid: created.uuid, name: ruleName }, SPEC, 'built in the UI form'), body: created.body };
            });
            const actionName = wfName('wf03-act');
            const action = await test.step('Actions → Create Action: the own execution', async () => {
                const created = await workflow.createAction({ name: actionName, resource: 'certificates', executions: [execution.name] });
                return { ...recordCreated('actions', { uuid: created.uuid, name: actionName }, SPEC, 'built in the UI form'), body: created.body };
            });

            const actionTriggerName = wfName('wf03-trig');
            const actionTrigger = await test.step('Triggers → Create Trigger: type Event, Certificate uploaded, the rule and the action', async () => {
                const created = await workflow.createTrigger({ name: actionTriggerName, resource: 'certificates', event: EVENT.uploaded, rules: [ruleName], actions: [actionName] });
                return { ...recordCreated('triggers', { uuid: created.uuid, name: actionTriggerName }, SPEC, 'built in the UI form (action trigger)'), body: created.body };
            });
            const ignoreTriggerName = wfName('wf03-ign');
            const ignoreTrigger = await test.step('Triggers → Create Trigger: an ignore trigger with the rule and no action', async () => {
                const created = await workflow.createTrigger({ name: ignoreTriggerName, resource: 'certificates', event: EVENT.uploaded, ignore: true, rules: [ruleName] });
                return { ...recordCreated('triggers', { uuid: created.uuid, name: ignoreTriggerName }, SPEC, 'built in the UI form (ignore trigger)'), body: created.body };
            });

            await test.step('API read-back: the rule and the action hold what the forms sent', async () => {
                const r = (await getKind(api, 'rules', rule.uuid)).json as Json;
                expect(r).toMatchObject({ name: ruleName, resource: 'certificates' });
                expect(r.conditions.map((c: Json) => c.uuid)).toEqual([condition.uuid]);
                const a = (await getKind(api, 'actions', action.uuid)).json as Json;
                expect(a).toMatchObject({ name: actionName, resource: 'certificates' });
                expect(a.executions.map((e: Json) => e.uuid)).toEqual([execution.uuid]);
            });

            await test.step('API read-back: the action trigger holds the rule, the action, type event and the event code', async () => {
                const t = (await getKind(api, 'triggers', actionTrigger.uuid)).json as Json;
                expect(t).toMatchObject({ name: actionTriggerName, type: 'event', event: EVENT.uploaded, resource: 'certificates', ignoreTrigger: false });
                expect(t.rules.map((x: Json) => x.uuid)).toEqual([rule.uuid]);
                expect(t.actions.map((x: Json) => x.uuid)).toEqual([action.uuid]);
                expect(actionTrigger.body, 'the form sent the same rule and action uuids').toMatchObject({ rulesUuids: [rule.uuid], actionsUuids: [action.uuid], ignoreTrigger: false });
            });

            await test.step('API read-back: the ignore trigger holds the rule and no action', async () => {
                const t = (await getKind(api, 'triggers', ignoreTrigger.uuid)).json as Json;
                expect(t).toMatchObject({ name: ignoreTriggerName, type: 'event', event: EVENT.uploaded, resource: 'certificates', ignoreTrigger: true });
                expect(t.rules.map((x: Json) => x.uuid)).toEqual([rule.uuid]);
                expect(t.actions).toHaveLength(0);
            });

            await test.step('The lists name both triggers; the UI detail shows the ignore switch on for the ignore trigger only', async () => {
                const names = (await listKind(api, 'triggers')).map((x) => x.name);
                expect(names).toEqual(expect.arrayContaining([actionTriggerName, ignoreTriggerName]));
                await workflow.openDetail('trigger', ignoreTrigger.uuid);
                await expect(workflow.ignoreSwitch).toBeChecked();
                await workflow.openDetail('trigger', actionTrigger.uuid);
                await expect(workflow.ignoreSwitch).not.toBeChecked();
            });

            await test.step('Nothing is associated: the platform-level list of Certificate uploaded names neither trigger (they cannot fire)', async () => {
                const platform = await getPlatformAssociations(api, EVENT.uploaded);
                expect(platform).not.toContain(actionTrigger.uuid);
                expect(platform).not.toContain(ignoreTrigger.uuid);
            });
        });
});
