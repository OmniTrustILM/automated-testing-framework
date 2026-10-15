/**
 * REG-CERT-16 / 17 — issue under an approval profile in the web UI, then approve or reject through the override path
 * of the Approvals list (ilm#429 steps 5–7; cert-lifecycle rules §5.4, §5.2 AP-4, AP-6, AP-8, AP-10, AP-11; core#1449,
 * core#1453). One identity: the override toolbar of `List of Approvals` (`PATCH /v1/approvals/{uuid}/approve|reject`);
 * the override has no comment field — the recipient comment it writes is "Approval flow overridden" (AP-6), which the
 * approval detail shows. The approval profile is associated with an own RA+ clone only and released at the end; the
 * certificate and its approval are recorded before any assertion; the browser is not behind the API guard, so the
 * approval's ledger line is checked (`assertOwnLive`) before the toolbar acts.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { ApprovalsPage } from '../../pages/ApprovalsPage';
import { CertificateLifecyclePage } from '../../pages/CertificateLifecyclePage';
import { approvalClosedText, findApproval, historyMessages, historyOf, openApprovalGate } from '../../utils/regression/lifecycle';
import { assertOwnLive } from '../../utils/regression/ownObjects';
import { csrWithSan } from '../../utils/regression/pki';
import { ensureRaProfileOrSkip, getCertificate, recordCertificatesNamed, recordDerivedKeyOf, serverCreatedAfter } from '../../utils/regression/regressionApi';
import { regName } from '../../utils/regression/regressionRun';
import { meta } from '../../utils/regression/tags';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'REG-CERT-16';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('@regression REG-CERT-16 approvals in the web UI', () => {
    test('REG-CERT-16: Add Certificate on a gated RA profile waits in Pending approval; the Approvals list override Approve issues it, the History says "closed with status Approved" and the approval detail shows the override comment',
        meta({
            id: 'REG-CERT-16', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §5.2 AP-4 (an approval is raised and the certificate waits in PENDING_APPROVAL), AP-11 (Approvals list and detail), AP-6 (override approve; recipient comment "Approval flow overridden")',
                'cert-lifecycle §5.2 AP-8 (approved issue → ISSUED), AP-10 / core#1449 (history "Approval for action issue with approval profile <name> closed with status Approved"), core#1453 (the comment is shown)',
            ],
        }),
        async ({ page, api, env }) => {
            // The gated issue (60 s approval), the list, the issuance after the approve (180 s) and the tab checks.
            test.setTimeout(420_000);
            await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const gate = await test.step('Prerequisite: an own RA+ clone with the run approval profile associated', async () => openApprovalGate(api, SPEC, 'ui16'));
            try {
                const certPage = new CertificateLifecyclePage(page);
                const approvalsPage = new ApprovalsPage(page);
                const cn = `${regName(`ui16-${Date.now().toString(36)}`)}.example.test`;
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
                        // Ledger before assertion, whether the redirect came or not (Sonnet 2).
                        await recordCertificatesNamed(api, cn, SPEC, 'issued via UI under an approval profile (REG-CERT-16)');
                    }
                    return id;
                });

                const approval = await test.step('After reload the state is Pending approval; the Approvals tab shows the approval Pending', async () => {
                    await waitForCertificateState(api, uuid, 'pending_approval', 60_000);
                    await recordDerivedKeyOf(api, uuid, createdAfter, SPEC); // the key core links at request time (live run 2)
                    const a = await findApproval(api, { uuid, name: cn, kind: 'own' }, SPEC, { status: 'Pending' });
                    await certPage.goToDetail(uuid);
                    await page.reload();
                    await certPage.assertState('Pending approval');
                    await certPage.assertApprovalRow(uuid, a.uuid, 'Pending');
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
                    await certPage.assertState('Issued');
                    await certPage.openDetailTab(uuid, 'History');
                    await certPage.assertHistoryTabHasEntry(new RegExp(escapeRe(approvalClosedText('issue', gate.approvalProfile.name, 'Approved'))));
                });

                await test.step('The approval detail shows Approved and the override comment "Approval flow overridden"', async () => {
                    await approvalsPage.openDetail(approval.uuid);
                    await approvalsPage.assertDetailStatus('Approved');
                    await approvalsPage.assertRecipientComment('Approval flow overridden');
                });
            } finally {
                await gate.release();
            }
        });

    test('REG-CERT-17: the Approvals list override Reject leaves the certificate Rejected with the History "closed with status Rejected"; the Request tab still opens and Issue / Renew / Rekey / Revoke are disabled',
        meta({
            id: 'REG-CERT-17', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §5.2 AP-8 (rejected issue: PENDING_APPROVAL → REJECTED; the request stays), AP-10 (history "… closed with status Rejected"), AP-6 (override reject)',
                'cert-lifecycle §7.6 (Issue only for Requested; Renew / Rekey / Revoke only for Issued), §7.2 (REJECTED is terminal)',
            ],
        }),
        async ({ page, api, env }) => {
            test.setTimeout(300_000);
            await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const gate = await test.step('Prerequisite: an own RA+ clone with the run approval profile associated', async () => openApprovalGate(api, SPEC, 'ui17'));
            try {
                const certPage = new CertificateLifecyclePage(page);
                const approvalsPage = new ApprovalsPage(page);
                const cn = `${regName(`ui17-${Date.now().toString(36)}`)}.example.test`;
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
                    // Live run 2: the certKey_ key core links at request time was left on the tier (rejected path): record it now.
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
                    await certPage.assertState('Rejected');
                    await certPage.assertToolbar({ issue: 'disabled', renew: 'disabled', rekey: 'disabled', revoke: 'disabled' });
                    await certPage.assertRequestTab({ commonName: cn });
                    await certPage.openDetailTab(uuid, 'History');
                    await certPage.assertHistoryTabHasEntry(new RegExp(escapeRe(approvalClosedText('issue', gate.approvalProfile.name, 'Rejected'))));
                });
            } finally {
                await gate.release();
            }
        });
});
