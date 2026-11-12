/**
 * API-WFL-08 — Which conditions an association to `Certificate uploaded` accepts (local stack only). ilm#438, core#1441, core#1705.
 *
 * WHAT: 1. An own ignore trigger whose rule reads RA profile, Group, Owner, a metadata item, a protocol profile, a location or a relation
 *          is refused at association time:
 *          422 "Trigger '<name>' cannot be associated with event 'Certificate uploaded' as it contains rule with invalid field source,
 *          which is not allowed for this event." and the platform list is unchanged.
 *       2. A rule on an own property (Common Name) and a rule on a custom attribute are accepted and listed.
 *       3. One invalid field among valid ones refuses the whole trigger.
 * WHY: `Certificate uploaded` accepts only own-property and custom-attribute conditions (core#1441 acceptance criteria); the rule is the
 *      oracle.
 * HOW: tagged `@local`: the association is platform-level, a replace-all of the platform list for that event that affects every user, so it
 *      runs on a proven local stack only, with a guarded context built per test (a spec may not `test.use` the guard options). The platform
 *      list is READ first (the `platform-triggers-free` need) and a stack with a listener already is skipped;
 *      every accepted association is cleared in `finally`. All triggers are own ignore triggers with own conditions and rules.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { createOwnCustomAttribute } from '../../../utils/regression/customAttributes';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { getPlatformAssociations, platformAssociate } from '../../../utils/regression/events/eventAssociations';
import { EVENT, EVENT_LABEL } from '../../../utils/regression/events/eventVocabulary';
import { CERT_FIELD, ConditionItem, conditionItem, createOwnCondition, createOwnRule, createOwnTrigger } from '../../../utils/regression/events/workflowObjects';
import { errorShapeOf, errorTexts } from '../../../utils/regression/events/workflowRequests';
import { runId } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';

test.describe('Certificate uploaded: which conditions an association accepts', { tag: tags.api }, () => {
    describeLocalOnly(test);
    // `@local` rows lift the guard's ownership rule on a proven local stack only (`localStack`, `describeLocalOnly`): the `localApi`
    // fixture is that guarded context, built per test and disposed after it.

    const rowMeta = (row: string, rule: string) =>
        testMeta({ id: 'API-WFL-08', prio: 'P1', issue: 'ilm#438', local: true, rule: [`core#1441 AC, core#1705: row ${row}: ${rule}`] });

    const refusal = (name: string) =>
        `Trigger '${name}' cannot be associated with event '${EVENT_LABEL[EVENT.uploaded]}' as it contains rule with invalid field source, which is not allowed for this event.`;

    async function trigger(api: Parameters<typeof createOwnCondition>[0], spec: string, suffix: string, items: ConditionItem[]) {
        const condition = await createOwnCondition(api, spec, `${suffix}-c`, { items });
        const rule = await createOwnRule(api, spec, `${suffix}-r`, { conditions: [condition] });
        return createOwnTrigger(api, spec, `${suffix}-t`, { event: EVENT.uploaded, ignore: true, rules: [rule] });
    }

    const refused: Array<[string, string, ConditionItem]> = [
        ['a', 'RA profile', conditionItem('property', CERT_FIELD.raProfile, 'EQUALS', ['x'])],
        ['b', 'Group', conditionItem('property', CERT_FIELD.group, 'EQUALS', ['x'])],
        ['c', 'Owner', conditionItem('property', CERT_FIELD.owner, 'EQUALS', ['x'])],
        ['d', 'metadata item', conditionItem('meta', 'qa-absent|STRING', 'EQUALS', 'x')],
        ['e1', 'protocol profile', conditionItem('property', 'ACME_PROFILE', 'EQUALS', 'x')],
        ['e2', 'locations', conditionItem('property', 'CERT_LOCATION_NAME', 'EQUALS', 'x')],
        ['e3', 'a relation', conditionItem('property', 'SUCCEEDING_CERTIFICATES', 'EMPTY')],
    ];
    for (const [row, what, item] of refused) {
        test(`a rule reading ${what} is refused at association time`, rowMeta(row, 'invalid field source → 422'), async ({ needs, localApi, own }) => {
            await needs.platformTriggersFree(EVENT.uploaded);
            const t = await trigger(localApi, own.spec, `wf08-${row}`, [item]);
            try {
                const sent = await platformAssociate(localApi, own.spec, EVENT.uploaded, [t]);
                expect(sent.status, sent.text.slice(0, 300)).toBe(422);
                expect(errorShapeOf(sent)).toBe('array');
                expect(errorTexts(sent)).toContain(refusal(t.name));
                expect(await getPlatformAssociations(localApi, EVENT.uploaded), 'the platform list is unchanged').toEqual([]);
            } finally {
                await platformAssociate(localApi, own.spec, EVENT.uploaded, []);
            }
        });
    }

    test('a rule on an own property (Common Name) is accepted and listed', rowMeta('f', 'own property → accepted'), async ({ needs, localApi, own }) => {
        await needs.platformTriggersFree(EVENT.uploaded);
        const t = await trigger(localApi, own.spec, 'wf08-f', [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', runId())]);
        try {
            const sent = await platformAssociate(localApi, own.spec, EVENT.uploaded, [t]);
            expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
            expect(await getPlatformAssociations(localApi, EVENT.uploaded)).toEqual([t.uuid]);
        } finally {
            await platformAssociate(localApi, own.spec, EVENT.uploaded, []);
        }
        expect(await getPlatformAssociations(localApi, EVENT.uploaded), 'the platform list is restored (empty)').toEqual([]);
    });

    test('a rule on a custom attribute is accepted and listed', rowMeta('g', 'custom attribute → accepted'), async ({ needs, localApi, own }) => {
        await needs.platformTriggersFree(EVENT.uploaded);
        const attr = await createOwnCustomAttribute(localApi, own.spec, 'wf08-attr', { resources: ['certificates'] });
        const t = await trigger(localApi, own.spec, 'wf08-g', [conditionItem('custom', `${attr.attributeName}|STRING`, 'EQUALS', 'v')]);
        try {
            const sent = await platformAssociate(localApi, own.spec, EVENT.uploaded, [t]);
            expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
            expect(await getPlatformAssociations(localApi, EVENT.uploaded)).toEqual([t.uuid]);
        } finally {
            await platformAssociate(localApi, own.spec, EVENT.uploaded, []);
        }
        expect(await getPlatformAssociations(localApi, EVENT.uploaded), 'the platform list is restored (empty)').toEqual([]);
    });

    test('one invalid field among valid ones refuses the whole trigger', rowMeta('h', 'mixed rule → 422'), async ({ needs, localApi, own }) => {
        await needs.platformTriggersFree(EVENT.uploaded);
        const t = await trigger(localApi, own.spec, 'wf08-h', [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', runId()), conditionItem('property', CERT_FIELD.group, 'EQUALS', ['x'])]);
        try {
            const sent = await platformAssociate(localApi, own.spec, EVENT.uploaded, [t]);
            expect(sent.status, sent.text.slice(0, 300)).toBe(422);
            expect(errorTexts(sent)).toContain(refusal(t.name));
            expect(await getPlatformAssociations(localApi, EVENT.uploaded), 'the platform list is unchanged').toEqual([]);
        } finally {
            await platformAssociate(localApi, own.spec, EVENT.uploaded, []);
        }
    });
});
