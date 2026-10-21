/**
 * The audit trail of each legal certificate state transition: the final state and the history event and status rows
 * in order, presence and order only, never counts; no 5xx anywhere.
 * Shared-tier safety: the approval walks run on an own RA+ clone, gated only while needed and released at the end.
 * The pre-registration walks need a path-less register call that the guard does not list yet.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { decideApproval, findApproval, openApprovalGate } from '../../utils/regression/lifecycle/approvals';
import { historyMessages, historyOf, historyOrderProblem, HistoryStep } from '../../utils/regression/lifecycle/certificateHistory';
import { approvalClosedText } from '../../utils/regression/lifecycle/certificateLabels';
import { issueExisting, revokeOwnCertificate } from '../../utils/regression/lifecycle/certificateOperations';
import { newChallenge, registerOwnCertificate, registrationDefaults } from '../../utils/regression/lifecycle/preRegistration';
import { createdAfterOfAnswer } from '../../utils/regression/lifecycle/rawAnswers';
import { issueOwnCertificate, submitOwnCertificate } from '../../utils/regression/ownCertificates';
import { newKeyPair, csrFromKey } from '../../utils/regression/pkiBuilders';
import { getCertificate } from '../../utils/regression/apiReads';
import { recordDerivedKeyOf } from '../../utils/regression/issuedRecords';
import { testMeta, tags } from '../../utils/regression/tags';
import { ISSUE_MS, LIFECYCLE_MS, SLOW_LIFECYCLE_MS } from '../../utils/regression/timeouts';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'API-CERT-34';

const RULES = [
    'the 25 legal certificate state transitions (their audit event / status: ISSUE, APPROVAL_REQUEST, APPROVAL_CLOSE, REVOKE, UPDATE_STATE with SUCCESS / FAILED)',
    'the walk rows; approval history rows: presence and text, never counts; core#1599 / core#1605 (the state machine)',
];

/** The walk's history carries the expected rows in order (collapsed: a row the machine audits twice counts once). */
async function expectWalk(api: Parameters<typeof historyOf>[0], uuid: string, finalState: string, expected: readonly HistoryStep[]): Promise<void> {
    expect((await getCertificate(api, uuid)).state, 'final state').toBe(finalState);
    const rows = await historyOf(api, uuid);
    expect(historyOrderProblem(rows, expected), `history rows in order: ${rows.map((r) => `${r.event}/${r.status}`).join(', ')}`).toBeUndefined();
}

