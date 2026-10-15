/**
 * REG-COMP-03 — compliance check of an own certificate: ok / nok / na (P-COMP; ilm#436, T12; platform area).
 *
 * Own objects: the run's RA profile (CA-agnostic, `ensureRaProfileOrSkip`), an own RSA-2048 certificate issued on it,
 * an own compliance profile associated with that RA profile, provider rules of the x509 compliance provider
 * (`cus_key_length`). `PATCH /v2/complianceProfiles/{own}/rules` names a provider rule by `ruleUuid` (a catalogue entry): waived on an own
 * profile since the guard-integration pass (platform G-2, ROUTE_FIELD_WAIVERS).
 */
import { expect, test } from '../../fixtures/testFixtures';
import type { AttributeDefinition } from '../../utils/regression/cryptoMatrix';
import {
    associateOwnComplianceProfile, checkOwnCertificateCompliance, createOwnComplianceProfile, expectedOverallStatus, listProviderRules, overallComplianceStatus, patchOwnComplianceRule,
    requestAttributesFrom,
} from '../../utils/regression/platformApi';
import { csrWithSan } from '../../utils/regression/pki';
import { apiJson, ensureRaProfileOrSkip, getCertificate, issueWithCsr, recordDerivedKeyOf } from '../../utils/regression/regressionApi';
import { recordCreated, regName } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'REG-COMP-01-08';
type Json = Record<string, any>;

/** The `cus_key_length` rule attributes: the condition option matching `condition`, the integer `length`. */
function keyLengthAttributes(rule: Json, condition: 'Equals' | 'NotEquals' | 'Greater' | 'Lesser', length: number): Json[] {
    const defs = (rule.attributes ?? []) as AttributeDefinition[];
    const values: Record<string, unknown> = {};
    for (const d of defs) {
        if (/condition/i.test(d.name)) values[d.name] = (d.content ?? []).find((o) => String(o.reference ?? o.data).toLowerCase() === condition.toLowerCase())?.data ?? condition;
        else if (/length|value/i.test(d.name) || /integer/i.test(String(d.contentType))) values[d.name] = length;
    }
    return requestAttributesFrom(defs, values, String(length));
}

test.describe('REG-COMP compliance (API)', { tag: tags.regression }, () => {
    test('REG-COMP-03: an own RSA-2048 certificate on the run RA profile: rule Equals 2048 → ok; Equals 4096 → nok; no applicable rule → na; ok + nok together → nok',
        meta({ id: 'REG-COMP-03', prio: 'P1', issue: 'ilm#436', rule: ['platform-keys-connectors A4 r17 (ilm#70: overall nok if any rule is nok, na if none applies, else ok); P-COMP'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(300_000);
            const ra = await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const x509 = (await apiJson<Json[]>(api, 'GET', '/api/v1/connectors')).find((c) => c.status === 'connected'
                && (c.functionGroups ?? []).some((g: Json) => (g.functionGroupCode === 'complianceProvider' || g.code === 'complianceProvider') && (g.kinds ?? []).includes('x509')));
            test.skip(!x509, 'no connected x509 compliance provider on this tier');
            const rules = await listProviderRules(api, { connectorUuid: String(x509!.uuid), kind: 'x509' });
            const keyLength = rules.find((r) => String(r.name) === 'cus_key_length');
            expect(keyLength, 'the provider offers cus_key_length').toBeTruthy();
            const rule = { ruleUuid: String(keyLength!.uuid), connectorUuid: String(x509!.uuid), kind: 'x509' };

            const certificate = await test.step('Own RSA-2048 certificate on the run RA profile', async () => {
                const commonName = regName(`comp-${Date.now().toString(36)}`);
                const csr = csrWithSan(commonName);
                const issued = await issueWithCsr(api, ra.authorityUuid, ra.uuid, csr.derBase64);
                const ref = recordCreated('certificates', { uuid: issued.uuid, name: commonName }, SPEC, 'compliance subject', { authority: ra.authorityUuid, raProfile: ra.uuid });
                await recordDerivedKeyOf(api, ref.uuid, issued.createdAfter, SPEC); // live run 2: the certKey_ key was left on the tier
                await waitForCertificateState(api, ref.uuid, 'issued', 180_000);
                return ref;
            });
            const profile = await createOwnComplianceProfile(api, `comp-${Date.now().toString(36)}`, SPEC);
            expect((await associateOwnComplianceProfile(api, profile, 'raProfiles', { uuid: ra.uuid, name: ra.name, kind: 'own' })).status()).toBeLessThan(300);

            const check = async (title: string, expected: 'ok' | 'nok' | 'na') => test.step(title, async () => {
                const result = await checkOwnCertificateCompliance(api, certificate);
                expect(overallComplianceStatus(result), JSON.stringify(result).slice(0, 300)).toBe(expected);
            });
            const add = async (condition: 'Equals', length: number) => expect((await patchOwnComplianceRule(api, profile, rule, keyLengthAttributes(keyLength!, condition, length))).status()).toBeLessThan(300);
            const remove = async () => expect((await patchOwnComplianceRule(api, profile, rule, [], true)).status()).toBeLessThan(300);

            // A profile WITHOUT rules is skipped by core's checkCompliance (`!p.getComplianceRules().isEmpty()`): the result is not_checked,
            // not na (live run 2). ilm#70's AC "na if none applies" speaks of rules that exist and do not apply; a rule-less profile is not
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
            // Live run 4: re-adding the SAME rule REPLACES it (core addRule deletes the profile's rule of that connector / kind / ruleUuid first), so one
            // profile cannot hold ok + nok. A SECOND own profile on the same own RA profile holds Equals 4096 while the first holds Equals 2048;
            // both are in the ledger (the helper records them) and teardown removes compliance profiles before the RA profile (step 10).
            await add('Equals', 2048);
            await check('Equals 2048 on profile 1 → ok', 'ok');
            const second = await createOwnComplianceProfile(api, `comp2-${Date.now().toString(36)}`, SPEC);
            expect((await associateOwnComplianceProfile(api, second, 'raProfiles', { uuid: ra.uuid, name: ra.name, kind: 'own' })).status()).toBeLessThan(300);
            expect((await patchOwnComplianceRule(api, second, rule, keyLengthAttributes(keyLength!, 'Equals', 4096))).status()).toBeLessThan(300);
            await check('ok (profile 1) + nok (profile 2) together → nok', expectedOverallStatus(['ok', 'nok']));
        });
});
