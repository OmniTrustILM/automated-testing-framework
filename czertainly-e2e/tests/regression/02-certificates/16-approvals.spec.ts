/**
 * REG-CERT-16, REG-CERT-17 — Issue under an approval profile, then approve or reject by override (release checklist:
 * Certificates 16 and 17). ilm#429.
 *
 * WHAT: 1. Add Certificate on an RA profile with an approval profile (REG-CERT-16) → the certificate waits as Pending approval;
 *          its Approvals tab shows the approval as Pending.
 *       2. Approvals → List of Approvals → the row → Approve (override) → status Approved.
 *       3. The certificate becomes Issued; the History tab says "Approval for action issue with approval profile <name> closed
 *          with status Approved"; the approval detail shows Approved and the override comment "Approval flow overridden".
 *       4. The same flow rejected (REG-CERT-17) → override Reject → the certificate is Rejected, its history says "closed with
 *          status Rejected", the Request tab still opens, and Issue, Renew, Rekey and Revoke are disabled.
 * WHY: an approval gate must hold a request until it is decided; an approved one issues, a rejected one is terminal and
 *      keeps its request. A red test means the gate leaks, the override does not act, or a rejected certificate can still act.
 * HOW: the approval profile is tied to an own clone of the run's RA profile only and released at the end (also on failure).
 *      Certificates and approvals are recorded in the ledger before any assertion (the certificate from the answer of the Create
 *      request, before the redirect wait, by common name when the answer names no object), and the key core links at request
 *      time is recorded as derived; the live ownership check runs on the approval
 *      before the toolbar acts. Without a CA the tests skip with the reason.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { ApprovalsPage } from '../../../pages/ApprovalsPage';
import { CertificateAddPage } from '../../../pages/CertificateAddPage';
import { submitFormCreateRecorded } from '../../../utils/regression/ui/certificateFormCreate';
import { CertificateDetailPage } from '../../../pages/CertificateDetailPage';
import { CertificatePage } from '../../../pages/CertificatePage';
import { findApproval, openApprovalGate } from '../../../utils/regression/lifecycle/approvals';
import { historyMessages, historyOf } from '../../../utils/regression/lifecycle/certificateHistory';
import { approvalClosedText } from '../../../utils/regression/lifecycle/certificateLabels';
import { csrWithSan } from '../../../utils/regression/pkiBuilders';
import { getCertificate, serverCreatedAfter } from '../../../utils/regression/apiReads';
import { ownCommonName } from '../../../utils/regression/ledger/runState';
import { waitIssued } from '../../../utils/regression/ownCertificates';
import { testMeta, tags } from '../../../utils/regression/tags';
import { APPROVAL_REJECT_TEST_MS, APPROVAL_STATE_WAIT_MS, LIFECYCLE_MS } from '../../../utils/regression/timeouts';
import { waitForCertificateState } from '../../../utils/regression/wait/certificateState';
import { escapeRegExp } from '../../../utils/regression/text';


test.describe('Approvals in the web UI', { tag: tags.regression }, () => {
    test('a gated issue waits for approval and the override Approve in the Approvals list issues it',
        testMeta({
            id: 'REG-CERT-16', prio: 'P1', issue: 'ilm#429',
            rule: [
                'an approval is raised and the certificate waits in PENDING_APPROVAL; Approvals list and detail; override approve (recipient comment "Approval flow overridden")',
                'approved issue → ISSUED; core#1449 (history "Approval for action issue with approval profile <name> closed with status Approved"), core#1453 (the comment is shown)',
            ],
        }),
        async ({ signedIn: page, api, own, live, ownRaProfile }) => {
            // The gated issue (60 s approval), the list, the issuance after the approve (180 s) and the tab checks.
            test.setTimeout(LIFECYCLE_MS);
            // ownRaProfile: requested for its skip without a CA (the gate clones the run RA profile).
            const gate = await test.step('Prerequisite: an own clone of the run RA profile with the run approval profile associated', async () => openApprovalGate(api, own.spec, 'ui16'));
            try {
                const certPage = new CertificatePage(page);
                const addPage = new CertificateAddPage(page);
                const detail = new CertificateDetailPage(page);
                const approvalsPage = new ApprovalsPage(page);
                const cn = ownCommonName('ui16');
                const csr = csrWithSan(cn, [cn]);

                const createdAfter = await serverCreatedAfter(api);
                const uuid = await test.step('Add Certificate → Request now → the gated RA profile → External → CSR → Create', async () => {
                    await certPage.goToList();
                    await certPage.openIssuePage();
                    await certPage.selectRequestTypeIssue();
                    await certPage.selectRaProfile(gate.ra.name);
                    await certPage.selectKeySourceExternal();
                    await certPage.pasteCsr(csr.pem);
                    await submitFormCreateRecorded(addPage, own, 'issue', { cn: cn, note: 'issued via UI under an approval profile', ra: gate.ra });
                    // This row accepts the "accepted with warnings" panel (the certificate is opened from it).
                    const id = (await addPage.waitForCreatedCertificate({ acceptWarnings: true })).uuid;
                    return id;
                });

                const approval = await test.step('After reload the state is Pending approval; the Approvals tab shows the approval Pending', async () => {
                    await waitForCertificateState(api, uuid, 'pending_approval', APPROVAL_STATE_WAIT_MS);
                    await own.derivedKey(uuid, createdAfter); // the key core links at request time (it stays behind when the request is refused)
                    const a = await findApproval(api, { uuid, name: cn, kind: 'own' }, own.spec, { status: 'Pending' });
                    await detail.openFresh(uuid);
                    await detail.assertState('Pending approval');
                    await detail.goToDetail(uuid, { tab: 'Approvals' });
                    await detail.assertApprovalRow(a.uuid, 'Pending');
                    return a;
                });

                await test.step('Approvals → List of Approvals → the row → toolbar Approve (PATCH …/approve) → status Approved', async () => {
                    await live('approvals', approval);
                    await approvalsPage.goToList();
                    await approvalsPage.checkRow(approval.uuid);
                    expect((await approvalsPage.overrideApprove(approval.uuid)).status).toBe(204);
                    await approvalsPage.assertStatus(approval.uuid, 'Approved');
                });

                await test.step('The certificate is Issued (API poll); History "Approval for action issue with approval profile <AP> closed with status Approved"', async () => {
                    await waitIssued(api, uuid);
                    await own.derivedKey(uuid, createdAfter);
                    expect(historyMessages(await historyOf(api, uuid))).toContainEqual(expect.stringContaining(approvalClosedText('issue', gate.approvalProfile.name, 'Approved')));
                    await detail.openFresh(uuid);
                    await detail.assertState('Issued');
                    await detail.goToDetail(uuid, { tab: 'History' });
                    await certPage.assertHistoryTabHasEntry(new RegExp(escapeRegExp(approvalClosedText('issue', gate.approvalProfile.name, 'Approved'))));
                });

                await test.step('The approval detail shows Approved and the override comment "Approval flow overridden"', async () => {
                    await approvalsPage.goToDetail(approval.uuid);
                    await approvalsPage.assertDetailStatus('Approved');
                    await approvalsPage.assertRecipientComment('Approval flow overridden');
                });
            } finally {
                await gate.release();
            }
        });

    test('the override Reject leaves the certificate Rejected with every lifecycle action disabled',
        testMeta({
            id: 'REG-CERT-17', prio: 'P2', issue: 'ilm#429',
            rule: [
                'rejected issue: PENDING_APPROVAL → REJECTED, the request stays; history "… closed with status Rejected"; override reject',
                'Issue only for Requested; Renew / Rekey / Revoke only for Issued; REJECTED is terminal',
            ],
        }),
        async ({ signedIn: page, api, own, live, ownRaProfile }) => {
            test.setTimeout(APPROVAL_REJECT_TEST_MS);
            // ownRaProfile: requested for its skip without a CA (the gate clones the run RA profile).
            const gate = await test.step('Prerequisite: an own clone of the run RA profile with the run approval profile associated', async () => openApprovalGate(api, own.spec, 'ui17'));
            try {
                const certPage = new CertificatePage(page);
                const addPage = new CertificateAddPage(page);
                const detail = new CertificateDetailPage(page);
                const approvalsPage = new ApprovalsPage(page);
                const cn = ownCommonName('ui17');
                const csr = csrWithSan(cn, [cn]);
                const createdAfter17 = await serverCreatedAfter(api);

                const uuid = await test.step('Add Certificate on the gated RA profile → Pending approval', async () => {
                    await certPage.goToList();
                    await certPage.openIssuePage();
                    await certPage.selectRequestTypeIssue();
                    await certPage.selectRaProfile(gate.ra.name);
                    await certPage.selectKeySourceExternal();
                    await certPage.pasteCsr(csr.pem);
                    await submitFormCreateRecorded(addPage, own, 'issue', { cn: cn, note: 'issued via UI under an approval profile', ra: gate.ra });
                    // This row accepts the "accepted with warnings" panel (the certificate is opened from it).
                    const id = (await addPage.waitForCreatedCertificate({ acceptWarnings: true })).uuid;
                    await waitForCertificateState(api, id, 'pending_approval', APPROVAL_STATE_WAIT_MS);
                    // Core links a key at request time and leaves it behind on the rejected path: record it now.
                    await own.derivedKey(id, createdAfter17);
                    return id;
                });

                const approval = await findApproval(api, { uuid, name: cn, kind: 'own' }, own.spec, { status: 'Pending' });

                await test.step('Approvals → List of Approvals → the row → toolbar Reject (PATCH …/reject) → status Rejected', async () => {
                    await live('approvals', approval);
                    await approvalsPage.goToList();
                    await approvalsPage.checkRow(approval.uuid);
                    expect((await approvalsPage.overrideReject(approval.uuid)).status).toBe(204);
                    await approvalsPage.assertStatus(approval.uuid, 'Rejected');
                });

                await test.step('The certificate is Rejected; History "… closed with status Rejected"; the Request tab still opens; Issue / Renew / Rekey / Revoke disabled', async () => {
                    await waitForCertificateState(api, uuid, 'rejected', APPROVAL_STATE_WAIT_MS, { failOn: ['failed', 'issued'] });
                    expect(historyMessages(await historyOf(api, uuid))).toContainEqual(expect.stringContaining(approvalClosedText('issue', gate.approvalProfile.name, 'Rejected')));
                    expect((await getCertificate(api, uuid)).certificateRequest?.content, 'the CSR stays in the inventory').toBeTruthy();
                    await detail.openFresh(uuid);
                    await detail.assertState('Rejected');
                    await detail.assertToolbar({ issue: 'disabled', renew: 'disabled', rekey: 'disabled', revoke: 'disabled' });
                    await certPage.assertRequestTab({ commonName: cn });
                    await detail.goToDetail(uuid, { tab: 'History' });
                    await certPage.assertHistoryTabHasEntry(new RegExp(escapeRegExp(approvalClosedText('issue', gate.approvalProfile.name, 'Rejected'))));
                });
            } finally {
                await gate.release();
            }
        });
});
