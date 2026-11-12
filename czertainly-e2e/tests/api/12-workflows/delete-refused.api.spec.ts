/**
 * API-WFL-06 — A workflow object that another object still references cannot be deleted. ilm#438.
 *
 * WHAT: 1. Condition → rule → trigger, execution → action → trigger and trigger → event association on an own group: DELETE of each
 *          referenced object answers 422 naming the parent (e.g. "Cannot delete rule <name>. It is associated to following triggers:
 *          <name>."; for a trigger "Cannot delete trigger. It has 1 event
 *          association(s): …") and the object still exists.
 *       2. After the association is cleared and the parents are removed bottom-up (trigger, rule, condition, action, execution), every
 *          delete answers 204 and the object is gone (404).
 * WHY: deletes are refused while referenced, naming the parent (PR core#1050; RuleServiceImpl, ActionServiceImpl,
 *      TriggerServiceImpl.deleteTrigger); ilm#438 step 23.
 * HOW: own objects only; the association is on an own group at object level, so it touches nothing platform-wide. The refusals are asserted
 *      first, on an intact chain; the unwinding deletes run only while deleting own objects is on (`API_DELETE_OWN`, default on; with it
 *      off the objects stay for the teardown and the test skips
 *      there with that reason).
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { createOwnGroup } from '../../../utils/regression/ownGroups';
import { mayDeleteOwn } from '../../../utils/regression/ledger/ownership';
import { associateTriggers, clearAssociation, getAssociations } from '../../../utils/regression/events/eventAssociations';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { CERT_FIELD, conditionItem, createOwnChain, deleteOwnWorkflowObject, getKind, setGroupsAction, WorkflowKind } from '../../../utils/regression/events/workflowObjects';
import { errorShapeOf, errorTexts } from '../../../utils/regression/events/workflowRequests';
import { runId } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { API_STANDARD_TEST_MS } from '../../../utils/regression/timeouts';

test.describe('Delete refused while referenced', { tag: tags.api }, () => {
    test('a referenced object refuses its delete and names the parent, and afterwards it deletes with 204',
        testMeta({
            id: 'API-WFL-06', prio: 'P1', issue: 'ilm#438',
            rule: [
                'delete refused while referenced, the parent named: PR core#1050; RuleServiceImpl / ActionServiceImpl / TriggerServiceImpl.deleteTrigger',
                'ilm#438 step 23 (condition / rule / execution / action, and an associated trigger)',
            ],
        }),
        async ({ api, own }) => {
            test.setTimeout(API_STANDARD_TEST_MS);
            const group = await createOwnGroup(api, own.spec, 'wf06-group');
            const chain = await createOwnChain(api, own.spec, 'wf06', { event: EVENT.actionPerformed, items: [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', runId())], executionItems: [setGroupsAction([group.uuid])] });
            const { condition, rule, execution, action, trigger } = chain as Required<typeof chain>;

            await test.step('Associate the trigger on the own group (object level, replace-all of that scope only)', async () => {
                const sent = await associateTriggers(api, own.spec, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggers: [trigger] });
                expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
                expect((await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed]).toEqual([trigger.uuid]);
            });

            const refused: Array<[WorkflowKind, { uuid: string; name: string }, string]> = [
                ['conditions', condition, `Cannot delete condition ${condition.name}. It is associated to following rules: ${rule.name}.`],
                ['rules', rule, `Cannot delete rule ${rule.name}. It is associated to following triggers: ${trigger.name}.`],
                ['executions', execution, `Cannot delete execution ${execution.name}. It is associated to following actions: ${action.name}.`],
                ['actions', action, `Cannot delete action ${action.name}. It is associated to following triggers: ${trigger.name}.`],
                ['triggers', trigger, `Cannot delete trigger. It has 1 event association(s): Certificate action performed (Group ${group.uuid})`],
            ];
            for (const [kind, ref, text] of refused) {
                await test.step(`DELETE ${kind}: 422 naming the parent, the object still exists`, async () => {
                    const sent = await deleteOwnWorkflowObject(api, kind, { ...ref, kind: 'own' }, own.spec);
                    expect(sent.status, `DELETE ${kind} while referenced: ${sent.text.slice(0, 300)}`).toBe(422);
                    expect(errorShapeOf(sent), `DELETE ${kind}: the 422 is an array of messages`).toBe('array');
                    expect(errorTexts(sent), `DELETE ${kind}: the 422 names the parent`).toContain(text);
                    expect((await getKind(api, kind, ref.uuid)).status, `GET ${kind} after the refused delete`).toBe(200);
                });
            }

            test.skip(!mayDeleteOwn(), 'own deletes are off (API_DELETE_OWN=0): the refusals above are the result; the objects stay for the teardown');

            await test.step('Remove the association (empty list), then the parents bottom-up: every delete answers 204', async () => {
                const cleared = await clearAssociation(api, own.spec, { event: EVENT.actionPerformed, resource: 'groups', object: group });
                expect(cleared.status, cleared.text.slice(0, 200)).toBeLessThan(300);
                expect((await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed] ?? []).toEqual([]);
                const order: Array<[WorkflowKind, { uuid: string; name: string }]> = [
                    ['triggers', trigger], ['rules', rule], ['conditions', condition], ['actions', action], ['executions', execution],
                ];
                for (const [kind, ref] of order) {
                    const sent = await deleteOwnWorkflowObject(api, kind, { ...ref, kind: 'own' }, own.spec);
                    expect(sent.status, `DELETE ${kind} once unreferenced: ${sent.text.slice(0, 300)}`).toBe(204);
                    expect((await getKind(api, kind, ref.uuid)).status, `GET ${kind} after its delete`).toBe(404);
                }
            });
        });
});
