/**
 * Revoke of an own issued certificate with keyCompromise, then a second revoke that is refused, and the validation
 * status after revocation.
 * Shared-tier safety: the certificate is own and recorded; the run-end teardown deletes it.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { historyMessages, historyOf } from '../../utils/regression/lifecycle/certificateHistory';
import { revokedText } from '../../utils/regression/lifecycle/certificateLabels';
import { revokeOwnCertificate } from '../../utils/regression/lifecycle/certificateOperations';
import { revalidate, validationEnabledFor } from '../../utils/regression/lifecycle/preRegistration';
import { messagesOf } from '../../utils/regression/lifecycle/rawAnswers';
import { issueOwnCertificate } from '../../utils/regression/ownCertificates';
import { getCertificate } from '../../utils/regression/apiReads';
import { testMeta, tags } from '../../utils/regression/tags';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'API-CERT-11';

test.describe('Certificate revoke through the v2 API', { tag: tags.api }, () => {
    test('a revoke with keyCompromise gives 204 and a revoked certificate, and a second revoke is refused',
        testMeta({
            id: 'API-CERT-11', prio: 'P1', issue: 'ilm#429',
            rule: [
                'revoke of an ISSUED certificate: 204, completion through the authority; wire code keyCompromise',
                'history "Certificate revoked. Reason: Key compromise"; REVOKED is terminal and the validation status becomes revoked',
                'an already revoked certificate: 422 "Certificate is already revoked. Certificate: …"',
            ],
        }),
        async ({ api, ownRaProfile }) => {
            // Issuance (180 s) + revocation (120 s).
            test.setTimeout(360_000);
            const ra = ownRaProfile;
            const cert = await test.step('Issue an own certificate', async () => issueOwnCertificate(api, ra, SPEC, { suffix: 'c11' }));

            await test.step('POST …/{c}/revoke {reason: keyCompromise, attributes: [], destroyKey: false} → 204 with an empty body', async () => {
                const a = await revokeOwnCertificate(api, cert, ra, { reason: 'keyCompromise', destroyKey: false });
                expect(a.status, a.text.slice(0, 300)).toBe(204);
                expect(a.text).toBe('');
            });

            await test.step('State revoked within 120 s; history "Certificate revoked. Reason: Key compromise"', async () => {
                await waitForCertificateState(api, cert.uuid, 'revoked', 120_000);
                expect(historyMessages(await historyOf(api, cert.uuid))).toContainEqual(expect.stringContaining(revokedText('Key compromise')));
            });

            await test.step('A second revoke → 422 ["Certificate is already revoked. Certificate: …"]', async () => {
                const a = await revokeOwnCertificate(api, cert, ra, { reason: 'keyCompromise', destroyKey: false });
                expect(a.status, a.text.slice(0, 300)).toBe(422);
                const messages = messagesOf(a);
                expect(messages).toHaveLength(1);
                expect(messages[0]).toMatch(/^Certificate is already revoked\. Certificate: /);
                expect((await getCertificate(api, cert.uuid)).state).toBe('revoked');
            });
        });

    test('a revoked certificate reports validation status revoked',
        testMeta({
            id: 'API-CERT-11', row: 'validation-status', prio: 'P1', issue: 'ilm#429',
            rule: ['REVOKED is terminal; the validation status also becomes revoked — docs certificate.md validation table'],
        }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(360_000);
            const ra = ownRaProfile;
            // The validation status is produced by certificate validation; when the tier / RA
            // profile has it switched off the row cannot be judged — a named skip, never a silent annotation.
            const enabled = await validationEnabledFor(api, ra);
            test.skip(enabled !== true, enabled === false ? 'certificate validation is disabled for the run RA profile / platform (settings read): no validation status to judge' : 'certificate validation settings not readable: the validation status cannot be judged');
            const cert = await test.step('Fixture: an own certificate, revoked', async () => {
                const c = await issueOwnCertificate(api, ra, SPEC, { suffix: 'c11v' });
                const a = await revokeOwnCertificate(api, c, ra, { reason: 'keyCompromise', destroyKey: false });
                expect(a.status, a.text.slice(0, 300)).toBe(204);
                await waitForCertificateState(api, c.uuid, 'revoked', 120_000);
                return c;
            });
            await test.step('GET …/{own}/validate re-runs the validation (polled on API state up to 60 s: CA CRL / OCSP timing); the detail then reports validationStatus revoked', async () => {
                const first = await revalidate(api, cert);
                expect(first, 'a validation result (a JSON object)').toEqual(expect.any(Object));
                await expect.poll(async () => {
                    await revalidate(api, cert);
                    return String((await getCertificate(api, cert.uuid)).validationStatus);
                }, { timeout: 60_000, intervals: [2_000, 5_000, 10_000], message: 'validationStatus of a revoked own certificate after re-validation' }).toBe('revoked');
            });
        });
});
