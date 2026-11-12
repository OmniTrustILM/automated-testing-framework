/**
 * REG-WFL-12 — An ignore trigger runs first and stops its scope. ilm#438.
 *
 * WHAT: Three rows on an own RA profile with an ignore trigger and an action trigger (Set field Groups), each with its own certificate:
 *       a. the ignore trigger matches, request order [action, ignore]; b. it matches, request order [ignore, action]; c. it does not match,
 *          request order [action, ignore].
 *       1. An issue fires once; the certificate's trigger rows are read in evaluation order: the ignore trigger is always evaluated first,
 *          whatever the request order.
 *       2. When it matches (true / true) the action trigger has no row and the group is not set.
 *       3. When it does not match (false / false) the action trigger runs (true / true) and the group is set.
 * WHY: ignore triggers run first (before the action triggers) and a satisfied one stops its scope; the object-level analogue of
 *      the platform rule. Whether an ignore at object level also stops the platform or other scopes is not asserted
 *      (documentation#402: open product decision).
 * HOW: "no row for the action trigger" is asserted only after the scope's firing is finished and the ignore row is present, so it is not a
 *      race. Own objects only (RA profile, group, two triggers, one certificate per row), recorded before any assertion; every row declares
 *      `needs: 'ca'` and skips with the reason when a platform-level trigger already listens on the event.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { groupUuidsOf } from '../../../utils/regression/ownGroups';
import { getCertificateDetail, eventCertificate } from '../../../utils/regression/events/workflowFixtures';
import { runId } from '../../../utils/regression/ledger/runState';
import { associateTriggers } from '../../../utils/regression/events/eventAssociations';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import { inEvaluationOrder, type ObjectHistoryRow, waitForFinishedFirings, waitForTriggerRows } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { CERT_FIELD, conditionItem, createOwnChain, setGroupsAction } from '../../../utils/regression/events/workflowObjects';
import { pollUntil } from '../../../utils/regression/wait';
import { testMeta, tags } from '../../../utils/regression/tags';
import { SLOW_LIFECYCLE_MS } from '../../../utils/regression/timeouts';

test.describe('Ignore trigger first, then stop the scope', { tag: tags.regression }, () => {
    interface Outcome {
        api: GuardedApi;
        cert: { uuid: string };
        group: { uuid: string };
        actionName: string;
        ignoreRow: ObjectHistoryRow;
        actionRow: ObjectHistoryRow | undefined;
    }
    type OutcomeCheck = (o: Outcome) => Promise<void>;
    /** What the certificate shows after the firing, by whether the ignore trigger matched. */
    const outcomes = {
        scopeStopped: async (o: Outcome): Promise<void> => {
            expect({ matched: o.ignoreRow.conditionsMatched, performed: o.ignoreRow.actionsPerformed }, 'ignore matched: true / true').toEqual({ matched: true, performed: true });
            expect(o.actionRow, 'the action trigger of the stopped scope has no row').toBeUndefined();
            expect(groupUuidsOf(await getCertificateDetail(o.api, o.cert.uuid)), 'the group was not set').toEqual([]);
        },
        actionApplied: async (o: Outcome): Promise<void> => {
            expect({ matched: o.ignoreRow.conditionsMatched, performed: o.ignoreRow.actionsPerformed }, 'ignore did not match: false / false').toEqual({ matched: false, performed: false });
            const applied = await pollUntil(() => waitForTriggerRows(o.api, 'certificates', o.cert.uuid, [o.actionName]), (r) => r.length > 0, { what: 'the action row' });
            const actionRow = applied.find((r) => r.trigger.name === o.actionName)!;
            expect({ matched: actionRow.conditionsMatched, performed: actionRow.actionsPerformed }, 'the action trigger ran: true / true').toEqual({ matched: true, performed: true });
            expect(await pollUntil(async () => groupUuidsOf(await getCertificateDetail(o.api, o.cert.uuid)), (g) => g.length === 1, { what: 'the group of the action' }), 'the group of the action was set').toEqual([o.group.uuid]);
        },
    };
    const rows: Array<{ key: string; ignoreMatches: boolean; order: Array<'action' | 'ignore'>; expectAfter: OutcomeCheck }> = [
        { key: 'a', ignoreMatches: true, order: ['action', 'ignore'], expectAfter: outcomes.scopeStopped },
        { key: 'b', ignoreMatches: true, order: ['ignore', 'action'], expectAfter: outcomes.scopeStopped },
        { key: 'c', ignoreMatches: false, order: ['action', 'ignore'], expectAfter: outcomes.actionApplied },
    ];
    for (const row of rows) {
        test(`ignore ${row.ignoreMatches ? 'matches' : 'does not match'}, request order [${row.order.join(', ')}]`,
            testMeta({
                id: 'REG-WFL-12', row: `ignore ${row.ignoreMatches ? 'matches' : 'does not match'}, request order ${row.order.join(', ')}`, prio: 'P2', issue: 'ilm#438', needs: 'ca',
                rule: ['ignore triggers run first before the action triggers; a satisfied ignore trigger stops ITS scope; ignore: true/true, action: true/true only when run', `table row ${row.key}`],
            }),
            async ({ api, own, needs }) => {
                test.setTimeout(SLOW_LIFECYCLE_MS);
                await needs.platformTriggersFree(EVENT.actionPerformed);
                const { ra, ignore, action, group } = await test.step('Own RA profile, an ignore trigger and an action trigger associated in the request order of the row', async () => {
                    const ra = await own.raProfile(`wf12-ra-${row.key}`);
                    const group = await own.group(`wf12-group-${row.key}`);
                    const ignore = await createOwnChain(api, own.spec, `wf12-${row.key}-i`, { event: EVENT.actionPerformed, ignore: true, items: [conditionItem('property', CERT_FIELD.commonName, row.ignoreMatches ? 'CONTAINS' : 'EQUALS', row.ignoreMatches ? runId() : `${runId()}-nothing-carries-this-name`)] });
                    const action = await createOwnChain(api, own.spec, `wf12-${row.key}-a`, { event: EVENT.actionPerformed, executionItems: [setGroupsAction([group.uuid])] });
                    const byRole = { action: action.trigger, ignore: ignore.trigger };
                    const sent = await associateTriggers(api, own.spec, { event: EVENT.actionPerformed, resource: 'raProfiles', object: ra, triggers: row.order.map((r) => byRole[r]) });
                    expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
                    return { ra, ignore, action, group };
                });

                const { cert, history, ignoreRow, actionRow } = await test.step('An issue fires once; the trigger rows of the certificate in evaluation order', async () => {
                    const cert = await own.certificate.issue(ra, eventCertificate(`wf12-c-${row.key}`));
                    await waitForFinishedFirings(api, { event: EVENT.actionPerformed, scope: { resource: 'raProfiles', objectUuid: ra.uuid } }, 1);
                    const rowsOfCert = await waitForTriggerRows(api, 'certificates', cert.uuid, [ignore.trigger.name]);
                    const history = inEvaluationOrder(rowsOfCert.filter((r) => [ignore.trigger.name, action.trigger.name].includes(r.trigger.name)));
                    const ignoreRow = history.find((r) => r.trigger.name === ignore.trigger.name)!;
                    const actionRow = history.find((r) => r.trigger.name === action.trigger.name);
                    return { cert, history, ignoreRow, actionRow };
                });

                await test.step('The ignore trigger runs first; when it matches it stops the scope, otherwise the action applies', async () => {
                    expect(history[0].trigger.name, 'the ignore trigger is evaluated first whatever the request order').toBe(ignore.trigger.name);
                    await row.expectAfter({ api, cert, group, actionName: action.trigger.name, ignoreRow, actionRow });
                });
            });
    }
});
