/**
 * An RA profile with a required attribute left empty, API leg: the connector 422 is relayed as 422 by the validate
 * endpoint and by the create, and no RA profile is created. The authority is a pre-existing, connected one, read only.
 * Shared tiers: create-only with run-prefixed names; every create is in the ledger before the first assertion.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { refused422 } from '../../utils/regression/inventory/configProbes';
import type { Probe } from '../../utils/regression/inventory/searchApi';
import { adoptByName } from '../../utils/regression/inventory/credentialsApi';
import { authorityWithRequiredAttribute, createRaProfileProbe, emptyAttributeCase, labelOf, missingAttributeCase, raProfileBody, requiredAttributeNotFoundText, requiredAttributeNotSetText, validRaAttributes, validateRaAttributes } from '../../utils/regression/inventory/raProfileValidation';
import { uniqueStamp } from '../../utils/regression/text';
import { runName } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';
import type { GuardedApi } from '../../utils/regression/guard/types';

const SPEC = 'API-GEN-17';
const ISSUE = 'ilm#428';

// ================================================================== API-GEN-28

/** The first connected pre-existing authority with a required RA-profile attribute, its valid base attributes and the label; else the rows skip. */
async function raSetupOrSkip(api: GuardedApi) {
    const pick = await authorityWithRequiredAttribute(api);
    test.skip(!pick.ok, pick.skip ?? 'no authority');
    const authority = pick.ok!;
    const def = authority.required[0];
    return { authority, def, label: labelOf(def), base: (await validRaAttributes(api, authority.uuid)) ?? [] };
}

/** A connector that is restarting answers 503: an environment blocker (never retried, never a pass), unlike 502 / 400, which are the defect under test. */
const skipOn503 = (p: Probe): void => test.skip(p.status === 503, 'the authority connector answered 503 (unreachable or restarting): environment blocker, not retried');

test.describe('RA profile with a required attribute empty (API leg)', { tag: tags.api }, () => {
    const RULES = ['a connector 422 becomes ValidationException and so a Core 422 with the connector\'s messages: BaseApiClient:738, interfaces#898', 'RA-profile attribute validation against a connected authority connector with an empty required attribute; ilm#428 step 5'];

    test('validating RA-profile attributes without the required one answers 422',
        testMeta({ id: 'API-GEN-28', row: 'validate-missing', prio: 'P1', issue: ISSUE, rule: [...RULES, '422 ["Required attribute <label> not found."] (not 400 / 502)'] }),
        async ({ api }) => {
            const { authority, def, label, base } = await raSetupOrSkip(api);
            const p = await validateRaAttributes(api, authority.uuid, missingAttributeCase(base, def));
            skipOn503(p);
            expect(refused422(p)).toContain(requiredAttributeNotFoundText(label));
        });

    test('validating RA-profile attributes with the required one empty answers 422',
        testMeta({ id: 'API-GEN-28', row: 'validate-empty', prio: 'P1', issue: ISSUE, rule: [...RULES, '422 ["Value of required attribute <label> not set."]'] }),
        async ({ api }) => {
            const { authority, def, label, base } = await raSetupOrSkip(api);
            const p = await validateRaAttributes(api, authority.uuid, emptyAttributeCase(base, def));
            skipOn503(p);
            expect(refused422(p)).toContain(requiredAttributeNotSetText(label));
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

    for (const [row, arm, expected] of [
        ['create-missing', missingAttributeCase, requiredAttributeNotFoundText],
        ['create-empty', emptyAttributeCase, requiredAttributeNotSetText],
    ] as const) {
        test(`creating an RA profile with the required attribute ${row === 'create-missing' ? 'missing' : 'empty'} answers 422`,
            testMeta({ id: 'API-GEN-28', row, prio: 'P1', issue: ISSUE, rule: [...RULES, 'with the connector\'s text; creates nothing'] }),
            async ({ api }) => {
                const { authority, def, label, base } = await raSetupOrSkip(api);
                const name = runName(`ra-neg-${row}-${uniqueStamp()}`);
                const { probe } = await createRaProfileProbe(api, authority.uuid, await raProfileBody(api, name, arm(base, def)), SPEC, `${row} probe`);
                skipOn503(probe);
                // Ledger first for a leak: any RA profile with this unique name is the run's, whatever the answer was.
                const rows = await adoptByName(api, '/api/v1/raProfiles', 'raProfiles', name, SPEC, 'RA profile left by a refused create', { authority: authority.uuid });
                expect(refused422(probe)).toContain(expected(label));
                expect(rows, 'no RA profile with that name was created').toEqual([]);
            });
    }
});
