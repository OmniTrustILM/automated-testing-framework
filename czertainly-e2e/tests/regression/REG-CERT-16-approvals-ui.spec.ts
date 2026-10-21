/**
 * REG-CERT-16 / 17 — issue under an approval profile in the web UI, then approve or reject through the override path of
 * the Approvals list: an approved certificate is issued with the history and the override comment, a rejected one stays
 * Rejected with every lifecycle action disabled. The approval profile is tied to an own RA-profile clone only and released
 * at the end; certificates and approvals are recorded before any assertion; `assertOwnLive` runs before the toolbar acts.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { ApprovalsPage } from '../../pages/ApprovalsPage';
import { CertificateDetailPage } from '../../pages/CertificateDetailPage';
import { CertificatePage } from '../../pages/CertificatePage';
import { findApproval, openApprovalGate } from '../../utils/regression/lifecycle/approvals';
import { historyMessages, historyOf } from '../../utils/regression/lifecycle/certificateHistory';
import { approvalClosedText } from '../../utils/regression/lifecycle/certificateLabels';
import { assertOwnLive } from '../../utils/regression/ledger/ownership';
import { csrWithSan } from '../../utils/regression/pkiBuilders';
import { getCertificate, serverCreatedAfter } from '../../utils/regression/apiReads';
import { recordCertificatesNamed, recordDerivedKeyOf } from '../../utils/regression/issuedRecords';
import { runName } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';
import { LIFECYCLE_MS } from '../../utils/regression/timeouts';
import { waitForCertificateState } from '../../utils/certificateUtils';
import { escapeRegExp } from '../../utils/regression/text';

const SPEC = 'REG-CERT-16';

test.describe('Approvals in the web UI', { tag: tags.regression }, () => {
    test('a gated issue waits for approval and the override Approve in the Approvals list issues it',
        testMeta({
            id: 'REG-CERT-16', prio: 'P1', issue: 'ilm#429',
            rule: [
                'an approval is raised and the certificate waits in PENDING_APPROVAL; Approvals list and detail; override approve (recipient comment "Approval flow overridden")',
                'approved issue → ISSUED; core#1449 (history "Approval for action issue with approval profile <name> closed with status Approved"), core#1453 (the comment is shown)',
            ],
        }),
        async ({ page, api, env, ownRaProfile }) => {
            // The gated issue (60 s approval), the list, the issuance after the approve (180 s) and the tab checks.
            test.setTimeout(LIFECYCLE_MS);
            // ownRaProfile: requested for its skip without a CA (the gate clones the run RA profile).
            const gate = await test.step('Prerequisite: an own RA+ clone with the run approval profile associated', async () => openApprovalGate(api, SPEC, 'ui16'));
            try {
                const certPage = new CertificatePage(page);
                const detail = new CertificateDetailPage(page);
                const approvalsPage = new ApprovalsPage(page);
                const cn = `${runName(`ui16-${Date.now().toString(36)}`)}.example.test`;
                const csr = csrWithSan(cn, [cn]);

                const createdAfter = await serverCreatedAfter(api);
                const uuid = await test.step('Add Certificate → Request now → the gated RA profile → External → CSR → Create', async () => {
                    await loginAsSmokeUser(page, env);
                    await certPage.goToList();
                    await certPage.openIssuePage();
                    await certPage.selectRequestTypeIssue();
                    await certPage.selectRaProfile(gate.ra.name);
                    await certPage.selectKeySourceExternal();
                    await certPage.pasteCsr(csr.pem);
                    let id: string;
                    try {
                        // submitIssue handles the redirect and the "accepted with warnings" panel (Open certificate).
                        id = await certPage.submitIssue();
                    } finally {
                        // Ledger before assertion, whether the redirect came or not.
                        await recordCertificatesNamed(api, cn, SPEC, 'issued via UI under an approval profile (REG-CERT-16)');
                    }
                    return id;
                });

                const approval = await test.step('After reload the state is Pending approval; the Approvals tab shows the approval Pending', async () => {
                    await waitForCertificateState(api, uuid, 'pending_approval', 60_000);
                    await recordDerivedKeyOf(api, uuid, createdAfter, SPEC); // the key core links at request time (seen left on a live tier)
                    const a = await findApproval(api, { uuid, name: cn, kind: 'own' }, SPEC, { status: 'Pending' });
                    await certPage.goToDetail(uuid);
                    await page.reload();
                    await detail.openTab('Details');
                    await detail.assertState('Pending approval');
                    await detail.goToDetailTab(uuid, 'Approvals');
                    await detail.assertApprovalRow(a.uuid, 'Pending');
                    return a;
                });

                await test.step('Approvals → List of Approvals → the row → toolbar Approve (PATCH …/approve) → status Approved', async () => {
                    await assertOwnLive(api, 'approvals', approval, 'REG-CERT-16 override approve (UI)');
                    await approvalsPage.goToList();
                    await approvalsPage.checkRow(approval.uuid);
                    expect(await approvalsPage.overrideApprove(approval.uuid)).toBe(204);
                    await approvalsPage.assertStatus(approval.uuid, 'Approved');
                });

                await test.step('The certificate is Issued (API poll); History "Approval for action issue with approval profile <AP> closed with status Approved"', async () => {
                    await waitForCertificateState(api, uuid, 'issued', 180_000);
                    await recordDerivedKeyOf(api, uuid, createdAfter, SPEC);
                    expect(historyMessages(await historyOf(api, uuid))).toContainEqual(expect.stringContaining(approvalClosedText('issue', gate.approvalProfile.name, 'Approved')));
                    await certPage.goToDetail(uuid);
                    await page.reload();
                    await detail.openTab('Details');
                    await detail.assertState('Issued');
                    await detail.goToDetailTab(uuid, 'History');
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
            id: 'REG-CERT-17', prio: 'P1', issue: 'ilm#429',
            rule: [
                'rejected issue: PENDING_APPROVAL → REJECTED, the request stays; history "… closed with status Rejected"; override reject',
                'Issue only for Requested; Renew / Rekey / Revoke only for Issued; REJECTED is terminal',
            ],
        }),
        async ({ page, api, env, ownRaProfile }) => {
            test.setTimeout(300_000);
            // ownRaProfile: requested for its skip without a CA (the gate clones the run RA profile).
            const gate = await test.step('Prerequisite: an own RA+ clone with the run approval profile associated', async () => openApprovalGate(api, SPEC, 'ui17'));
            try {
                const certPage = new CertificatePage(page);
                const detail = new CertificateDetailPage(page);
                const approvalsPage = new ApprovalsPage(page);
                const cn = `${runName(`ui17-${Date.now().toString(36)}`)}.example.test`;
                const csr = csrWithSan(cn, [cn]);
                const createdAfter17 = await serverCreatedAfter(api);

                const uuid = await test.step('Add Certificate on the gated RA profile → Pending approval', async () => {
                    await loginAsSmokeUser(page, env);
                    await certPage.goToList();
                    await certPage.openIssuePage();
                    await certPage.selectRequestTypeIssue();
                    await certPage.selectRaProfile(gate.ra.name);
                    await certPage.selectKeySourceExternal();
                    await certPage.pasteCsr(csr.pem);
                    let id: string;
                    try {
                        id = await certPage.submitIssue();
                    } finally {
                        await recordCertificatesNamed(api, cn, SPEC, 'issued via UI under an approval profile (REG-CERT-17)');
                    }
                    await waitForCertificateState(api, id, 'pending_approval', 60_000);
                    // Seen on a live tier: the certKey_ key core links at request time was left behind (rejected path): record it now.
                    await recordDerivedKeyOf(api, id, createdAfter17, SPEC);
                    return id;
                });

                const approval = await findApproval(api, { uuid, name: cn, kind: 'own' }, SPEC, { status: 'Pending' });

                await test.step('Approvals → List of Approvals → the row → toolbar Reject (PATCH …/reject) → status Rejected', async () => {
                    await assertOwnLive(api, 'approvals', approval, 'REG-CERT-17 override reject (UI)');
                    await approvalsPage.goToList();
                    await approvalsPage.checkRow(approval.uuid);
                    expect(await approvalsPage.overrideReject(approval.uuid)).toBe(204);
                    await approvalsPage.assertStatus(approval.uuid, 'Rejected');
                });

                await test.step('The certificate is Rejected; History "… closed with status Rejected"; the Request tab still opens; Issue / Renew / Rekey / Revoke disabled', async () => {
                    await waitForCertificateState(api, uuid, 'rejected', 60_000, { failOn: ['failed', 'issued'] });
                    expect(historyMessages(await historyOf(api, uuid))).toContainEqual(expect.stringContaining(approvalClosedText('issue', gate.approvalProfile.name, 'Rejected')));
                    expect((await getCertificate(api, uuid)).certificateRequest?.content, 'the CSR stays in the inventory').toBeTruthy();
                    await certPage.goToDetail(uuid);
                    await page.reload();
                    await detail.openTab('Details');
                    await detail.assertState('Rejected');
                    await detail.assertToolbar({ issue: 'disabled', renew: 'disabled', rekey: 'disabled', revoke: 'disabled' });
                    await certPage.assertRequestTab({ commonName: cn });
                    await detail.goToDetailTab(uuid, 'History');
                    await certPage.assertHistoryTabHasEntry(new RegExp(escapeRegExp(approvalClosedText('issue', gate.approvalProfile.name, 'Rejected'))));
                });
            } finally {
                await gate.release();
            }
        });
});
