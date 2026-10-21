/**
 * Issue under an approval profile: the issue waits in pending approval; the override approve issues it (approval
 * Approved), the override reject leaves it rejected with its request content kept, and every operation refuses it.
 * Shared-tier safety: the approval profile is tied to an own RA+ clone only, never the run RA profile; the
 * certificates, approvals and the clone are recorded before any assertion.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { approvalDetail, approvalStatusLabel, decideApproval, findApproval, openApprovalGate, recipientComments, waitForApprovalStatus } from '../../utils/regression/lifecycle/approvals';
import { historyMessages, historyOf } from '../../utils/regression/lifecycle/certificateHistory';
import { approvalClosedText, stateGuardText } from '../../utils/regression/lifecycle/certificateLabels';
import { rekeyOwnCertificate, renewOwnCertificate, revokeOwnCertificate } from '../../utils/regression/lifecycle/certificateOperations';
import { createdAfterOfAnswer, messagesOf } from '../../utils/regression/lifecycle/rawAnswers';
import { submitOwnCertificate } from '../../utils/regression/ownCertificates';
import { csrFromKey } from '../../utils/regression/pkiBuilders';
import { getCertificate } from '../../utils/regression/apiReads';
import { recordDerivedKeyOf } from '../../utils/regression/issuedRecords';
import { testMeta, tags } from '../../utils/regression/tags';
import { SLOW_LIFECYCLE_MS } from '../../utils/regression/timeouts';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'API-CERT-16';

test.describe('Certificate approvals through the v2 API', { tag: tags.api }, () => {
    test('an issue under an approval profile waits, and override approve or reject decides it',
        testMeta({
            id: 'API-CERT-16', prio: 'P1', issue: 'ilm#429',
            rule: [
                'the listener raises an approval and moves the certificate to PENDING_APPROVAL; an administrator override (approve / reject) carries the comment "Approval flow overridden"',
                'approved issue: PENDING_APPROVAL → PENDING_ISSUE → ISSUED; rejected: PENDING_APPROVAL → REJECTED; history entry "Approval for action issue with approval profile <name> closed with status Approved|Rejected" (core#1449)',
                'core#1453 (the approval comment is recorded on the recipient), a rejected certificate refuses renew / rekey / revoke',
            ],
        }),
        async ({ api, ownRaProfile }) => {
            // Two gated issues (each a 60 s approval wait), one 180 s issuance, the reads.
            test.setTimeout(SLOW_LIFECYCLE_MS);
            // ownRaProfile: requested for its skip without a CA
            const gate = await test.step('Prerequisite: an own RA+ clone with the run approval profile associated', async () => openApprovalGate(api, SPEC, 'g16'));
            try {
                const ap = gate.approvalProfile;

                const first = await test.step('POST issue on RA+ → 200; the certificate is pending_approval and its approval is Pending', async () => {
                    const c = await submitOwnCertificate(api, gate.ra, SPEC, { suffix: 'c16a', note: 'API-CERT-16 approve variant' });
                    expect(c.answer.status, c.answer.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, c.uuid, 'pending_approval', 60_000);
                    const approval = await findApproval(api, c, SPEC, { status: 'Pending' });
                    expect(approvalStatusLabel(approval.row.status)).toBe('Pending');
                    expect(approvalStatusLabel((await approvalDetail(api, approval)).status)).toBe('Pending');
                    return { cert: c, approval };
                });

                await test.step('Override approve → 204; the certificate is issued; the approval is Approved with the comment "Approval flow overridden"', async () => {
                    const d = await decideApproval(api, first.approval, 'approve');
                    expect(d.status, d.text.slice(0, 200)).toBe(204);
                    await waitForCertificateState(api, first.cert.uuid, 'issued', 180_000);
                    await recordDerivedKeyOf(api, first.cert.uuid, createdAfterOfAnswer(first.cert.answer), SPEC);
                    const detail = await waitForApprovalStatus(api, first.approval, 'Approved', 30_000);
                    expect(approvalStatusLabel(detail.status)).toBe('Approved');
                    expect(recipientComments(detail)).toContain('Approval flow overridden');
                });

                await test.step('History: "Approval for action issue with approval profile <AP> closed with status Approved", never "Pending"', async () => {
                    const messages = historyMessages(await historyOf(api, first.cert.uuid));
                    expect(messages).toContainEqual(expect.stringContaining(approvalClosedText('issue', ap.name, 'Approved')));
                    expect(messages.filter((m) => m.includes('closed with status Pending'))).toEqual([]);
                });

                const second = await test.step('A second issue on RA+ → pending_approval; override reject → 204; the certificate is rejected', async () => {
                    const c = await submitOwnCertificate(api, gate.ra, SPEC, { suffix: 'c16r', note: 'API-CERT-16 reject variant' });
                    expect(c.answer.status, c.answer.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, c.uuid, 'pending_approval', 60_000);
                    const approval = await findApproval(api, c, SPEC, { status: 'Pending' });
                    const d = await decideApproval(api, approval, 'reject');
                    expect(d.status, d.text.slice(0, 200)).toBe(204);
                    await waitForCertificateState(api, c.uuid, 'rejected', 60_000, { failOn: ['failed', 'issued'] });
                    expect(approvalStatusLabel((await waitForApprovalStatus(api, approval, 'Rejected', 30_000)).status)).toBe('Rejected');
                    return c;
                });

                await test.step('History "… closed with status Rejected"; the request content is kept', async () => {
                    expect(historyMessages(await historyOf(api, second.uuid))).toContainEqual(expect.stringContaining(approvalClosedText('issue', ap.name, 'Rejected')));
                    const detail = await getCertificate(api, second.uuid);
                    expect(detail.state).toBe('rejected');
                    expect(String(detail.certificateRequest?.content ?? ''), 'the CSR stays on the rejected certificate').toMatch(/^[A-Za-z0-9+/=\s-]+$/);
                });

                await test.step('renew, rekey, revoke on the rejected certificate → 422 "… in state Rejected"', async () => {
                    const csr = csrFromKey(second.keys, second.cn, second.sans);
                    for (const [op, call] of [
                        ['renew', () => renewOwnCertificate(api, second, gate.ra, SPEC, { csrDerBase64: csr.derBase64 })],
                        ['rekey', () => rekeyOwnCertificate(api, second, gate.ra, SPEC, { csrDerBase64: csr.derBase64 })],
                        ['revoke', () => revokeOwnCertificate(api, second, gate.ra, { reason: 'unspecified' })],
                    ] as const) {
                        const a = await call();
                        expect(a.status, `${op}: ${a.text.slice(0, 200)}`).toBe(422);
                        expect(messagesOf(a)[0]).toContain(stateGuardText(op, 'rejected'));
                    }
                });
            } finally {
                await gate.release();
            }
        });
});
