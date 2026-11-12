/**
 * API-WFL-03 — Duplicate names on the five workflow kinds. ilm#438.
 *
 * WHAT: 1. For each kind (condition, rule, execution, action, trigger), a second create with the name of an existing own object → 409
 *          {message} "<Kind> with same name already exists."; a search by name still returns exactly the first object.
 * WHY: names are unique per kind (RuleServiceImpl, ActionServiceImpl, TriggerServiceImpl); 400, 404 and 409 bodies are {message}.
 * HOW: the first object is the run's own (an own group, condition, rule, execution, action and trigger, recorded in the ledger); the second
 *      request is a valid body with the same name, because core validates a trigger's structure before its name, so only a valid body
 *      proves the name check. One test per kind.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { createOwnGroup } from '../../../utils/regression/ownGroups';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { CERT_FIELD, conditionItem, createOwnAction, createOwnCondition, createOwnExecution, createOwnRule, createOwnTrigger, kindLabel, listKind, probeWorkflowObject, setGroupsAction, triggerBody, WORKFLOW_KINDS, WorkflowKind } from '../../../utils/regression/events/workflowObjects';
import { errorShapeOf, errorTexts } from '../../../utils/regression/events/workflowRequests';
import { runId } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';

test.describe('Duplicate names on the five workflow kinds', { tag: tags.api }, () => {
    for (const kind of WORKFLOW_KINDS) {
        test(`a second ${kindLabel(kind).toLowerCase()} with the same name is refused with 409 and the old one stays alone`,
            testMeta({
                id: 'API-WFL-03', prio: 'P1', issue: 'ilm#438',
                rule: ['duplicate names answer 409 "<Kind> with same name already exists." (RuleServiceImpl / ActionServiceImpl / TriggerServiceImpl)', '400 / 404 / 409 bodies are {message}'],
            }),
            async ({ api, own }) => {
                const group = await createOwnGroup(api, own.spec, 'wf03-group');
                const condition = await createOwnCondition(api, own.spec, 'wf03-cond', { items: [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', runId())] });
                const rule = await createOwnRule(api, own.spec, 'wf03-rule', { conditions: [condition] });
                const execution = await createOwnExecution(api, own.spec, 'wf03-exec', { items: [setGroupsAction([group.uuid])] });
                const action = await createOwnAction(api, own.spec, 'wf03-act', { executions: [execution] });
                const trigger = await createOwnTrigger(api, own.spec, 'wf03-trig', { event: EVENT.actionPerformed, rules: [rule], actions: [action] });
                const first = { conditions: condition, rules: rule, executions: execution, actions: action, triggers: trigger }[kind];

                // The same name, a body that is valid in every other respect.
                const bodies: Record<WorkflowKind, Record<string, unknown>> = {
                    conditions: { type: 'checkField', resource: 'certificates', items: [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', runId())] },
                    rules: { resource: 'certificates', conditionsUuids: [condition.uuid] },
                    executions: { type: 'setField', resource: 'certificates', items: [setGroupsAction([group.uuid])] },
                    actions: { resource: 'certificates', executionsUuids: [execution.uuid] },
                    triggers: triggerBody({ event: EVENT.actionPerformed, rules: [rule], actions: [action] }),
                };
                const sent = await probeWorkflowObject(api, own.spec, kind, { name: first.name, ...bodies[kind] }, `duplicate ${kind} probe`);

                expect(sent.status, `a second ${kind} with the same name is refused: ${sent.text.slice(0, 200)}`).toBe(409);
                expect(errorShapeOf(sent), '409 is a {message} body').toBe('message');
                expect(errorTexts(sent)).toEqual([`${kindLabel(kind)} with same name already exists.`]);
                const named = (await listKind(api, kind)).filter((r) => r.name === first.name);
                expect(named.map((r) => r.uuid), 'a search by name returns exactly the first object').toEqual([first.uuid]);
            });
    }
});
