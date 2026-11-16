/**
 * REG-COMP-03 — the compliance status of an own certificate follows its profile's rules: nok wins over ok (ilm#436, ilm#70).
 * Re-adding the same rule replaces it, so a second own profile holds the other value.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import type { AttributeDefinition } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { requestAttributesFrom } from '../../../utils/regression/customAttributes';
import { associateOwnComplianceProfile, checkOwnCertificateCompliance, createOwnComplianceProfile, expectedOverallStatus, listProviderRules, overallComplianceStatus, patchOwnComplianceRule } from '../../../utils/regression/platform/complianceProfiles';
import { connectorVersion, listConnectors } from '../../../utils/regression/platform/connectorApi';
import { getCertificate } from '../../../utils/regression/apiReads';
import { testMeta, tags } from '../../../utils/regression/tags';
import { LIFECYCLE_MS } from '../../../utils/regression/timeouts';
import type { JsonObject } from '../../../utils/regression/json';

/** The `cus_key_length` rule attributes: the condition option matching `condition`, the integer `length`. */
function keyLengthAttributes(rule: JsonObject, condition: 'Equals' | 'NotEquals' | 'Greater' | 'Lesser', length: number): JsonObject[] {
    const defs = (rule.attributes ?? []) as AttributeDefinition[];
    const values: Record<string, unknown> = {};
    for (const d of defs) {
        if (/condition/i.test(d.name)) values[d.name] = (d.content ?? []).find((o) => String(o.reference ?? o.data).toLowerCase() === condition.toLowerCase())?.data ?? condition;
        else if (/length|value/i.test(d.name) || /integer/i.test(String(d.contentType))) values[d.name] = length;
    }
    return requestAttributesFrom(defs, values, String(length));
}

test.describe('Compliance profiles (API)', { tag: tags.regression }, () => {
    test('the compliance status of an own certificate follows its rules and nok wins',
        testMeta({ id: 'REG-COMP-03', prio: 'P2', issue: 'ilm#436', needs: 'ca', rule: ['ilm#70 (overall nok if any rule is nok, na if none applies, else ok)'] }),
        async ({ api, own, ownRaProfile: ra }, testInfo) => {
            test.setTimeout(LIFECYCLE_MS);
            let x509: { uuid: string } | undefined;
            for (const connector of (await listConnectors(api)).filter((c) => c.status === 'connected')) {
                const groups = ((await connectorVersion(api, connector.uuid)).detail?.functionGroups ?? []) as JsonObject[];
                if (groups.some((g) => (g.functionGroupCode === 'complianceProvider' || g.code === 'complianceProvider') && ((g.kinds ?? []) as string[]).includes('x509'))) {
                    x509 = connector;
                    break;
                }
            }
            test.skip(!x509, 'no connected x509 compliance provider on this tier');
            const rules = await listProviderRules(api, { connectorUuid: x509!.uuid, kind: 'x509' });
            const keyLength = rules.find((r) => String(r.name) === 'cus_key_length');
            expect(keyLength, 'the provider offers cus_key_length').toBeTruthy();
            const rule = { ruleUuid: String(keyLength!.uuid), connectorUuid: x509!.uuid, kind: 'x509' };
            const raRef = { uuid: ra.uuid, name: ra.name, kind: 'own' } as const;

            const certificate = await test.step('Own RSA-2048 certificate on the run RA profile', async () =>
                own.certificate.issue(ra, { suffix: 'comp', sans: { dns: [], ip: [] }, fillRequiredAttributes: true, note: 'compliance subject' }));
            const profile = await createOwnComplianceProfile(api, own.spec, 'comp');
            expect((await associateOwnComplianceProfile(api, profile, 'raProfiles', raRef)).status(), 'the profile is associated with the RA profile').toBeLessThan(300);

            const check = async (title: string, expected: 'ok' | 'nok' | 'na') => test.step(title, async () => {
                const result = await checkOwnCertificateCompliance(api, certificate);
                expect(overallComplianceStatus(result), JSON.stringify(result).slice(0, 300)).toBe(expected);
            });
            const add = async (condition: 'Equals', length: number) =>
                expect((await patchOwnComplianceRule(api, profile, rule, keyLengthAttributes(keyLength!, condition, length))).status(), `add the rule ${condition} ${length}`).toBeLessThan(300);
            const remove = async () => expect((await patchOwnComplianceRule(api, profile, rule, [], true)).status(), 'remove the rule').toBeLessThan(300);

            // A profile WITHOUT rules is skipped by core's checkCompliance (`!p.getComplianceRules().isEmpty()`): the result is
            // not_checked, not na. ilm#70's AC "na if none applies" speaks of rules that exist and do not apply; a rule-less profile is not
            // in the AC. The na arm needs a provider rule that exists but does not apply and is not built here (annotation, no step).
            await test.step('A profile without rules checks nothing → not_checked (na needs an existing rule that does not apply)', async () => {
                const result = await checkOwnCertificateCompliance(api, certificate);
                const detail = await getCertificate(api, certificate.uuid);
                const status = String(detail.complianceStatus ?? '').toLowerCase() || overallComplianceStatus(result);
                testInfo.annotations.push({ type: 'compliance-no-rules', description: `status ${status}: ${JSON.stringify(result).slice(0, 200)}` });
                expect(['not_checked', 'na'], `a rule-less profile leaves the certificate not_checked (core skips it); na also accepted: ${status}`).toContain(status);
            });
            await add('Equals', 2048);
            await check('Equals 2048 → ok', 'ok');
            await remove();
            await add('Equals', 4096);
            await check('Equals 4096 → nok', 'nok');
            // Re-adding the same rule replaces it (core addRule deletes the profile's rule of that connector / kind / ruleUuid first), so
            // one profile cannot hold ok + nok. A SECOND own profile on the same own RA profile holds Equals 4096 while the first holds
            // Equals 2048; both are in the ledger (the helper records them) and teardown removes compliance profiles before the RA profile.
            await add('Equals', 2048);
            await check('Equals 2048 on profile 1 → ok', 'ok');
            const second = await createOwnComplianceProfile(api, own.spec, 'comp2');
            expect((await associateOwnComplianceProfile(api, second, 'raProfiles', raRef)).status(), 'the second profile is associated').toBeLessThan(300);
            expect((await patchOwnComplianceRule(api, second, rule, keyLengthAttributes(keyLength!, 'Equals', 4096))).status(), 'the second profile holds Equals 4096').toBeLessThan(300);
            await check('ok (profile 1) + nok (profile 2) together → nok', expectedOverallStatus(['ok', 'nok']));
        });
});
