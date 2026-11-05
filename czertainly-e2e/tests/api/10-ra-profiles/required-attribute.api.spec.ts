/**
 * API-GEN-28 — An RA profile with a required attribute left empty, API leg (ilm#428).
 *
 * A connector 422 reaches the client as a core 422 (interfaces#898); a 400 or 502 is the defect under test. The authority
 * is a pre-existing connected one and is only read; rows skip when there is none. Create-only on shared tiers. A 503 from
 * the connector is an environment blocker: a named skip, never a pass.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { refused422 } from '../../../utils/regression/inventory/configProbes';
import type { JsonObject } from '../../../utils/regression/json';
import { adoptByName } from '../../../utils/regression/inventory/credentialsApi';
import { authorityWithRequiredAttribute, probeRaProfile, emptyAttributeCase, missingAttributeCase, raProfileBody, requiredAttributeOracle, validRaAttributes, validateRaAttributes } from '../../../utils/regression/inventory/raProfileValidation';
import { ownName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import { ApiAnswer } from '../../../utils/regression/apiReads';

const ISSUE = 'ilm#428';

// ================================================================== API-GEN-28

/**
 * The first connected pre-existing authority with a required RA-profile attribute, its valid base attributes and the label; else the rows
 * skip.
 */
async function raSetupOrSkip(api: GuardedApi) {
    const pick = await authorityWithRequiredAttribute(api);
    test.skip(!pick.ok, pick.skip ?? 'no authority');
    const authority = pick.ok!;
    const def = authority.required[0];
    return { authority, def, base: (await validRaAttributes(api, authority.uuid)) ?? [] };
}

/** The refusal is a 422 whose messages carry the oracle of the authority's interface and name the attribute. */
function expectRequiredRefusal(p: ApiAnswer, authority: { connectorInterface: 'v2' | 'v3' }, def: JsonObject, arm: 'missing' | 'empty'): void {
    const { text, names } = requiredAttributeOracle(authority.connectorInterface, def, arm);
    const messages = refused422(p);
    expect(messages.some((m) => m.includes(text)), `a message says "${text}" (${authority.connectorInterface} authority): ${messages.join(' | ')}`).toBe(true);
    expect(messages.some((m) => m.includes(names)), `a message names the attribute ${names}: ${messages.join(' | ')}`).toBe(true);
}

/**
 * A connector that is restarting answers 503: an environment blocker (never retried, never a pass), unlike 502 / 400, which are the defect
 * under test.
 */
const skipOn503 = (p: ApiAnswer): void => test.skip(p.status === 503, 'the authority connector answered 503 (unreachable or restarting): environment blocker, not retried');

test.describe('RA profile with a required attribute empty (API leg)', { tag: tags.api }, () => {
    const RULES = ['a connector 422 becomes ValidationException and so a Core 422 with the connector\'s messages: BaseApiClient, interfaces#898', 'RA-profile attribute validation against a connected authority connector with an empty required attribute; ilm#428 step 5'];

    test('validating RA-profile attributes without the required one answers 422',
        testMeta({ id: 'API-GEN-28', row: 'validate-missing', prio: 'P1', issue: ISSUE, rule: [...RULES, '422 (not 400 / 502); a v2 authority relays the connector\'s ["Required attribute <label> not found."], a v3 authority gets core\'s attribute-engine ["Content for required Data attribute <name> is not provided."]; the oracle follows the authority\'s connector interface'] }),
        async ({ api }) => {
            const { authority, def, base } = await raSetupOrSkip(api);
            const p = await validateRaAttributes(api, authority.uuid, missingAttributeCase(base, def));
            skipOn503(p);
            expectRequiredRefusal(p, authority, def, 'missing');
        });

    test('validating RA-profile attributes with the required one empty answers 422',
        testMeta({ id: 'API-GEN-28', row: 'validate-empty', prio: 'P1', issue: ISSUE, rule: [...RULES, '422; v2 authority: ["Value of required attribute <label> not set."]; v3 authority: ["Attribute is required and no content is sent|Attribute[...]"] from the attribute engine, which names the attribute'] }),
        async ({ api }) => {
            const { authority, def, base } = await raSetupOrSkip(api);
            const p = await validateRaAttributes(api, authority.uuid, emptyAttributeCase(base, def));
            skipOn503(p);
            expectRequiredRefusal(p, authority, def, 'empty');
        });

    test('the valid attributes of an existing RA profile validate with 200',
        testMeta({ id: 'API-GEN-28', row: 'validate-valid', prio: 'P1', issue: ISSUE, rule: [...RULES, 'control'] }),
        async ({ api }) => {
            const { authority, base } = await raSetupOrSkip(api);
            test.skip(!base.length, 'the authority has no enabled pre-existing RA profile to copy valid attributes from');
            const p = await validateRaAttributes(api, authority.uuid, base);
            skipOn503(p);
            expect(p.status, p.text.slice(0, 300)).toBe(200);
        });

    for (const [row, arm, kind] of [
        ['create-missing', missingAttributeCase, 'missing'],
        ['create-empty', emptyAttributeCase, 'empty'],
    ] as const) {
        test(`creating an RA profile with the required attribute ${row === 'create-missing' ? 'missing' : 'empty'} answers 422`,
            testMeta({ id: 'API-GEN-28', row, prio: 'P1', issue: ISSUE, rule: [...RULES, 'with the text of the authority\'s interface (connector text for v2, attribute-engine text for v3); creates nothing'] }),
            async ({ api, own }) => {
                const { authority, def, base } = await raSetupOrSkip(api);
                const name = ownName(`ra-neg-${row}`);
                const probe = await probeRaProfile(api, own.spec, authority.uuid, await raProfileBody(api, name, arm(base, def)), `${row} probe`);
                skipOn503(probe);
                // Ledger first for a leak: any RA profile with this unique name is the run's, whatever the answer was.
                const rows = await adoptByName(api, '/api/v1/raProfiles', 'raProfiles', name, own.spec, 'RA profile left by a refused create', { authority: authority.uuid });
                expectRequiredRefusal(probe, authority, def, kind);
                expect(rows, 'no RA profile with that name was created').toEqual([]);
            });
    }
});
