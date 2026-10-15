/**
 * API-WFL-06 — a workflow object that another object still references cannot be deleted, and the refusal names the parent
 * (ilm#438 step 23; T14 W7; TW10, TW11): condition → rule → trigger, execution → action → trigger, and trigger → event association.
 * After the parent (or the association) is removed the delete succeeds (204).
 *
 * Own objects only: the association is on an OWN GROUP (an overriding object of Certificate events, T14 W1), object level, so it
 * touches nothing platform-wide. The refusals are asserted first, on a chain that is intact; the unwinding deletes are the
 * behaviour under test (`deleteOwn` records them) and run only while deleting own objects is on (D1: `API_DELETE_OWN`, default on;
 * with it off the objects stay for the teardown). Texts (core):
 *   condition  "Cannot delete condition <name>. It is associated to following rules: <rule>."
 *   rule       "Cannot delete rule <name>. It is associated to following triggers: <trigger>."
 *   execution  "Cannot delete execution <name>. It is associated to following actions: <action>."
 *   action     "Cannot delete action <name>. It is associated to following triggers: <trigger>."
 *   trigger    "Cannot delete trigger. It has 1 event association(s): Certificate action performed (Group <uuid>)"
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnGroup } from '../../utils/regression/eventsDrivers';
import { mayDeleteOwn } from '../../utils/regression/ownObjects';
import {
    associateTriggers, CERT_FIELD, clearAssociation, conditionItem, createOwnChain, deleteOwn, errorShapeOf, errorTexts, EVENT, getAssociations, getKind, setGroups,
    WorkflowKind,
} from '../../utils/regression/workflowApi';
import { RUN_ID } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-WFL-06';

test.describe('API-WFL-06 delete refused while referenced', { tag: tags.api }, () => {
    test('API-WFL-06: condition, rule, execution, action and associated trigger refuse their delete and name the parent; after the parent goes the delete is 204',
        meta({
            id: 'API-WFL-06', prio: 'P1', issue: 'ilm#438',
            rule: [
                'T14 W7 (delete refused while referenced, the parent named: PR core#1050; RuleServiceImpl / ActionServiceImpl / TriggerServiceImpl.deleteTrigger)',
                'ilm#438 step 23; TW10 (condition / rule / execution / action), TW11 (associated trigger)',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(120_000);
            const group = await createOwnGroup(api, SPEC, 'wf06-group');
            const chain = await createOwnChain(api, SPEC, {
                suffix: 'wf06', event: EVENT.actionPerformed, items: [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', RUN_ID)], executionItems: [setGroups([group.uuid])],
            });
            const { condition, rule, execution, action, trigger } = chain as Required<typeof chain>;

            await test.step('Associate the trigger on the own group (object level, replace-all of that scope only)', async () => {
                const sent = await associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggers: [trigger] });
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
                    const sent = await deleteOwn(api, kind, { ...ref, kind: 'own' }, SPEC);
                    expect(sent.status, `DELETE ${kind} while referenced: ${sent.text.slice(0, 300)}`).toBe(422);
                    expect(errorShapeOf(sent)).toBe('array');
                    expect(errorTexts(sent)).toContain(text);
                    expect((await getKind(api, kind, ref.uuid)).status, `GET ${kind} after the refused delete`).toBe(200);
                });
            }

            test.skip(!mayDeleteOwn(), 'own deletes are off (API_DELETE_OWN=0): the refusals above are the result; the objects stay for the teardown');

            await test.step('Remove the association (empty list), then the parents bottom-up: every delete answers 204', async () => {
                const cleared = await clearAssociation(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group });
                expect(cleared.status, cleared.text.slice(0, 200)).toBeLessThan(300);
                expect((await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed] ?? []).toEqual([]);
                const order: Array<[WorkflowKind, { uuid: string; name: string }]> = [
                    ['triggers', trigger], ['rules', rule], ['conditions', condition], ['actions', action], ['executions', execution],
                ];
                for (const [kind, ref] of order) {
                    const sent = await deleteOwn(api, kind, { ...ref, kind: 'own' }, SPEC);
                    expect(sent.status, `DELETE ${kind} once unreferenced: ${sent.text.slice(0, 300)}`).toBe(204);
                    expect((await getKind(api, kind, ref.uuid)).status, `GET ${kind} after its delete`).toBe(404);
                }
            });
        });
});
