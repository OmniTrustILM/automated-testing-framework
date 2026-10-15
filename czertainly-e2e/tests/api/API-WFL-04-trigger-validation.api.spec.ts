/**
 * API-WFL-04 — empty-structure and type negatives of the workflow objects: nothing is created, each refusal is a 422 whose body
 * is a JSON array of strings with the exact text of core (T14 W8; TW03, TW04; core#700). Rows a–j of the plan's table P-04.
 *
 * Texts are read from the service code (`RuleServiceImpl`, `ActionServiceImpl`, `TriggerServiceImpl.validateTriggerRequest`):
 *   a rule without conditions      "Rule has to contain at least one condition."
 *   b condition without items      "Cannot create a condition without any condition items."
 *   c action without executions    "Action has to contain at least one execution."
 *   d execution without items      "Cannot create an execution without any execution items."
 *   e trigger without actions      "Trigger that is not ignore trigger must contain at least one action."
 *   f ignore trigger with actions  "Trigger that is ignore trigger cannot have actions."
 *   g type Event without an event  "When trigger type is Event, event has to be specified."
 *   h resource None / Any          "Property resource cannot be empty or None/Any"
 *   i event resource ≠ trigger     "Event resource (Certificate) and trigger (Discovery) resource has to match."
 *   j condition resource Any       "Resource Any is not allowed for condition type Check Field"
 * Every probe uses a run-prefixed name; a probe the platform ACCEPTED is recorded before the assertion fails, and a search by
 * the request name afterwards must find nothing.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnGroup } from '../../utils/regression/eventsDrivers';
import {
    CERT_FIELD, conditionItem, createOwnAction, createOwnCondition, createOwnExecution, createOwnRule, errorShapeOf, errorTexts, EVENT, listKind, probeCreate, Sent,
    setGroups, triggerBody, wfName, WorkflowKind,
} from '../../utils/regression/workflowApi';
import { RUN_ID } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-WFL-04';

const ITEM = conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', RUN_ID);

function expectRefused(sent: Sent, text: string): void {
    expect(sent.status, `refused with 422: ${sent.text.slice(0, 300)}`).toBe(422);
    expect(errorShapeOf(sent), '422 is a JSON array of strings').toBe('array');
    expect(errorTexts(sent)).toContain(text);
    // The platform never answers a stack trace or SQL.
    expect(sent.text).not.toMatch(/\bat [a-z]+\.[A-Za-z.]+\(|SQLState|org\.hibernate|Exception:/);
}

async function expectNothingCreated(api: Parameters<typeof listKind>[0], kind: WorkflowKind, name: string): Promise<void> {
    expect((await listKind(api, kind)).filter((r) => r.name === name), `no ${kind} named like the refused request exists`).toEqual([]);
}

test.describe('API-WFL-04 workflow validation negatives (nothing created)', { tag: tags.api }, () => {
    const m = (row: string, rule: string) => meta({ id: 'API-WFL-04', prio: 'P1', issue: 'ilm#438', rule: [`T14 W8 (validation texts), core#700 (validation when creating rules and triggers); P-04 row ${row}: ${rule}`] });

    test('API-WFL-04[a]: a rule without conditions is refused', m('a', 'Rule has to contain at least one condition.'), async ({ api }) => {
        const name = wfName('wf04-rule');
        const sent = await probeCreate(api, 'rules', { name, resource: 'certificates', conditionsUuids: [] }, SPEC, 'row a');
        expectRefused(sent, 'Rule has to contain at least one condition.');
        await expectNothingCreated(api, 'rules', name);
    });

    test('API-WFL-04[b]: a condition without items is refused', m('b', 'Cannot create a condition without any condition items.'), async ({ api }) => {
        const name = wfName('wf04-cond');
        const sent = await probeCreate(api, 'conditions', { name, type: 'checkField', resource: 'certificates', items: [] }, SPEC, 'row b');
        expectRefused(sent, 'Cannot create a condition without any condition items.');
        await expectNothingCreated(api, 'conditions', name);
    });

    test('API-WFL-04[c]: an action without executions is refused', m('c', 'Action has to contain at least one execution.'), async ({ api }) => {
        const name = wfName('wf04-act');
        const sent = await probeCreate(api, 'actions', { name, resource: 'certificates', executionsUuids: [] }, SPEC, 'row c');
        expectRefused(sent, 'Action has to contain at least one execution.');
        await expectNothingCreated(api, 'actions', name);
    });

    test('API-WFL-04[d]: an execution without items is refused', m('d', 'Cannot create an execution without any execution items.'), async ({ api }) => {
        const name = wfName('wf04-exec');
        const sent = await probeCreate(api, 'executions', { name, type: 'setField', resource: 'certificates', items: [] }, SPEC, 'row d');
        expectRefused(sent, 'Cannot create an execution without any execution items.');
        await expectNothingCreated(api, 'executions', name);
    });

    test('API-WFL-04[e]: a trigger that is not an ignore trigger needs at least one action', m('e', 'Trigger that is not ignore trigger must contain at least one action.'), async ({ api }) => {
        const name = wfName('wf04-trig');
        const sent = await probeCreate(api, 'triggers', { name, ...triggerBody({ event: EVENT.actionPerformed }) }, SPEC, 'row e');
        expectRefused(sent, 'Trigger that is not ignore trigger must contain at least one action.');
        await expectNothingCreated(api, 'triggers', name);
    });

    test('API-WFL-04[f]: an ignore trigger cannot have actions', m('f', 'Trigger that is ignore trigger cannot have actions.'), async ({ api }) => {
        const group = await createOwnGroup(api, SPEC, 'wf04-group');
        const exec = await createOwnExecution(api, SPEC, { suffix: 'wf04-exec', items: [setGroups([group.uuid])] });
        const act = await createOwnAction(api, SPEC, { suffix: 'wf04-act', executions: [exec] });
        const name = wfName('wf04-trig');
        const sent = await probeCreate(api, 'triggers', { name, ...triggerBody({ event: EVENT.actionPerformed, ignore: true, actions: [act] }) }, SPEC, 'row f');
        expectRefused(sent, 'Trigger that is ignore trigger cannot have actions.');
        await expectNothingCreated(api, 'triggers', name);
    });

    test('API-WFL-04[g]: a trigger of type Event needs an event', m('g', 'When trigger type is Event, event has to be specified.'), async ({ api }) => {
        const name = wfName('wf04-trig');
        const sent = await probeCreate(api, 'triggers', { name, type: 'event', resource: 'certificates', ignoreTrigger: true, rulesUuids: [], actionsUuids: [] }, SPEC, 'row g');
        expectRefused(sent, 'When trigger type is Event, event has to be specified.');
        await expectNothingCreated(api, 'triggers', name);
    });

    for (const resource of ['ANY', 'NONE']) {
        test(`API-WFL-04[h:${resource}]: a trigger resource of ${resource} is refused`, m('h', 'Property resource cannot be empty or None/Any'), async ({ api }) => {
            const name = wfName('wf04-trig');
            const sent = await probeCreate(api, 'triggers', { name, type: 'event', resource, event: EVENT.actionPerformed, ignoreTrigger: true, rulesUuids: [], actionsUuids: [] }, SPEC, 'row h');
            expectRefused(sent, 'Property resource cannot be empty or None/Any');
            await expectNothingCreated(api, 'triggers', name);
        });
    }

    test('API-WFL-04[i]: the event of an Event trigger must belong to the trigger\'s resource', m('i', 'Event resource (Certificate) and trigger (Discovery) resource has to match.'), async ({ api }) => {
        const name = wfName('wf04-trig');
        const sent = await probeCreate(api, 'triggers', { name, ...triggerBody({ event: EVENT.actionPerformed, ignore: true, resource: 'discoveries' }) }, SPEC, 'row i');
        expectRefused(sent, 'Event resource (Certificate) and trigger (Discovery) resource has to match.');
        await expectNothingCreated(api, 'triggers', name);
    });

    for (const resource of ['ANY', 'NONE']) {
        test(`API-WFL-04[j:${resource}]: a condition with resource ${resource} is refused`, m('j', 'Resource Any is not allowed for condition type Check Field'), async ({ api }) => {
            const name = wfName('wf04-cond');
            const sent = await probeCreate(api, 'conditions', { name, type: 'checkField', resource, items: [ITEM] }, SPEC, 'row j');
            expect(sent.status, `refused with 422: ${sent.text.slice(0, 300)}`).toBe(422);
            expect(errorShapeOf(sent)).toBe('array');
            // The text names the resource as the platform labels it (Any / None) and the condition type.
            expect(errorTexts(sent).join(' | ')).toMatch(new RegExp(`Resource ${resource === 'ANY' ? 'Any' : 'None'} is not allowed for condition type Check Field`));
            await expectNothingCreated(api, 'conditions', name);
        });
    }

    test('API-WFL-04[control]: the same bodies with valid content are accepted (the negatives test the rule, not the endpoint)', m('control', 'valid structure is accepted'), async ({ api }) => {
        const group = await createOwnGroup(api, SPEC, 'wf04-ok-group');
        const condition = await createOwnCondition(api, SPEC, { suffix: 'wf04-ok-cond', items: [ITEM] });
        const rule = await createOwnRule(api, SPEC, { suffix: 'wf04-ok-rule', conditions: [condition] });
        const exec = await createOwnExecution(api, SPEC, { suffix: 'wf04-ok-exec', items: [setGroups([group.uuid])] });
        const act = await createOwnAction(api, SPEC, { suffix: 'wf04-ok-act', executions: [exec] });
        expect([condition.uuid, rule.uuid, exec.uuid, act.uuid].every(Boolean)).toBe(true);
    });
});
