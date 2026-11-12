/**
 * API-WFL-04 — Workflow validation negatives: empty-structure and type errors create nothing. ilm#438, core#700.
 *
 * WHAT: 1. A rule without conditions, a condition without items, an action without executions and an execution without items → 422 with the
 *          exact text of core (e.g. "Rule has to contain at least one condition.").
 *       2. A trigger that is not an ignore trigger needs an action; an ignore trigger cannot have actions; a trigger of type Event needs an
 *          event; a trigger resource of ANY or NONE is refused; the event must belong to the trigger's resource.
 *       3. A condition with resource ANY or NONE → 422 "Resource <Any|None> is not allowed for condition type Check Field".
 *       4. Control: the same kinds with valid content are accepted (the negatives test the rule, not the endpoint).
 *       Each refusal is a 422 JSON array of strings with no stack trace or SQL, and a search by the request name finds nothing.
 * WHY: core validates the structure when rules and triggers are created (core#700; RuleServiceImpl, ActionServiceImpl,
 *      TriggerServiceImpl.validateTriggerRequest).
 * HOW: every probe uses a run-prefixed name; a probe the platform ACCEPTED is recorded in the ledger before the assertion fails. The
 *      prerequisites of a row (an own group, an execution, an action) are own objects.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { createOwnGroup } from '../../../utils/regression/ownGroups';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { CERT_FIELD, conditionItem, createOwnAction, createOwnCondition, createOwnExecution, createOwnRule, listKind, probeWorkflowObject, setGroupsAction, triggerBody, WorkflowKind } from '../../../utils/regression/events/workflowObjects';
import { expectRefused } from '../../../utils/regression/errorContract';
import { errorShapeOf, errorTexts } from '../../../utils/regression/events/workflowRequests';
import { runId, ownName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';

const ITEM = conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', runId());

async function expectNothingCreated(api: Parameters<typeof listKind>[0], kind: WorkflowKind, name: string): Promise<void> {
    expect((await listKind(api, kind)).filter((r) => r.name === name), `no ${kind} named like the refused request exists`).toEqual([]);
}

test.describe('Workflow validation negatives (nothing created)', { tag: tags.api }, () => {
    const rowMeta = (row: string, rule: string) => testMeta({ id: 'API-WFL-04', prio: 'P1', issue: 'ilm#438', rule: [`core#700 (validation when creating rules and triggers), row ${row}: ${rule}`] });

    test('a rule without conditions is refused', rowMeta('a', 'Rule has to contain at least one condition.'), async ({ api, own }) => {
        const name = ownName('wf04-rule');
        const sent = await probeWorkflowObject(api, own.spec, 'rules', { name, resource: 'certificates', conditionsUuids: [] }, 'row a');
        expectRefused(sent, { status: 422, text: 'Rule has to contain at least one condition.', among: true });
        await expectNothingCreated(api, 'rules', name);
    });

    test('a condition without items is refused', rowMeta('b', 'Cannot create a condition without any condition items.'), async ({ api, own }) => {
        const name = ownName('wf04-cond');
        const sent = await probeWorkflowObject(api, own.spec, 'conditions', { name, type: 'checkField', resource: 'certificates', items: [] }, 'row b');
        expectRefused(sent, { status: 422, text: 'Cannot create a condition without any condition items.', among: true });
        await expectNothingCreated(api, 'conditions', name);
    });

    test('an action without executions is refused', rowMeta('c', 'Action has to contain at least one execution.'), async ({ api, own }) => {
        const name = ownName('wf04-act');
        const sent = await probeWorkflowObject(api, own.spec, 'actions', { name, resource: 'certificates', executionsUuids: [] }, 'row c');
        expectRefused(sent, { status: 422, text: 'Action has to contain at least one execution.', among: true });
        await expectNothingCreated(api, 'actions', name);
    });

    test('an execution without items is refused', rowMeta('d', 'Cannot create an execution without any execution items.'), async ({ api, own }) => {
        const name = ownName('wf04-exec');
        const sent = await probeWorkflowObject(api, own.spec, 'executions', { name, type: 'setField', resource: 'certificates', items: [] }, 'row d');
        expectRefused(sent, { status: 422, text: 'Cannot create an execution without any execution items.', among: true });
        await expectNothingCreated(api, 'executions', name);
    });

    test('a trigger that is not an ignore trigger needs at least one action', rowMeta('e', 'Trigger that is not ignore trigger must contain at least one action.'), async ({ api, own }) => {
        const name = ownName('wf04-trig');
        const sent = await probeWorkflowObject(api, own.spec, 'triggers', { name, ...triggerBody({ event: EVENT.actionPerformed }) }, 'row e');
        expectRefused(sent, { status: 422, text: 'Trigger that is not ignore trigger must contain at least one action.', among: true });
        await expectNothingCreated(api, 'triggers', name);
    });

    test('an ignore trigger cannot have actions', rowMeta('f', 'Trigger that is ignore trigger cannot have actions.'), async ({ api, own }) => {
        const group = await createOwnGroup(api, own.spec, 'wf04-group');
        const exec = await createOwnExecution(api, own.spec, 'wf04-exec', { items: [setGroupsAction([group.uuid])] });
        const act = await createOwnAction(api, own.spec, 'wf04-act', { executions: [exec] });
        const name = ownName('wf04-trig');
        const sent = await probeWorkflowObject(api, own.spec, 'triggers', { name, ...triggerBody({ event: EVENT.actionPerformed, ignore: true, actions: [act] }) }, 'row f');
        expectRefused(sent, { status: 422, text: 'Trigger that is ignore trigger cannot have actions.', among: true });
        await expectNothingCreated(api, 'triggers', name);
    });

    test('a trigger of type Event needs an event', rowMeta('g', 'When trigger type is Event, event has to be specified.'), async ({ api, own }) => {
        const name = ownName('wf04-trig');
        const sent = await probeWorkflowObject(api, own.spec, 'triggers', { name, type: 'event', resource: 'certificates', ignoreTrigger: true, rulesUuids: [], actionsUuids: [] }, 'row g');
        expectRefused(sent, { status: 422, text: 'When trigger type is Event, event has to be specified.', among: true });
        await expectNothingCreated(api, 'triggers', name);
    });

    for (const resource of ['ANY', 'NONE']) {
        test(`a trigger resource of ${resource} is refused`, rowMeta('h', 'Property resource cannot be empty or None/Any'), async ({ api, own }) => {
            const name = ownName('wf04-trig');
            const sent = await probeWorkflowObject(api, own.spec, 'triggers', { name, type: 'event', resource, event: EVENT.actionPerformed, ignoreTrigger: true, rulesUuids: [], actionsUuids: [] }, 'row h');
            expectRefused(sent, { status: 422, text: 'Property resource cannot be empty or None/Any', among: true });
            await expectNothingCreated(api, 'triggers', name);
        });
    }

    test('the event of an Event trigger must belong to the trigger\'s resource', rowMeta('i', 'Event resource (Certificate) and trigger (Discovery) resource has to match.'), async ({ api, own }) => {
        const name = ownName('wf04-trig');
        const sent = await probeWorkflowObject(api, own.spec, 'triggers', { name, ...triggerBody({ event: EVENT.actionPerformed, ignore: true, resource: 'discoveries' }) }, 'row i');
        expectRefused(sent, { status: 422, text: 'Event resource (Certificate) and trigger (Discovery) resource has to match.', among: true });
        await expectNothingCreated(api, 'triggers', name);
    });

    for (const resource of ['ANY', 'NONE']) {
        test(`a condition with resource ${resource} is refused`, rowMeta('j', 'Resource Any is not allowed for condition type Check Field'), async ({ api, own }) => {
            const name = ownName('wf04-cond');
            const sent = await probeWorkflowObject(api, own.spec, 'conditions', { name, type: 'checkField', resource, items: [ITEM] }, 'row j');
            expect(sent.status, `refused with 422: ${sent.text.slice(0, 300)}`).toBe(422);
            expect(errorShapeOf(sent)).toBe('array');
            // The text names the resource as the platform labels it (Any / None) and the condition type.
            expect(errorTexts(sent).join(' | ')).toMatch(new RegExp(`Resource ${resource === 'ANY' ? 'Any' : 'None'} is not allowed for condition type Check Field`));
            await expectNothingCreated(api, 'conditions', name);
        });
    }

    test('the same bodies with valid content are accepted (the negatives test the rule, not the endpoint)', rowMeta('control', 'valid structure is accepted'), async ({ api, own }) => {
        const group = await createOwnGroup(api, own.spec, 'wf04-ok-group');
        const condition = await createOwnCondition(api, own.spec, 'wf04-ok-cond', { items: [ITEM] });
        const rule = await createOwnRule(api, own.spec, 'wf04-ok-rule', { conditions: [condition] });
        const exec = await createOwnExecution(api, own.spec, 'wf04-ok-exec', { items: [setGroupsAction([group.uuid])] });
        const act = await createOwnAction(api, own.spec, 'wf04-ok-act', { executions: [exec] });
        expect([condition.uuid, rule.uuid, exec.uuid, act.uuid].every(Boolean)).toBe(true);
    });
});
