/**
 * API-CERT-11 — Revoke of an own issued certificate through the v2 API. ilm#429.
 *
 * WHAT: 1. Revoke with keyCompromise → 204 with an empty body; the state becomes revoked; the history says "Certificate revoked. Reason:
 *          Key compromise"; a second revoke → 422 "Certificate is already revoked. Certificate: …".
 *       2. After revocation the certificate's validation status is revoked (re-validated and polled up to 60 s for the CA's CRL / OCSP
 *          timing).
 * WHY: revoked is terminal; the revoke is completed through the authority with the wire code keyCompromise, and the validation status
 *      follows (product documentation, certificate validation table). The validation row can only be judged where validation is enabled and
 *      the issuer certificate is in the inventory; otherwise it skips with the named reason.
 * HOW: the certificate is own and recorded in the ledger before any assertion; the run-end teardown deletes it. Issuance (180 s) plus
 *      revocation (120 s) plus the reads.
 */
import { ISSUE_AND_REVOKE_TEST_MS, STATE_CHANGE_WAIT_MS } from '../../../utils/regression/timeouts';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { historyMessages, historyOf } from '../../../utils/regression/lifecycle/certificateHistory';
import { revokedText } from '../../../utils/regression/lifecycle/certificateLabels';
import { revokeOwnCertificate } from '../../../utils/regression/lifecycle/certificateOperations';
import { revalidate, validationEnabledFor } from '../../../utils/regression/lifecycle/preRegistration';
import { expectRefused } from '../../../utils/regression/errorContract';
import { waitRevoked } from '../../../utils/regression/ownCertificates';
import { getCertificate } from '../../../utils/regression/apiReads';
import { testMeta, tags } from '../../../utils/regression/tags';

/**
 * The chain check of a validation result (`GET …/validate`: `validationChecks` keyed by the check code) when it is not valid, as a
 * named reason; undefined when the chain is valid or the result carries no chain check (then nothing is known against it).
 */
function chainNotValid(result: Record<string, any>): string | undefined {
    const checks = (result?.validationChecks ?? {}) as Record<string, { status?: string; message?: string }>;
    const chain = checks.certificate_chain ?? checks.CERTIFICATE_CHAIN;
    if (!chain || String(chain.status).toLowerCase() === 'valid') return undefined;
    return `the certificate chain check is ${String(chain.status)} (${String(chain.message ?? 'no message')}): the issuer certificate is not available in the inventory, so the validation status can never become revoked`;
}

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
        async ({ api, own, ownRaProfile }) => {
            // Issuance (180 s) + revocation (120 s).
            test.setTimeout(ISSUE_AND_REVOKE_TEST_MS);
            const ra = ownRaProfile;
            const cert = await test.step('Issue an own certificate', async () => own.certificate.issue(ra, { suffix: 'c11' }));

            await test.step('POST …/{c}/revoke {reason: keyCompromise, attributes: [], destroyKey: false} → 204 with an empty body', async () => {
                const a = await revokeOwnCertificate(api, cert, ra, { reason: 'keyCompromise', destroyKey: false });
                expect(a.status, a.text.slice(0, 300)).toBe(204);
                expect(a.text).toBe('');
            });

            await test.step('State revoked within 120 s; history "Certificate revoked. Reason: Key compromise"', async () => {
                await waitRevoked(api, cert.uuid);
                expect(historyMessages(await historyOf(api, cert.uuid))).toContainEqual(expect.stringContaining(revokedText('Key compromise')));
            });

            await test.step('A second revoke → 422 ["Certificate is already revoked. Certificate: …"]', async () => {
                const a = await revokeOwnCertificate(api, cert, ra, { reason: 'keyCompromise', destroyKey: false });
                expectRefused(a, { status: 422, text: 'Certificate is already revoked. Certificate: ', prefix: true });
                expect((await getCertificate(api, cert.uuid)).state).toBe('revoked');
            });
        });

    test('a revoked certificate reports validation status revoked',
        testMeta({
            id: 'API-CERT-11', row: 'validation-status', prio: 'P1', issue: 'ilm#429',
            rule: ['REVOKED is terminal; the validation status also becomes revoked (product documentation, certificate validation table)'],
        }),
        async ({ api, own, ownRaProfile }) => {
            test.setTimeout(ISSUE_AND_REVOKE_TEST_MS);
            const ra = ownRaProfile;
            // The validation status is produced by certificate validation; when the tier / RA
            // profile has it switched off the row cannot be judged — a named skip, never a silent annotation.
            const enabled = await validationEnabledFor(api, ra);
            test.skip(enabled !== true, enabled === false ? 'certificate validation is disabled for the run RA profile / platform (settings read): no validation status to judge' : 'certificate validation settings not readable: the validation status cannot be judged');
            const cert = await test.step('Fixture: an own certificate, revoked', async () => {
                const c = await own.certificate.issue(ra, { suffix: 'c11v' });
                // The validator answers invalid on an incomplete chain before it looks at CRL / OCSP: read the chain check first. It can only
                // be read on an issued certificate, so this skip runs after the issue (the certificate is already on the ledger).
                const problem = chainNotValid(await revalidate(api, c));
                test.skip(problem !== undefined, problem);
                const a = await revokeOwnCertificate(api, c, ra, { reason: 'keyCompromise', destroyKey: false });
                expect(a.status, a.text.slice(0, 300)).toBe(204);
                await waitRevoked(api, c.uuid);
                return c;
            });
            await test.step('GET …/{own}/validate re-runs the validation (polled on API state up to 60 s: CA CRL / OCSP timing); the detail then reports validationStatus revoked', async () => {
                const first = await revalidate(api, cert);
                expect(first, 'a validation result (a JSON object)').toEqual(expect.any(Object));
                await expect.poll(async () => {
                    await revalidate(api, cert);
                    return String((await getCertificate(api, cert.uuid)).validationStatus);
                }, { timeout: STATE_CHANGE_WAIT_MS, intervals: [2_000, 5_000, 10_000], message: 'validationStatus of a revoked own certificate after re-validation' }).toBe('revoked');
            });
        });
});
