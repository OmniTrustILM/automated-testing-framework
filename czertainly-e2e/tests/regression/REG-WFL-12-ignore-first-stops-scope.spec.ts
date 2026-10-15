/**
 * REG-WFL-12 — on an OWN RA profile the ignore trigger runs FIRST and stops that scope: when it matches, the action trigger does not
 * run; when it does not match, the action applies; the request order does not matter (ilm#438 steps 12–13, the object-level
 * analogue; §9.5 rule 2; T14 W5, W6, W17; TW25; P-12). Rows:
 *   a  ignore matches, request order [action, ignore]  group unchanged; ignore row true/true; NO row for the action trigger
 *   b  ignore matches, request order [ignore, action]  the same
 *   c  ignore does not match, order [action, ignore]   action applied (group set); ignore row false/false; action row true/true
 * In every row the ignore trigger is evaluated first in the history. "No row for the action trigger" is asserted only after the
 * scope's firing is Finished and the ignore row is present (the positive marker), so it is not a race. Whether an ignore at
 * object level also stops platform / other scopes is NOT asserted (T14 C4, documentation#402: open product decision).
 * Own objects only: an own RA profile, group, two triggers and one certificate per row.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnGroup, createOwnRaProfileOrSkip, getCertificateDetail, groupUuidsOf, issueOwnCertificate } from '../../utils/regression/eventsDrivers';
import { RUN_ID } from '../../utils/regression/regressionRun';
import {
    associateTriggers, CERT_FIELD, conditionItem, createOwnChain, EVENT, inEvaluationOrder, pollUntil, setGroups, waitForFinishedFirings, waitForTriggerRows, getPlatformTriggerGate,
} from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-12';

test.describe('@regression REG-WFL-12 ignore trigger first, then stop the scope', () => {
    const rows: Array<{ key: string; ignoreMatches: boolean; order: Array<'action' | 'ignore'> }> = [
        { key: 'a', ignoreMatches: true, order: ['action', 'ignore'] },
        { key: 'b', ignoreMatches: true, order: ['ignore', 'action'] },
        { key: 'c', ignoreMatches: false, order: ['action', 'ignore'] },
    ];
    for (const row of rows) {
        test(`REG-WFL-12[${row.key}]: ignore ${row.ignoreMatches ? 'matches' : 'does not match'}, request order [${row.order.join(', ')}]`,
            meta({
                id: 'REG-WFL-12', prio: 'P1', issue: 'ilm#438',
                rule: ['T14 W5 (ignore triggers first: order -N..-1), W6 (a satisfied ignore trigger stops ITS scope), W17 (ignore: true/true, action: true/true only when run); §9.5 rule 2; TW25', `P-12 row ${row.key}`],
            }),
            async ({ api }) => {
                test.setTimeout(480_000);
                const platformGate = await getPlatformTriggerGate(api, [EVENT.actionPerformed]);
                test.skip(platformGate !== undefined, platformGate ?? '');
                const ra = await createOwnRaProfileOrSkip(api, SPEC, `wf12-ra-${row.key}`, (reason) => test.skip(true, reason));
                const group = await createOwnGroup(api, SPEC, `wf12-group-${row.key}`);
                const ignore = await createOwnChain(api, SPEC, {
                    suffix: `wf12-${row.key}-i`, event: EVENT.actionPerformed, ignore: true,
                    items: [conditionItem('property', CERT_FIELD.commonName, row.ignoreMatches ? 'CONTAINS' : 'EQUALS', row.ignoreMatches ? RUN_ID : `${RUN_ID}-nothing-carries-this-name`)],
                });
                const action = await createOwnChain(api, SPEC, { suffix: `wf12-${row.key}-a`, event: EVENT.actionPerformed, executionItems: [setGroups([group.uuid])] });
                const byRole = { action: action.trigger, ignore: ignore.trigger };
                const sent = await associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'raProfiles', object: ra, triggers: row.order.map((r) => byRole[r]) });
                expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);

                const cert = await issueOwnCertificate(api, SPEC, ra, `wf12-cert-${row.key}`);
                await waitForFinishedFirings(api, { event: EVENT.actionPerformed, scope: { resource: 'raProfiles', objectUuid: ra.uuid } }, 1);
                const rowsOfCert = await waitForTriggerRows(api, 'certificates', cert.uuid, [ignore.trigger.name]);
                const history = inEvaluationOrder(rowsOfCert.filter((r) => [ignore.trigger.name, action.trigger.name].includes(r.trigger.name)));
                const ignoreRow = history.find((r) => r.trigger.name === ignore.trigger.name)!;
                const actionRow = history.find((r) => r.trigger.name === action.trigger.name);

                expect(history[0].trigger.name, 'the ignore trigger is evaluated first whatever the request order').toBe(ignore.trigger.name);
                if (row.ignoreMatches) {
                    expect({ matched: ignoreRow.conditionsMatched, performed: ignoreRow.actionsPerformed }, 'ignore matched: true / true').toEqual({ matched: true, performed: true });
                    expect(actionRow, 'the action trigger of the stopped scope has no row').toBeUndefined();
                    expect(groupUuidsOf(await getCertificateDetail(api, cert.uuid)), 'the group was not set').toEqual([]);
                } else {
                    expect({ matched: ignoreRow.conditionsMatched, performed: ignoreRow.actionsPerformed }, 'ignore did not match: false / false').toEqual({ matched: false, performed: false });
                    const applied = await pollUntil(() => waitForTriggerRows(api, 'certificates', cert.uuid, [action.trigger.name]), (r) => r.length > 0, { what: 'the action row' });
                    const ar = applied.find((r) => r.trigger.name === action.trigger.name)!;
                    expect({ matched: ar.conditionsMatched, performed: ar.actionsPerformed }).toEqual({ matched: true, performed: true });
                    expect(await pollUntil(async () => groupUuidsOf(await getCertificateDetail(api, cert.uuid)), (g) => g.length === 1, { what: 'the group of the action' })).toEqual([group.uuid]);
                }
            });
    }
});
