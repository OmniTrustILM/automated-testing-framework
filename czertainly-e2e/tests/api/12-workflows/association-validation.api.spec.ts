/**
 * API-WFL-07 — Event association validation on an own group. ilm#438, core#1071.
 *
 * WHAT: 1. A group cannot override Certificate uploaded, discovered, Discovery finished, approval requested or Scheduled job finished → 422
 *          "Resource Group cannot be associated with event <label>."; nothing is associated with the refused event.
 *       2. A trigger of another resource than the event's → 422 "Trigger '<name>' is for different resource (<R>) than event '<label>'
 *          (<R>)"; a trigger bound to another event → 422 "Trigger '<name>' is for different event (<label>) than event '<label>'".
 *       3. Control: a group may override Certificate action performed; two own triggers are accepted and listed in order.
 *       After every refusal the scope's list is unchanged.
 * WHY: each refusal is a 422 with the exact text of TriggerServiceImpl.createTriggerAssociations; a runtime refusal rolls the
 *      replace-delete back, so the list stays as it was.
 * HOW: own group holding one own control trigger (so "unchanged" is provable); own triggers and chains recorded in the ledger before the
 *      first assertion. A request naming an unknown trigger is NOT sent here: its NotFoundException may commit the replace-delete first, so
 *      that case is local-stack only.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { createOwnGroup } from '../../../utils/regression/ownGroups';
import { associateTriggers, getAssociations, probeAssociation } from '../../../utils/regression/events/eventAssociations';
import { EVENT, EVENT_LABEL, EventCode } from '../../../utils/regression/events/eventVocabulary';
import { createOwnChain, createOwnTrigger, setGroupsAction } from '../../../utils/regression/events/workflowObjects';
import { errorShapeOf, errorTexts } from '../../../utils/regression/events/workflowRequests';
import { testMeta, tags } from '../../../utils/regression/tags';

test.describe('Association validation on an own group', { tag: tags.api }, () => {
    const rowMeta = (row: string, rule: string) => testMeta({ id: 'API-WFL-07', prio: 'P1', issue: 'ilm#438', rule: [`core#1071 (association validation), row ${row}: ${rule}`] });

    /** A group that already holds one own control trigger on Certificate action performed (so "unchanged" is provable). */
    async function scopeWithControl(api: Parameters<typeof createOwnGroup>[0], spec: string) {
        const group = await createOwnGroup(api, spec, 'wf07-group');
        const control = await createOwnChain(api, spec, 'wf07-ctl', { event: EVENT.actionPerformed, executionItems: [setGroupsAction([group.uuid])] });
        const sent = await associateTriggers(api, spec, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggers: [control.trigger] });
        expect(sent.status, `row f control: a group may override Certificate action performed: ${sent.text.slice(0, 300)}`).toBeLessThan(300);
        expect((await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed], 'the control is listed').toEqual([control.trigger.uuid]);
        return { group, control, executionItems: [setGroupsAction([group.uuid])] };
    }

    const refusedEvents: EventCode[] = [EVENT.uploaded, EVENT.discovered, EVENT.discoveryFinished, EVENT.approvalRequested, EVENT.scheduledJobFinished];
    for (const event of refusedEvents) {
        test(`a group cannot override ${EVENT_LABEL[event]}`, rowMeta('a–c', 'Resource Group cannot be associated with event <label>.'), async ({ api, own }) => {
            const { group, control } = await scopeWithControl(api, own.spec);
            const sent = await probeAssociation(api, own.spec, { event, resource: 'groups', object: group, triggerUuids: [control.trigger.uuid] });
            expect(sent.status, sent.text.slice(0, 300)).toBe(422);
            expect(errorShapeOf(sent)).toBe('array');
            expect(errorTexts(sent)).toContain(`Resource Group cannot be associated with event ${EVENT_LABEL[event]}.`);
            expect((await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed], 'the scope\'s list is unchanged').toEqual([control.trigger.uuid]);
            expect(Object.keys(await getAssociations(api, 'groups', group.uuid)), 'nothing was associated with the refused event').not.toContain(event);
        });
    }

    test('a trigger of another resource than the event\'s is refused', rowMeta('d', 'Trigger is for different resource'), async ({ api, own }) => {
        const { group, control } = await scopeWithControl(api, own.spec);
        // An ignore trigger of resource Discovery (event Discovery finished): no rules, no actions needed.
        const other = await createOwnTrigger(api, own.spec, 'wf07-disc', { resource: 'discoveries', event: EVENT.discoveryFinished, ignore: true });
        const sent = await probeAssociation(api, own.spec, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggerUuids: [other.uuid] });
        expect(sent.status, sent.text.slice(0, 300)).toBe(422);
        expect(errorTexts(sent)).toContain(`Trigger '${other.name}' is for different resource (Discovery) than event '${EVENT_LABEL[EVENT.actionPerformed]}' (Certificate)`);
        expect((await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed], 'the scope\'s list is unchanged').toEqual([control.trigger.uuid]);
    });

    test('a trigger bound to another event than the one it is associated with is refused', rowMeta('e', 'Trigger is for different event'), async ({ api, own }) => {
        const { group, control } = await scopeWithControl(api, own.spec);
        const bound = await createOwnTrigger(api, own.spec, 'wf07-status', { event: EVENT.statusChanged, ignore: true });
        const sent = await probeAssociation(api, own.spec, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggerUuids: [bound.uuid] });
        expect(sent.status, sent.text.slice(0, 300)).toBe(422);
        expect(errorTexts(sent)).toContain(`Trigger '${bound.name}' is for different event (${EVENT_LABEL[EVENT.statusChanged]}) than event '${EVENT_LABEL[EVENT.actionPerformed]}'`);
        expect((await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed], 'the scope\'s list is unchanged').toEqual([control.trigger.uuid]);
    });

    test('a group may override Certificate action performed (control: accepted and listed)', rowMeta('f', 'accepted'), async ({ api, own }) => {
        const { group, control } = await scopeWithControl(api, own.spec);
        const second = await createOwnChain(api, own.spec, 'wf07-second', { event: EVENT.actionPerformed, executionItems: [setGroupsAction([group.uuid])] });
        const sent = await associateTriggers(api, own.spec, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggers: [control.trigger, second.trigger] });
        expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
        expect((await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed]).toEqual([control.trigger.uuid, second.trigger.uuid]);
    });
});
