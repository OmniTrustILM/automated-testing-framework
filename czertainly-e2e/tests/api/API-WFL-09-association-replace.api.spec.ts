/**
 * API-WFL-09 — an event association REPLACES the scope's list and keeps the request order; ignore triggers are ordered first
 * whatever their position in the request (T14 W4, W5; TW; `TriggerServiceImpl.createTriggerAssociations`: `replace = true` is
 * hard-wired, ignore triggers get the orders -N…-1, action triggers 0…n in request order).
 *
 * On an OWN group (object level; no platform setting is touched):
 *   POST [A, B] → GET [A, B]            POST [B]  → GET [B]  (replaced, not additive)
 *   POST [A, I] → GET [I, A]            the ignore trigger I comes first although the request lists it last
 *   POST []     → GET no list           clearing is the same replace with nothing (the teardown relies on it)
 * The associating user is stored with the association (W4); no read endpoint returns it, so it is not asserted.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnGroup } from '../../utils/regression/eventsDrivers';
import { associateTriggers, clearAssociation, createOwnChain, createOwnTrigger, EVENT, getAssociations, setGroups } from '../../utils/regression/workflowApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-WFL-09';

test.describe('API-WFL-09 association replaces the list and keeps the request order', { tag: tags.api }, () => {
    test('API-WFL-09: [A, B] is read back as [A, B], [B] replaces it, an ignore trigger is listed first, [] clears the scope',
        meta({
            id: 'API-WFL-09', prio: 'P1', issue: 'ilm#438',
            rule: [
                'T14 W4 (the association call REPLACES the whole list for (event, resource, object); replace=true is hard-wired)',
                'T14 W5 (ignore triggers first: order -N..-1, then action triggers in request order)',
            ],
        }),
        async ({ api }) => {
            const group = await createOwnGroup(api, SPEC, 'wf09-group');
            const a = await createOwnChain(api, SPEC, { suffix: 'wf09-a', event: EVENT.actionPerformed, executionItems: [setGroups([group.uuid])] });
            const b = await createOwnChain(api, SPEC, { suffix: 'wf09-b', event: EVENT.actionPerformed, executionItems: [setGroups([group.uuid])] });
            const ignore = await createOwnTrigger(api, SPEC, { suffix: 'wf09-ignore', event: EVENT.actionPerformed, ignore: true });
            const read = async () => (await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed] ?? [];
            const associate = async (triggers: Array<{ uuid: string; name: string; kind: 'own' }>) => {
                const sent = await associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggers });
                expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
            };

            await test.step('POST [A, B] → GET [A, B]', async () => {
                await associate([a.trigger, b.trigger]);
                expect(await read()).toEqual([a.trigger.uuid, b.trigger.uuid]);
            });
            await test.step('POST [B] → GET [B]: the call replaces, it does not add', async () => {
                await associate([b.trigger]);
                expect(await read()).toEqual([b.trigger.uuid]);
            });
            await test.step('POST [A, ignore] → GET [ignore, A]: the ignore trigger runs first whatever the request order', async () => {
                await associate([a.trigger, ignore]);
                expect(await read()).toEqual([ignore.uuid, a.trigger.uuid]);
            });
            await test.step('POST [ignore, A, B] → GET [ignore, A, B]: action triggers keep their request order', async () => {
                await associate([ignore, a.trigger, b.trigger]);
                expect(await read()).toEqual([ignore.uuid, a.trigger.uuid, b.trigger.uuid]);
            });
            await test.step('POST [] → the scope holds no trigger for the event', async () => {
                const sent = await clearAssociation(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group });
                expect(sent.status, `an empty list is a replace with nothing: ${sent.text.slice(0, 200)}`).toBeLessThan(300);
                expect(await read()).toEqual([]);
            });
        });
});
