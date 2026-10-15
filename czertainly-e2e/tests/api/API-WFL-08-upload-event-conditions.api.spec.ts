/**
 * API-WFL-08 — `Certificate uploaded` accepts only own-property and custom-attribute conditions (`@local`: the association is
 * PLATFORM-LEVEL, a replace-all of the platform list for that event that affects every user: T14 0.1 rule 1).
 *
 * ilm#438 steps 1–2 as written cannot work (they build the upload trigger from RA profile, Group, Owner and metadata
 * conditions; core refuses exactly those at association time: core#1441 AC, T14 W25, C1): the oracle is the rule. Rows of the
 * plan's table P-08u, every trigger an own ignore trigger bound to Certificate uploaded:
 *   a–c RA profile, Group, Owner        → 422 "Trigger '<n>' cannot be associated with event 'Certificate uploaded' as it contains
 *                                          rule with invalid field source, which is not allowed for this event."
 *   d   a metadata item                 → the same 422
 *   e   protocol profile, locations, a relation → the same 422
 *   f   own property (Common Name)      → accepted, the platform list names the trigger
 *   g   a custom attribute (core#1705)  → accepted, listed
 *   h   a rule mixing a valid and an invalid field → 422 for the whole trigger
 * Guard 3 (T14 0.1): the platform list of the event is READ first; a stack where something is already associated is skipped (the
 * row stays out of that event). Every accepted association is cleared (restored to the empty list) in `finally`; the ledger line
 * of the platform association is recorded before the request.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnCustomAttribute } from '../../utils/regression/eventsDrivers';
import { getGuardedApiContext } from '../../utils/regression/guardedApi';
import type { GuardedApi } from '../../utils/regression/guardedApi';
import { describeLocal } from '../../utils/regression/tier';
import {
    CERT_FIELD, ConditionItem, conditionItem, createOwnCondition, createOwnRule, createOwnTrigger, errorShapeOf, errorTexts, EVENT, EVENT_LABEL, getPlatformAssociations,
    platformAssociate,
} from '../../utils/regression/workflowApi';
import { RUN_ID } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-WFL-08';

test.describe('API-WFL-08 Certificate uploaded: which conditions an association accepts', { tag: tags.api }, () => {
    describeLocal(test);
    // `@local` rows lift the guard's ownership rule on a proven local stack only (`localStack`, `describeLocal`): the guarded
    // context is built per test here, since a spec may not `test.use` the guard options.
    let api: GuardedApi;
    test.beforeEach(async ({ request, env }) => {
        api = await getGuardedApiContext(request, env, { localStack: true });
    });
    test.afterEach(async () => {
        await api?.dispose();
    });

    const m = (row: string, rule: string) =>
        meta({ id: 'API-WFL-08', prio: 'P1', issue: 'ilm#438', local: true, rule: [`T14 W25 (core#1441 AC, core#1705): P-08u row ${row}: ${rule}`] });

    const refusal = (name: string) =>
        `Trigger '${name}' cannot be associated with event '${EVENT_LABEL[EVENT.uploaded]}' as it contains rule with invalid field source, which is not allowed for this event.`;

    async function trigger(api: Parameters<typeof createOwnCondition>[0], suffix: string, items: ConditionItem[]) {
        const condition = await createOwnCondition(api, SPEC, { suffix: `${suffix}-c`, items });
        const rule = await createOwnRule(api, SPEC, { suffix: `${suffix}-r`, conditions: [condition] });
        return createOwnTrigger(api, SPEC, { suffix: `${suffix}-t`, event: EVENT.uploaded, ignore: true, rules: [rule] });
    }

    async function requireEmptyPlatformList(api: Parameters<typeof createOwnCondition>[0]): Promise<void> {
        const existing = await getPlatformAssociations(api, EVENT.uploaded);
        test.skip(existing.length > 0, `guard 3: ${existing.length} platform-level trigger(s) already listen on ${EVENT_LABEL[EVENT.uploaded]}; the row stays out of that event (restoring a list is never attempted)`);
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
        test(`API-WFL-08[${row}]: a rule reading ${what} is refused at association time`, m(row, 'invalid field source → 422'), async () => {
            await requireEmptyPlatformList(api);
            const t = await trigger(api, `wf08-${row}`, [item]);
            try {
                const sent = await platformAssociate(api, SPEC, EVENT.uploaded, [t]);
                expect(sent.status, sent.text.slice(0, 300)).toBe(422);
                expect(errorShapeOf(sent)).toBe('array');
                expect(errorTexts(sent)).toContain(refusal(t.name));
                expect(await getPlatformAssociations(api, EVENT.uploaded), 'the platform list is unchanged').toEqual([]);
            } finally {
                await platformAssociate(api, SPEC, EVENT.uploaded, []);
            }
        });
    }

    test('API-WFL-08[f]: a rule on an own property (Common Name) is accepted and listed', m('f', 'own property → accepted'), async () => {
        await requireEmptyPlatformList(api);
        const t = await trigger(api, 'wf08-f', [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', RUN_ID)]);
        try {
            const sent = await platformAssociate(api, SPEC, EVENT.uploaded, [t]);
            expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
            expect(await getPlatformAssociations(api, EVENT.uploaded)).toEqual([t.uuid]);
        } finally {
            await platformAssociate(api, SPEC, EVENT.uploaded, []);
        }
        expect(await getPlatformAssociations(api, EVENT.uploaded), 'the platform list is restored (empty)').toEqual([]);
    });

    test('API-WFL-08[g]: a rule on a custom attribute is accepted and listed (core#1705)', m('g', 'custom attribute → accepted'), async () => {
        await requireEmptyPlatformList(api);
        const attr = await createOwnCustomAttribute(api, SPEC, { suffix: 'wf08-attr', resources: ['certificates'] });
        const t = await trigger(api, 'wf08-g', [conditionItem('custom', `${attr.attributeName}|STRING`, 'EQUALS', 'v')]);
        try {
            const sent = await platformAssociate(api, SPEC, EVENT.uploaded, [t]);
            expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
            expect(await getPlatformAssociations(api, EVENT.uploaded)).toEqual([t.uuid]);
        } finally {
            await platformAssociate(api, SPEC, EVENT.uploaded, []);
        }
        expect(await getPlatformAssociations(api, EVENT.uploaded), 'the platform list is restored (empty)').toEqual([]);
    });

    test('API-WFL-08[h]: one invalid field among valid ones refuses the whole trigger', m('h', 'mixed rule → 422'), async () => {
        await requireEmptyPlatformList(api);
        const t = await trigger(api, 'wf08-h', [conditionItem('property', CERT_FIELD.commonName, 'CONTAINS', RUN_ID), conditionItem('property', CERT_FIELD.group, 'EQUALS', ['x'])]);
        try {
            const sent = await platformAssociate(api, SPEC, EVENT.uploaded, [t]);
            expect(sent.status, sent.text.slice(0, 300)).toBe(422);
            expect(errorTexts(sent)).toContain(refusal(t.name));
            expect(await getPlatformAssociations(api, EVENT.uploaded), 'the platform list is unchanged').toEqual([]);
        } finally {
            await platformAssociate(api, SPEC, EVENT.uploaded, []);
        }
    });
});
