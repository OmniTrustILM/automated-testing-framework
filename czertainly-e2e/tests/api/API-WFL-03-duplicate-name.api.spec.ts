/**
 * API-WFL-03 — a second create with the name of an existing object is refused on each of the five workflow kinds
 * (T14 W8: "Condition|Rule|Execution|Action|Trigger with same name already exists.", HTTP 409 `{message}`; TW03).
 *
 * One test per kind. The first object is the run's own (recorded), the second request is a VALID body with the same name (core
 * validates a trigger's structure before its name, so only a valid body proves the name check); a search by name must still
 * return exactly one object. A duplicate the platform accepted is recorded by `probeCreate` before the assertion fails.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnGroup } from '../../utils/regression/eventsDrivers';
import {
    CERT_FIELD, conditionItem, createOwnAction, createOwnCondition, createOwnExecution, createOwnRule, createOwnTrigger, errorShapeOf, errorTexts, EVENT,
    kindLabel, listKind, probeCreate, setGroups, triggerBody, WORKFLOW_KINDS, WorkflowKind,
} from '../../utils/regression/workflowApi';
import { RUN_ID } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-WFL-03';

test.describe('API-WFL-03 duplicate names on the five workflow kinds', { tag: tags.api }, () => {
    for (const kind of WORKFLOW_KINDS) {
        test(`API-WFL-03[${kind}]: a second ${kindLabel(kind).toLowerCase()} with the same name is refused with 409 and the old one stays alone`,
            meta({
                id: 'API-WFL-03', prio: 'P1', issue: 'ilm#438',
                rule: ['T14 W8: duplicate names answer 409 "<Kind> with same name already exists." (RuleServiceImpl / ActionServiceImpl / TriggerServiceImpl)', 'T14 TW03; Phase 1 §9.3 (400 / 404 / 409 bodies are {message})'],
            }),
            async ({ api }) => {
                const group = await createOwnGroup(api, SPEC, 'wf03-group');
                const condition = await createOwnCondition(api, SPEC, { suffix: 'wf03-cond', items: [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', RUN_ID)] });
                const rule = await createOwnRule(api, SPEC, { suffix: 'wf03-rule', conditions: [condition] });
                const execution = await createOwnExecution(api, SPEC, { suffix: 'wf03-exec', items: [setGroups([group.uuid])] });
                const action = await createOwnAction(api, SPEC, { suffix: 'wf03-act', executions: [execution] });
                const trigger = await createOwnTrigger(api, SPEC, { suffix: 'wf03-trig', event: EVENT.actionPerformed, rules: [rule], actions: [action] });
                const first = { conditions: condition, rules: rule, executions: execution, actions: action, triggers: trigger }[kind];

                // The same name, a body that is valid in every other respect.
                const bodies: Record<WorkflowKind, Record<string, unknown>> = {
                    conditions: { type: 'checkField', resource: 'certificates', items: [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', RUN_ID)] },
                    rules: { resource: 'certificates', conditionsUuids: [condition.uuid] },
                    executions: { type: 'setField', resource: 'certificates', items: [setGroups([group.uuid])] },
                    actions: { resource: 'certificates', executionsUuids: [execution.uuid] },
                    triggers: triggerBody({ event: EVENT.actionPerformed, rules: [rule], actions: [action] }),
                };
                const sent = await probeCreate(api, kind, { name: first.name, ...bodies[kind] }, SPEC, `duplicate ${kind} probe`);

                expect(sent.status, `a second ${kind} with the same name is refused: ${sent.text.slice(0, 200)}`).toBe(409);
                expect(errorShapeOf(sent), '409 is a {message} body').toBe('message');
                expect(errorTexts(sent)).toEqual([`${kindLabel(kind)} with same name already exists.`]);
                const named = (await listKind(api, kind)).filter((r) => r.name === first.name);
                expect(named.map((r) => r.uuid), 'a search by name returns exactly the first object').toEqual([first.uuid]);
            });
    }
});