test.describe('Certificate state transition audit trail', { tag: tags.api }, () => {
    test('issuing a certificate audits ISSUE SUCCESS',
        testMeta({ id: 'API-CERT-34', row: 'T-1', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(ISSUE_MS);
            const ra = ownRaProfile;
            const cert = await issueOwnCertificate(api, ra, SPEC, { suffix: 'w1' });
            await expectWalk(api, cert.uuid, 'issued', [['ISSUE', 'SUCCESS']]);
        });

    test('revoking an issued certificate audits ISSUE SUCCESS then REVOKE SUCCESS',
        testMeta({ id: 'API-CERT-34', row: 'T-2', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            const cert = await issueOwnCertificate(api, ra, SPEC, { suffix: 'w2' });
            const a = await revokeOwnCertificate(api, cert, ra, { reason: 'unspecified' });
            expect(a.status, a.text.slice(0, 200)).toBe(204);
            await waitForCertificateState(api, cert.uuid, 'revoked', 120_000);
            await expectWalk(api, cert.uuid, 'revoked', [['ISSUE', 'SUCCESS'], ['REVOKE', 'SUCCESS']]);
        });

    test('an approved or rejected issue audits the approval request and its close',
        testMeta({ id: 'API-CERT-34', row: 'T-3,T-4', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            // ownRaProfile: requested for its skip without a CA
            const gate = await openApprovalGate(api, SPEC, 'g34a');
            try {
                await test.step('Approved issue', async () => {
                    const cert = await submitOwnCertificate(api, gate.ra, SPEC, { suffix: 'w3' });
                    expect(cert.answer.status, cert.answer.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, cert.uuid, 'pending_approval', 60_000);
                    const approval = await findApproval(api, cert, SPEC, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'approve')).status).toBe(204);
                    await waitForCertificateState(api, cert.uuid, 'issued', 180_000);
                    await recordDerivedKeyOf(api, cert.uuid, createdAfterOfAnswer(cert.answer), SPEC);
                    await expectWalk(api, cert.uuid, 'issued', [['APPROVAL_REQUEST', 'SUCCESS'], ['APPROVAL_CLOSE', 'SUCCESS'], ['ISSUE', 'SUCCESS']]);
                    expect(historyMessages(await historyOf(api, cert.uuid))).toContainEqual(expect.stringContaining(approvalClosedText('issue', gate.approvalProfile.name, 'Approved')));
                });
                await test.step('Rejected issue', async () => {
                    const cert = await submitOwnCertificate(api, gate.ra, SPEC, { suffix: 'w4' });
                    expect(cert.answer.status, cert.answer.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, cert.uuid, 'pending_approval', 60_000);
                    const approval = await findApproval(api, cert, SPEC, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'reject')).status).toBe(204);
                    await waitForCertificateState(api, cert.uuid, 'rejected', 60_000, { failOn: ['failed', 'issued'] });
                    // The approval close is SUCCESS, the state machine then audits the
                    // rejection as UPDATE_STATE / FAILED "Certificate state changed from Pending approval to Rejected." (core
                    // handleFailedOrRejectedEvent).
                    await expectWalk(api, cert.uuid, 'rejected', [['APPROVAL_REQUEST', 'SUCCESS'], ['APPROVAL_CLOSE', 'SUCCESS'], ['UPDATE_STATE', 'FAILED']]);
                    expect(historyMessages(await historyOf(api, cert.uuid))).toContainEqual(expect.stringContaining('Certificate state changed from Pending approval to Rejected.'));
                });
            } finally {
                await gate.release();
            }
        });

    test('an approved or rejected revoke audits the approval request and outcome',
        testMeta({ id: 'API-CERT-34', row: 'T-5,T-6', prio: 'P1', issue: 'ilm#429', rule: [...RULES, 'reject restores ISSUED; core#1553'] }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(600_000);
            // ownRaProfile: requested for its skip without a CA
            // The certificates are issued on the clone BEFORE the approval profile is associated (an ungated issue), so the
            // revoke is the first gated operation.
            const gate = await openApprovalGate(api, SPEC, 'g34r', { associate: false });
            try {
                const [a, b] = await test.step('Fixture: two own certificates issued on the (not yet gated) clone', async () =>
                    Promise.all([issueOwnCertificate(api, gate.ra, SPEC, { suffix: 'w5' }), issueOwnCertificate(api, gate.ra, SPEC, { suffix: 'w6' })]));
                await gate.associate();
                await test.step('Revoke → pending_approval; reject → issued again', async () => {
                    expect((await revokeOwnCertificate(api, a, gate.ra, { reason: 'unspecified' })).status).toBe(204);
                    await waitForCertificateState(api, a.uuid, 'pending_approval', 60_000);
                    const approval = await findApproval(api, a, SPEC, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'reject')).status).toBe(204);
                    await waitForCertificateState(api, a.uuid, 'issued', 60_000);
                    // APPROVAL_CLOSE / SUCCESS, then the restore is audited as REVOKE / FAILED.
                    await expectWalk(api, a.uuid, 'issued', [['ISSUE', 'SUCCESS'], ['APPROVAL_REQUEST', 'SUCCESS'], ['APPROVAL_CLOSE', 'SUCCESS'], ['REVOKE', 'FAILED']]);
                    expect(historyMessages(await historyOf(api, a.uuid))).toContainEqual(expect.stringContaining('Revocation approval was rejected; certificate restored to Issued.'));
                });
                await test.step('Revoke → pending_approval; approve → revoked', async () => {
                    expect((await revokeOwnCertificate(api, b, gate.ra, { reason: 'unspecified' })).status).toBe(204);
                    await waitForCertificateState(api, b.uuid, 'pending_approval', 60_000);
                    const approval = await findApproval(api, b, SPEC, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'approve')).status).toBe(204);
                    await waitForCertificateState(api, b.uuid, 'revoked', 120_000);
                    await expectWalk(api, b.uuid, 'revoked', [['ISSUE', 'SUCCESS'], ['APPROVAL_REQUEST', 'SUCCESS'], ['REVOKE', 'SUCCESS']]);
                });
            } finally {
                await gate.release();
            }
        });

    test('registering then completing a certificate audits the update and the issue',
        testMeta({ id: 'API-CERT-34', row: 'T-7,T-8', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(300_000);
            const ra = ownRaProfile;
            const reg = await registerOwnCertificate(api, ra, SPEC, { suffix: 'w7', secret: newChallenge() });
            expect(reg.answer.status, reg.answer.text.slice(0, 300)).toBe(200);
            await waitForCertificateState(api, reg.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
            await expectWalk(api, reg.cert!.uuid, 'registered', [['UPDATE_STATE', 'SUCCESS']]);
            const a = await issueExisting(api, reg.cert!, ra, { request: csrFromKey(newKeyPair(), reg.cn).derBase64, authorizationSecret: reg.secret });
            expect(a.status, a.text.slice(0, 300)).toBe(200);
            await waitForCertificateState(api, reg.cert!.uuid, 'issued', 180_000);
            await recordDerivedKeyOf(api, reg.cert!.uuid, reg.createdAfter, SPEC);
            await expectWalk(api, reg.cert!.uuid, 'issued', [['UPDATE_STATE', 'SUCCESS'], ['ISSUE', 'SUCCESS']]);
        });

    test('an approved or rejected completion audits its approval',
        testMeta({ id: 'API-CERT-34', row: 'T-9,T-10', prio: 'P1', issue: 'ilm#429', rule: [...RULES, 'a rejected completion restores REGISTERED, authorization ACTIVE; ilm#284'] }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            // ownRaProfile: requested for its skip without a CA
            const defaults = await registrationDefaults(api);
            test.skip(defaults.maxFailedAttempts < 1 || defaults.defaultIssuanceWindowDays < 1, `registration settings on this tier (maxFailedAttempts ${defaults.maxFailedAttempts}, window ${defaults.defaultIssuanceWindowDays} days) cannot hold a challenge-protected registration`);
            const gate = await openApprovalGate(api, SPEC, 'g34c');
            try {
                const reg = await registerOwnCertificate(api, gate.ra, SPEC, { suffix: 'w9', secret: newChallenge() });
                expect(reg.answer.status, reg.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, reg.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                const csr = csrFromKey(newKeyPair(), reg.cn);
                await test.step('Complete → pending_approval; reject → registered, authorization ACTIVE', async () => {
                    const a = await issueExisting(api, reg.cert!, gate.ra, { request: csr.derBase64, authorizationSecret: reg.secret });
                    expect(a.status, a.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, reg.cert!.uuid, 'pending_approval', 60_000);
                    const approval = await findApproval(api, reg.cert!, SPEC, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'reject')).status).toBe(204);
                    await waitForCertificateState(api, reg.cert!.uuid, 'registered', 60_000, { failOn: ['failed', 'rejected', 'issued'] });
                    await expectWalk(api, reg.cert!.uuid, 'registered', [['UPDATE_STATE', 'SUCCESS'], ['APPROVAL_REQUEST', 'SUCCESS'], ['APPROVAL_CLOSE', 'FAILED']]);
                    expect((await getCertificate(api, reg.cert!.uuid)).registration?.state).toBe('active');
                });
                await test.step('Complete again → pending_approval; approve → issued', async () => {
                    const a = await issueExisting(api, reg.cert!, gate.ra, { request: csr.derBase64, authorizationSecret: reg.secret });
                    expect(a.status, a.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, reg.cert!.uuid, 'pending_approval', 60_000);
                    const approval = await findApproval(api, reg.cert!, SPEC, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'approve')).status).toBe(204);
                    await waitForCertificateState(api, reg.cert!.uuid, 'issued', 180_000);
                    await recordDerivedKeyOf(api, reg.cert!.uuid, reg.createdAfter, SPEC);
                    await expectWalk(api, reg.cert!.uuid, 'issued', [['APPROVAL_REQUEST', 'SUCCESS'], ['APPROVAL_CLOSE', 'SUCCESS'], ['ISSUE', 'SUCCESS']]);
                });
            } finally {
                await gate.release();
            }
        });
});
