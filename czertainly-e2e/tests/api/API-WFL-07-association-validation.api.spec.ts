/**
 * API-WFL-07 — event association validation on an OWN group (ilm#438 step 24; T14 W2, W3; TW12; core#1071):
 * the event is not overridable by that object, the trigger's resource differs from the event's resource, the trigger is bound
 * to another event. Every refusal is a 422 with the exact text of `TriggerServiceImpl.createTriggerAssociations` and the scope's
 * list stays UNCHANGED (the class is transactional: a runtime refusal rolls the replace-delete back). Row f is the control:
 * a group may override Certificate action performed.
 *
 * The plan's table P-07 names "own RA profile / own group": the group scope needs no CA, so the rows run on a group; the RA
 * profile variant of rows a–c only changes the resource label in the text ("RA Profile"). Texts:
 *   a/b/c "Resource Group cannot be associated with event <Event label>."
 *   d     "Trigger '<name>' is for different resource (Discovery) than event 'Certificate action performed' (Certificate)"
 *   e     "Trigger '<name>' is for different event (Certificate validation status changed) than event 'Certificate action performed'"
 * A refused request that names an unknown trigger is NOT sent here (the checked NotFoundException may commit the replace-delete
 * first: T14 C12, API-WFL-18, local-stack only).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnGroup } from '../../utils/regression/eventsDrivers';
import {
    associateTriggers, createOwnChain, createOwnTrigger, errorShapeOf, errorTexts, EVENT, EVENT_LABEL, EventCode, getAssociations, probeAssociation,
    setGroups,
} from '../../utils/regression/workflowApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-WFL-07';

test.describe('API-WFL-07 association validation on an own group', { tag: tags.api }, () => {
    const m = (row: string, rule: string) => meta({ id: 'API-WFL-07', prio: 'P1', issue: 'ilm#438', rule: [`T14 W2 / W3 (association validation), core#1071; P-07 row ${row}: ${rule}`] });

    /** A group that already holds one own control trigger on Certificate action performed (so "unchanged" is provable). */
    async function scopeWithControl(api: Parameters<typeof createOwnGroup>[0]) {
        const group = await createOwnGroup(api, SPEC, 'wf07-group');
        const control = await createOwnChain(api, SPEC, { suffix: 'wf07-ctl', event: EVENT.actionPerformed, executionItems: [setGroups([group.uuid])] });
        const sent = await associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggers: [control.trigger] });
        expect(sent.status, `row f control: a group may override Certificate action performed: ${sent.text.slice(0, 300)}`).toBeLessThan(300);
        expect((await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed], 'the control is listed').toEqual([control.trigger.uuid]);
        return { group, control, executionItems: [setGroups([group.uuid])] };
    }

    const refusedEvents: EventCode[] = [EVENT.uploaded, EVENT.discovered, EVENT.discoveryFinished, EVENT.approvalRequested, EVENT.scheduledJobFinished];
    for (const event of refusedEvents) {
        test(`API-WFL-07[${event}]: a group cannot override ${EVENT_LABEL[event]}`, m('a–c', 'Resource Group cannot be associated with event <label>.'), async ({ api }) => {
            const { group, control } = await scopeWithControl(api);
            const sent = await probeAssociation(api, SPEC, { event, resource: 'groups', object: group, triggerUuids: [control.trigger.uuid] });
            expect(sent.status, sent.text.slice(0, 300)).toBe(422);
            expect(errorShapeOf(sent)).toBe('array');
            expect(errorTexts(sent)).toContain(`Resource Group cannot be associated with event ${EVENT_LABEL[event]}.`);
            expect((await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed], 'the scope\'s list is unchanged').toEqual([control.trigger.uuid]);
            expect(Object.keys(await getAssociations(api, 'groups', group.uuid)), 'nothing was associated with the refused event').not.toContain(event);
        });
    }

    test('API-WFL-07[d]: a trigger of another resource than the event\'s is refused', m('d', 'Trigger is for different resource'), async ({ api }) => {
        const { group, control } = await scopeWithControl(api);
        // An ignore trigger of resource Discovery (event Discovery finished): no rules, no actions needed.
        const other = await createOwnTrigger(api, SPEC, { suffix: 'wf07-disc', resource: 'discoveries', event: EVENT.discoveryFinished, ignore: true });
        const sent = await probeAssociation(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggerUuids: [other.uuid] });
        expect(sent.status, sent.text.slice(0, 300)).toBe(422);
        expect(errorTexts(sent)).toContain(`Trigger '${other.name}' is for different resource (Discovery) than event '${EVENT_LABEL[EVENT.actionPerformed]}' (Certificate)`);
        expect((await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed], 'the scope\'s list is unchanged').toEqual([control.trigger.uuid]);
    });

    test('API-WFL-07[e]: a trigger bound to another event than the one it is associated with is refused', m('e', 'Trigger is for different event'), async ({ api }) => {
        const { group, control } = await scopeWithControl(api);
        const bound = await createOwnTrigger(api, SPEC, { suffix: 'wf07-status', event: EVENT.statusChanged, ignore: true });
        const sent = await probeAssociation(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggerUuids: [bound.uuid] });
        expect(sent.status, sent.text.slice(0, 300)).toBe(422);
        expect(errorTexts(sent)).toContain(`Trigger '${bound.name}' is for different event (${EVENT_LABEL[EVENT.statusChanged]}) than event '${EVENT_LABEL[EVENT.actionPerformed]}'`);
        expect((await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed], 'the scope\'s list is unchanged').toEqual([control.trigger.uuid]);
    });

    test('API-WFL-07[f]: a group may override Certificate action performed (control: accepted and listed)', m('f', 'accepted'), async ({ api }) => {
        const { group, control } = await scopeWithControl(api);
        const second = await createOwnChain(api, SPEC, { suffix: 'wf07-second', event: EVENT.actionPerformed, executionItems: [setGroups([group.uuid])] });
        const sent = await associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggers: [control.trigger, second.trigger] });
        expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
        expect((await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed]).toEqual([control.trigger.uuid, second.trigger.uuid]);
    });
});
