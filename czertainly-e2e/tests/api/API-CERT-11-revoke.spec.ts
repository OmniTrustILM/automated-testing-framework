/**
 * API-CERT-11 — revoke an own issued certificate with keyCompromise, then revoke it again (ilm#429 step 3;
 * cert-lifecycle rules §4.2 RV-1, RV-3, RV-5, RV-11; §11 rule 4). The certificate is own and recorded; the run-end
 * teardown deletes it (already revoked, so no second revoke).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { historyMessages, historyOf, issueOwnCertificate, messagesOf, revalidate, revokedText, revokeOwn, validationEnabledFor } from '../../utils/regression/lifecycle';
import { ensureRaProfileOrSkip, getCertificate } from '../../utils/regression/regressionApi';
import { meta, tags } from '../../utils/regression/tags';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'API-CERT-11';

test.describe('API-CERT-11 revoke', { tag: tags.api }, () => {
    test('API-CERT-11: revoke with keyCompromise answers 204, the certificate becomes revoked with the history reason label; a second revoke is a 422 "already revoked"',
        meta({
            id: 'API-CERT-11', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §4.2 RV-1 (revoke of an ISSUED certificate: 204, completion through the authority), RV-2 (wire code keyCompromise)',
                'cert-lifecycle §4.2 RV-5 (history "Certificate revoked. Reason: Key compromise"), RV-11 (REVOKED is terminal; the validation status becomes revoked)',
                'cert-lifecycle §4.2 RV-3 (an already revoked certificate: 422 "Certificate is already revoked. Certificate: …"), §11 rule 4',
            ],
        }),
        async ({ api }) => {
            // Issuance (180 s) + revocation (120 s).
            test.setTimeout(360_000);
            const ra = await test.step('Prerequisite: the run RA profile (CA-agnostic, enabled)', async () => ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason)));
            const cert = await test.step('Issue an own certificate', async () => issueOwnCertificate(api, ra, SPEC, { suffix: 'c11' }));

            await test.step('POST …/{c}/revoke {reason: keyCompromise, attributes: [], destroyKey: false} → 204 with an empty body', async () => {
                const a = await revokeOwn(api, cert, ra, { reason: 'keyCompromise', destroyKey: false });
                expect(a.status, a.text.slice(0, 300)).toBe(204);
                expect(a.text).toBe('');
            });

            await test.step('State revoked within 120 s; history "Certificate revoked. Reason: Key compromise"', async () => {
                await waitForCertificateState(api, cert.uuid, 'revoked', 120_000);
                expect(historyMessages(await historyOf(api, cert.uuid))).toContainEqual(expect.stringContaining(revokedText('Key compromise')));
            });

            await test.step('A second revoke → 422 ["Certificate is already revoked. Certificate: …"]', async () => {
                const a = await revokeOwn(api, cert, ra, { reason: 'keyCompromise', destroyKey: false });
                expect(a.status, a.text.slice(0, 300)).toBe(422);
                const messages = messagesOf(a);
                expect(messages).toHaveLength(1);
                expect(messages[0]).toMatch(/^Certificate is already revoked\. Certificate: /);
                expect((await getCertificate(api, cert.uuid)).state).toBe('revoked');
            });
        });

    test('API-CERT-11[validation-status]: once revoked, a re-validation of the certificate reports the validation status revoked',
        meta({
            id: 'API-CERT-11', prio: 'P1', issue: 'ilm#429',
            rule: ['cert-lifecycle §4.2 RV-11 (REVOKED is terminal; the validation status also becomes revoked — docs certificate.md validation table)'],
        }),
        async ({ api }) => {
            test.setTimeout(360_000);
            const ra = await test.step('Prerequisite: the run RA profile (CA-agnostic, enabled)', async () => ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason)));
            // Haiku F1 (author decision): the validation status is produced by certificate validation; when the tier / RA
            // profile has it switched off the row cannot be judged — a named skip, never a silent annotation.
            const enabled = await validationEnabledFor(api, ra);
            test.skip(enabled !== true, enabled === false ? 'certificate validation is disabled for the run RA profile / platform (settings read): no validation status to judge' : 'certificate validation settings not readable: the validation status cannot be judged');
            const cert = await test.step('Fixture: an own certificate, revoked', async () => {
                const c = await issueOwnCertificate(api, ra, SPEC, { suffix: 'c11v' });
                const a = await revokeOwn(api, c, ra, { reason: 'keyCompromise', destroyKey: false });
                expect(a.status, a.text.slice(0, 300)).toBe(204);
                await waitForCertificateState(api, c.uuid, 'revoked', 120_000);
                return c;
            });
            await test.step('GET …/{own}/validate re-runs the validation (polled on API state up to 60 s: CA CRL / OCSP timing); the detail then reports validationStatus revoked', async () => {
                const first = await revalidate(api, cert);
                expect(first, 'a validation result').toBeTruthy();
                await expect.poll(async () => {
                    await revalidate(api, cert);
                    return String((await getCertificate(api, cert.uuid)).validationStatus);
                }, { timeout: 60_000, intervals: [2_000, 5_000, 10_000], message: 'validationStatus of a revoked own certificate after re-validation' }).toBe('revoked');
            });
        });
});
