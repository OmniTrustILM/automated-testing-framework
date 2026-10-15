/**
 * API-CERT-16 — issue under an approval profile (ilm#429 steps 5–7; cert-lifecycle rules §5.2 AP-4, AP-6, AP-8, AP-10;
 * core#1449, core#1453): the issue waits in pending_approval; the override approve issues it (approval Approved, comment
 * "Approval flow overridden", history "closed with status Approved"); the override reject leaves it rejected with its
 * request content kept, and the lifecycle operations refuse it.
 *
 * One identity (Phase 2 §C): decisions go through the override endpoints. The approval profile is associated with an
 * own RA+ clone only (never the run RA profile) and dissociated at the end; both certificates, the approvals and the
 * clone are recorded in the ledger before any assertion.
 */
import { expect, test } from '../../fixtures/testFixtures';
import {
    approvalClosedText, approvalDetail, createdAfterOf, decideApproval, findApproval, historyMessages, historyOf, messagesOf, openApprovalGate, recipientComments,
    approvalStatusLabel, rekeyOwn, renewOwn, revokeOwn, stateGuardText, submitOwnCertificate, waitForApprovalStatus,
} from '../../utils/regression/lifecycle';
import { csrFromKey } from '../../utils/regression/pki';
import { ensureRaProfileOrSkip, getCertificate, recordDerivedKeyOf } from '../../utils/regression/regressionApi';
import { meta, tags } from '../../utils/regression/tags';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'API-CERT-16';

test.describe('API-CERT-15 approvals', { tag: tags.api }, () => {
    test('API-CERT-16: an issue on an RA profile with an approval profile waits; the override approve issues it with the approval closed Approved; the override reject leaves it rejected and refused by every operation',
        meta({
            id: 'API-CERT-16', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §5.2 AP-4 (the listener raises an approval and moves the certificate to PENDING_APPROVAL), AP-6 (override approve / reject by an administrator, comment "Approval flow overridden")',
                'cert-lifecycle §5.2 AP-8 (approved issue: PENDING_APPROVAL → PENDING_ISSUE → ISSUED; rejected: PENDING_APPROVAL → REJECTED), AP-10 (history "Approval for action issue with approval profile <name> closed with status Approved|Rejected", core#1449)',
                'core#1453 (the approval comment is recorded on the recipient), cert-lifecycle §3.2 RR-2 3 (a rejected certificate refuses renew / rekey / revoke), §11 rule 5',
            ],
        }),
        async ({ api }) => {
            // Two gated issues (each a 60 s approval wait), one 180 s issuance, the reads.
            test.setTimeout(480_000);
            await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const gate = await test.step('Prerequisite: an own RA+ clone with the run approval profile (AP) associated', async () => openApprovalGate(api, SPEC, 'g16'));
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
                    await recordDerivedKeyOf(api, first.cert.uuid, createdAfterOf(first.cert.answer), SPEC);
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
                    expect(detail.certificateRequest?.content, 'the CSR stays on the rejected certificate').toBeTruthy();
                });

                await test.step('renew, rekey, revoke on the rejected certificate → 422 "… in state Rejected"', async () => {
                    const csr = csrFromKey(second.keys, second.cn, second.sans);
                    for (const [op, call] of [
                        ['renew', () => renewOwn(api, second, gate.ra, SPEC, { csrDerBase64: csr.derBase64 })],
                        ['rekey', () => rekeyOwn(api, second, gate.ra, SPEC, { csrDerBase64: csr.derBase64 })],
                        ['revoke', () => revokeOwn(api, second, gate.ra, { reason: 'unspecified' })],
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
