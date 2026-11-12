/**
 * API-WFL-09 — Event association replaces the scope's list and keeps the request order. ilm#438.
 *
 * WHAT: 1. Associate [A, B] → the scope reads back [A, B].
 *       2. Associate [B] → [B]: the call replaces, it does not add.
 *       3. Associate [A, ignore] → [ignore, A]: an ignore trigger runs first whatever its position in the request.
 *       4. Associate [ignore, A, B] → [ignore, A, B]: action triggers keep their request order.
 *       5. Associate [] → the scope holds no trigger for the event.
 * WHY: the association call replaces the whole list for (event, resource, object) (replace is hard-wired in
 *      TriggerServiceImpl.createTriggerAssociations); ignore triggers get the orders -N…-1 and action triggers 0…n in request order. The
 *      empty-list clear is also what the teardown relies on.
 * HOW: runs on an own group (object level, no platform setting is touched), own triggers and own action chains, all recorded in the ledger
 *      before the first assertion; nothing is fired.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { createOwnGroup } from '../../../utils/regression/ownGroups';
import { associateTriggers, clearAssociation, getAssociations } from '../../../utils/regression/events/eventAssociations';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { createOwnChain, createOwnTrigger, setGroupsAction } from '../../../utils/regression/events/workflowObjects';
import { testMeta, tags } from '../../../utils/regression/tags';

test.describe('Association replaces the list and keeps the request order', { tag: tags.api }, () => {
    test('an association replaces the list in request order, ignore triggers first, and [] clears the scope',
        testMeta({
            id: 'API-WFL-09', prio: 'P1', issue: 'ilm#438',
            rule: [
                'the association call REPLACES the whole list for (event, resource, object); replace=true is hard-wired',
                'ignore triggers first: order -N..-1, then action triggers in request order',
            ],
        }),
        async ({ api, own }) => {
            const group = await createOwnGroup(api, own.spec, 'wf09-group');
            const a = await createOwnChain(api, own.spec, 'wf09-a', { event: EVENT.actionPerformed, executionItems: [setGroupsAction([group.uuid])] });
            const b = await createOwnChain(api, own.spec, 'wf09-b', { event: EVENT.actionPerformed, executionItems: [setGroupsAction([group.uuid])] });
            const ignore = await createOwnTrigger(api, own.spec, 'wf09-ignore', { event: EVENT.actionPerformed, ignore: true });
            const read = async () => (await getAssociations(api, 'groups', group.uuid))[EVENT.actionPerformed] ?? [];
            const associate = async (triggers: Array<{ uuid: string; name: string; kind: 'own' }>) => {
                const sent = await associateTriggers(api, own.spec, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggers });
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
                const sent = await clearAssociation(api, own.spec, { event: EVENT.actionPerformed, resource: 'groups', object: group });
                expect(sent.status, `an empty list is a replace with nothing: ${sent.text.slice(0, 200)}`).toBeLessThan(300);
                expect(await read()).toEqual([]);
            });
        });
});
