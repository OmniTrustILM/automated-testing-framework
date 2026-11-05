/**
 * API-CERT-16 — Certificate approvals through the v2 API: override approve and reject (ilm#429).
 *
 * The approval profile is tied to an own RA profile clone only, never the run RA profile; the test skips without a CA.
 * Certificates, approvals and the clone are ledgered before any assertion, and the gate is released in `finally`.
 * The approval comment is recorded on the recipient (core#1453) and the history names the final status (core#1449).
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { approvalDetail, approvalStatusLabel, decideApproval, findApproval, openApprovalGate, recipientComments, waitForApprovalStatus } from '../../../utils/regression/lifecycle/approvals';
import { historyMessages, historyOf } from '../../../utils/regression/lifecycle/certificateHistory';
import { approvalClosedText, stateGuardText } from '../../../utils/regression/lifecycle/certificateLabels';
import { rekeyOwnCertificate, renewOwnCertificate, revokeOwnCertificate } from '../../../utils/regression/lifecycle/certificateOperations';
import { createdAfterOfAnswer, messagesOf } from '../../../utils/regression/lifecycle/rawAnswers';
import { submitOwnCertificate, waitIssued } from '../../../utils/regression/ownCertificates';
import { csrFromKey } from '../../../utils/regression/pkiBuilders';
import { getCertificate } from '../../../utils/regression/apiReads';
import { testMeta, tags } from '../../../utils/regression/tags';
import { QUICK_STATE_WAIT_MS, SLOW_LIFECYCLE_MS, STATE_CHANGE_WAIT_MS } from '../../../utils/regression/timeouts';
import { waitForCertificateState } from '../../../utils/regression/wait/certificateState';

test.describe('Certificate approvals through the v2 API', { tag: tags.api }, () => {
    test('an issue under an approval profile waits, and override approve or reject decides it',
        testMeta({
            id: 'API-CERT-16', prio: 'P1', issue: 'ilm#429', needs: 'ca',
            rule: [
                'the listener raises an approval and moves the certificate to PENDING_APPROVAL; an administrator override (approve / reject) carries the comment "Approval flow overridden"',
                'approved issue: PENDING_APPROVAL → PENDING_ISSUE → ISSUED; rejected: PENDING_APPROVAL → REJECTED; history entry "Approval for action issue with approval profile <name> closed with status Approved|Rejected" (core#1449)',
                'core#1453 (the approval comment is recorded on the recipient), a rejected certificate refuses renew / rekey / revoke',
            ],
        }),
        async ({ api, own }) => {
            // Two gated issues (each a 60 s approval wait), one 180 s issuance, the reads.
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const gate = await test.step('Prerequisite: an own RA profile clone with the run approval profile associated', async () => openApprovalGate(api, own.spec, 'g16'));
            try {
                const ap = gate.approvalProfile;

                const first = await test.step('POST issue on the RA profile clone → 200; the certificate is pending_approval and its approval is Pending', async () => {
                    const c = await submitOwnCertificate(api, gate.ra, own.spec, { suffix: 'c16a', note: 'API-CERT-16 approve variant' });
                    expect(c.answer.status, c.answer.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, c.uuid, 'pending_approval', STATE_CHANGE_WAIT_MS);
                    const approval = await findApproval(api, c, own.spec, { status: 'Pending' });
                    expect(approvalStatusLabel(approval.row.status)).toBe('Pending');
                    expect(approvalStatusLabel((await approvalDetail(api, approval)).status)).toBe('Pending');
                    return { cert: c, approval };
                });

                await test.step('Override approve → 204; the certificate is issued; the approval is Approved with the comment "Approval flow overridden"', async () => {
                    const d = await decideApproval(api, first.approval, 'approve');
                    expect(d.status, d.text.slice(0, 200)).toBe(204);
                    await waitIssued(api, first.cert.uuid);
                    await own.derivedKey(first.cert.uuid, createdAfterOfAnswer(first.cert.answer));
                    const detail = await waitForApprovalStatus(api, first.approval, 'Approved', QUICK_STATE_WAIT_MS);
                    expect(approvalStatusLabel(detail.status)).toBe('Approved');
                    expect(recipientComments(detail)).toContain('Approval flow overridden');
                });

                await test.step('History: "Approval for action issue with approval profile <AP> closed with status Approved", never "Pending"', async () => {
                    const messages = historyMessages(await historyOf(api, first.cert.uuid));
                    expect(messages).toContainEqual(expect.stringContaining(approvalClosedText('issue', ap.name, 'Approved')));
                    expect(messages.filter((m) => m.includes('closed with status Pending'))).toEqual([]);
                });

                const second = await test.step('A second issue on the RA profile clone → pending_approval; override reject → 204; the certificate is rejected', async () => {
                    const c = await submitOwnCertificate(api, gate.ra, own.spec, { suffix: 'c16r', note: 'API-CERT-16 reject variant' });
                    expect(c.answer.status, c.answer.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, c.uuid, 'pending_approval', STATE_CHANGE_WAIT_MS);
                    const approval = await findApproval(api, c, own.spec, { status: 'Pending' });
                    const d = await decideApproval(api, approval, 'reject');
                    expect(d.status, d.text.slice(0, 200)).toBe(204);
                    await waitForCertificateState(api, c.uuid, 'rejected', STATE_CHANGE_WAIT_MS, { failOn: ['failed', 'issued'] });
                    expect(approvalStatusLabel((await waitForApprovalStatus(api, approval, 'Rejected', QUICK_STATE_WAIT_MS)).status)).toBe('Rejected');
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
                        ['renew', () => renewOwnCertificate(api, second, gate.ra, own.spec, { csrDerBase64: csr.derBase64 })],
                        ['rekey', () => rekeyOwnCertificate(api, second, gate.ra, own.spec, { csrDerBase64: csr.derBase64 })],
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
