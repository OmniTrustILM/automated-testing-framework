/**
 * API-CERT-34 — The audit trail of each legal certificate state transition. ilm#429.
 *
 * WHAT: 1. Issue → final state issued; history ISSUE SUCCESS.
 *       2. Revoke an issued certificate → revoked; history ISSUE then REVOKE SUCCESS.
 *       3. Issue under an approval profile, approved or rejected → history APPROVAL_REQUEST, APPROVAL_CLOSE and ISSUE (approved) or
 *          UPDATE_STATE FAILED "Certificate state changed from Pending approval to Rejected." (rejected).
 *       4. Revoke under an approval profile: reject → issued again ("Revocation approval was rejected; certificate restored to Issued."),
 *          approve → revoked.
 *       5. Register then complete → history UPDATE_STATE SUCCESS then ISSUE SUCCESS.
 *       6. Complete under an approval profile: reject → registered with the authorization still active, approve → issued.
 * WHY: each of the 25 legal transitions of the certificate state machine writes an audit event with a status (core#1599, core#1605); a
 *      rejected revoke restores issued (core#1553) and a rejected completion restores registered (ilm#284). Presence and order only,
 *      never counts, and no 5xx anywhere. A red test means a transition was not audited or was audited in the wrong order.
 * HOW: all certificates are own objects recorded in the ledger before the assertions. The approval walks run on an own RA profile clone
 *      that is gated only while needed and released at the end; the revoke walks issue on the clone before the approval profile is
 *      associated. Rows written by independent asynchronous paths are asserted present, not in a fixed order. The registration walks
 *      skip when the tier's registration settings cannot hold a challenge-protected registration, and use a register call without a
 *      path that the guard does not list yet.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { decideApproval, findApproval, openApprovalGate } from '../../../utils/regression/lifecycle/approvals';
import { EVENT_CODES, historyMessages, historyOf, historyOrderProblem, HistoryStep } from '../../../utils/regression/lifecycle/certificateHistory';
import { approvalClosedText } from '../../../utils/regression/lifecycle/certificateLabels';
import { issueExisting, revokeOwnCertificate } from '../../../utils/regression/lifecycle/certificateOperations';
import { newChallenge, registerOwnCertificate, registrationDefaults } from '../../../utils/regression/lifecycle/preRegistration';
import { createdAfterOfAnswer } from '../../../utils/regression/lifecycle/rawAnswers';
import { submitOwnCertificate, waitIssued, waitRevoked } from '../../../utils/regression/ownCertificates';
import { newKeyPair, csrFromKey } from '../../../utils/regression/pkiBuilders';
import { getCertificate } from '../../../utils/regression/apiReads';
import { recordDerivedKeyOf } from '../../../utils/regression/issuedRecords';
import { testMeta, tags } from '../../../utils/regression/tags';
import { APPROVAL_REVOKE_TEST_MS, ISSUE_MS, LIFECYCLE_MS, LONG_TEST_MS, QUICK_STATE_WAIT_MS, SLOW_LIFECYCLE_MS, STATE_CHANGE_WAIT_MS } from '../../../utils/regression/timeouts';
import { waitForCertificateState } from '../../../utils/regression/wait/certificateState';

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

/** The walk's history carries every expected row, in any order (for rows that independent asynchronous paths write). */
async function expectWalkRows(api: Parameters<typeof historyOf>[0], uuid: string, finalState: string, expected: readonly HistoryStep[]): Promise<void> {
    expect((await getCertificate(api, uuid)).state, 'final state').toBe(finalState);
    const seen = (await historyOf(api, uuid)).map((r) => `${String(r.event)}/${String(r.status)}`);
    const missing = expected.map(([event, status]) => `${EVENT_CODES[event]}/${status}`).filter((want) => !seen.includes(want));
    expect(missing, `history rows present: ${seen.join(', ')}`).toEqual([]);
}

test.describe('Certificate state transition audit trail', { tag: tags.api }, () => {
    test('issuing a certificate audits ISSUE SUCCESS',
        testMeta({ id: 'API-CERT-34', row: 'issue', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api, own, ownRaProfile }) => {
            test.setTimeout(ISSUE_MS);
            const ra = ownRaProfile;
            const cert = await own.certificate.issue(ra, { suffix: 'w1' });
            await expectWalk(api, cert.uuid, 'issued', [['ISSUE', 'SUCCESS']]);
        });

    test('revoking an issued certificate audits ISSUE SUCCESS then REVOKE SUCCESS',
        testMeta({ id: 'API-CERT-34', row: 'revoke', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api, own, ownRaProfile }) => {
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            const cert = await own.certificate.issue(ra, { suffix: 'w2' });
            const a = await revokeOwnCertificate(api, cert, ra, { reason: 'unspecified' });
            expect(a.status, a.text.slice(0, 200)).toBe(204);
            await waitRevoked(api, cert.uuid);
            await expectWalk(api, cert.uuid, 'revoked', [['ISSUE', 'SUCCESS'], ['REVOKE', 'SUCCESS']]);
        });

    test('an approved or rejected issue audits the approval request and its close',
        testMeta({ id: 'API-CERT-34', row: 'approved-and-rejected-issue', prio: 'P1', issue: 'ilm#429', needs: 'ca', rule: RULES }),
        async ({ api, own }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const gate = await openApprovalGate(api, own.spec, 'g34a');
            try {
                await test.step('Approved issue', async () => {
                    const cert = await submitOwnCertificate(api, gate.ra, own.spec, { suffix: 'w3' });
                    expect(cert.answer.status, cert.answer.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, cert.uuid, 'pending_approval', STATE_CHANGE_WAIT_MS);
                    const approval = await findApproval(api, cert, own.spec, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'approve')).status).toBe(204);
                    await waitIssued(api, cert.uuid);
                    await recordDerivedKeyOf(api, cert.uuid, createdAfterOfAnswer(cert.answer), own.spec);
                    await expectWalk(api, cert.uuid, 'issued', [['APPROVAL_REQUEST', 'SUCCESS'], ['APPROVAL_CLOSE', 'SUCCESS'], ['ISSUE', 'SUCCESS']]);
                    expect(historyMessages(await historyOf(api, cert.uuid))).toContainEqual(expect.stringContaining(approvalClosedText('issue', gate.approvalProfile.name, 'Approved')));
                });
                await test.step('Rejected issue', async () => {
                    const cert = await submitOwnCertificate(api, gate.ra, own.spec, { suffix: 'w4' });
                    expect(cert.answer.status, cert.answer.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, cert.uuid, 'pending_approval', STATE_CHANGE_WAIT_MS);
                    const approval = await findApproval(api, cert, own.spec, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'reject')).status).toBe(204);
                    await waitForCertificateState(api, cert.uuid, 'rejected', STATE_CHANGE_WAIT_MS, { failOn: ['failed', 'issued'] });
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
        testMeta({ id: 'API-CERT-34', row: 'approved-and-rejected-revoke', prio: 'P1', issue: 'ilm#429', needs: 'ca', rule: [...RULES, 'reject restores ISSUED; core#1553'] }),
        async ({ api, own }) => {
            test.setTimeout(APPROVAL_REVOKE_TEST_MS);
            // The certificates are issued on the clone BEFORE the approval profile is associated (an ungated issue), so the
            // revoke is the first gated operation.
            const gate = await openApprovalGate(api, own.spec, 'g34r', { associate: false });
            try {
                const [a, b] = await test.step('Fixture: two own certificates issued on the (not yet gated) clone', async () =>
                    Promise.all([own.certificate.issue(gate.ra, { suffix: 'w5' }), own.certificate.issue(gate.ra, { suffix: 'w6' })]));
                await gate.associate();
                await test.step('Revoke → pending_approval; reject → issued again', async () => {
                    expect((await revokeOwnCertificate(api, a, gate.ra, { reason: 'unspecified' })).status).toBe(204);
                    await waitForCertificateState(api, a.uuid, 'pending_approval', STATE_CHANGE_WAIT_MS);
                    const approval = await findApproval(api, a, own.spec, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'reject')).status).toBe(204);
                    await waitForCertificateState(api, a.uuid, 'issued', STATE_CHANGE_WAIT_MS);
                    // The restore (REVOKE / FAILED) and the approval close (APPROVAL_CLOSE / SUCCESS) come from independent
                    // asynchronous paths, so the two last rows are asserted present, not in a fixed order.
                    await expectWalkRows(api, a.uuid, 'issued', [['ISSUE', 'SUCCESS'], ['APPROVAL_REQUEST', 'SUCCESS'], ['APPROVAL_CLOSE', 'SUCCESS'], ['REVOKE', 'FAILED']]);
                    expect(historyMessages(await historyOf(api, a.uuid))).toContainEqual(expect.stringContaining('Revocation approval was rejected; certificate restored to Issued.'));
                });
                await test.step('Revoke → pending_approval; approve → revoked', async () => {
                    expect((await revokeOwnCertificate(api, b, gate.ra, { reason: 'unspecified' })).status).toBe(204);
                    await waitForCertificateState(api, b.uuid, 'pending_approval', STATE_CHANGE_WAIT_MS);
                    const approval = await findApproval(api, b, own.spec, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'approve')).status).toBe(204);
                    await waitRevoked(api, b.uuid);
                    await expectWalk(api, b.uuid, 'revoked', [['ISSUE', 'SUCCESS'], ['APPROVAL_REQUEST', 'SUCCESS'], ['REVOKE', 'SUCCESS']]);
                });
            } finally {
                await gate.release();
            }
        });

    test('registering then completing a certificate audits the update and the issue',
        testMeta({ id: 'API-CERT-34', row: 'register-then-complete', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api, own, ownRaProfile }) => {
            test.setTimeout(LONG_TEST_MS);
            const ra = ownRaProfile;
            const reg = await registerOwnCertificate(api, ra, own.spec, { suffix: 'w7', secret: newChallenge() });
            expect(reg.answer.status, reg.answer.text.slice(0, 300)).toBe(200);
            await waitForCertificateState(api, reg.cert!.uuid, 'registered', QUICK_STATE_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
            await expectWalk(api, reg.cert!.uuid, 'registered', [['UPDATE_STATE', 'SUCCESS']]);
            const a = await issueExisting(api, reg.cert!, ra, { request: csrFromKey(newKeyPair(), reg.cn).derBase64, authorizationSecret: reg.secret });
            expect(a.status, a.text.slice(0, 300)).toBe(200);
            await waitIssued(api, reg.cert!.uuid);
            await recordDerivedKeyOf(api, reg.cert!.uuid, reg.createdAfter, own.spec);
            await expectWalk(api, reg.cert!.uuid, 'issued', [['UPDATE_STATE', 'SUCCESS'], ['ISSUE', 'SUCCESS']]);
        });

    test('an approved or rejected completion audits its approval',
        testMeta({ id: 'API-CERT-34', row: 'approved-and-rejected-completion', prio: 'P1', issue: 'ilm#429', needs: 'ca', rule: [...RULES, 'a rejected completion restores REGISTERED, authorization ACTIVE; ilm#284'] }),
        async ({ api, own }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const defaults = await registrationDefaults(api);
            test.skip(defaults.maxFailedAttempts < 1 || defaults.defaultIssuanceWindowDays < 1, `registration settings on this tier (maxFailedAttempts ${defaults.maxFailedAttempts}, window ${defaults.defaultIssuanceWindowDays} days) cannot hold a challenge-protected registration`);
            const gate = await openApprovalGate(api, own.spec, 'g34c');
            try {
                const reg = await registerOwnCertificate(api, gate.ra, own.spec, { suffix: 'w9', secret: newChallenge() });
                expect(reg.answer.status, reg.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, reg.cert!.uuid, 'registered', QUICK_STATE_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
                const csr = csrFromKey(newKeyPair(), reg.cn);
                await test.step('Complete → pending_approval; reject → registered, authorization ACTIVE', async () => {
                    const a = await issueExisting(api, reg.cert!, gate.ra, { request: csr.derBase64, authorizationSecret: reg.secret });
                    expect(a.status, a.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, reg.cert!.uuid, 'pending_approval', STATE_CHANGE_WAIT_MS);
                    const approval = await findApproval(api, reg.cert!, own.spec, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'reject')).status).toBe(204);
                    await waitForCertificateState(api, reg.cert!.uuid, 'registered', STATE_CHANGE_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
                    await expectWalk(api, reg.cert!.uuid, 'registered', [['UPDATE_STATE', 'SUCCESS'], ['APPROVAL_REQUEST', 'SUCCESS'], ['APPROVAL_CLOSE', 'FAILED']]);
                    expect((await getCertificate(api, reg.cert!.uuid)).registration?.state).toBe('active');
                });
                await test.step('Complete again → pending_approval; approve → issued', async () => {
                    const a = await issueExisting(api, reg.cert!, gate.ra, { request: csr.derBase64, authorizationSecret: reg.secret });
                    expect(a.status, a.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, reg.cert!.uuid, 'pending_approval', STATE_CHANGE_WAIT_MS);
                    const approval = await findApproval(api, reg.cert!, own.spec, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'approve')).status).toBe(204);
                    await waitIssued(api, reg.cert!.uuid);
                    await recordDerivedKeyOf(api, reg.cert!.uuid, reg.createdAfter, own.spec);
                    await expectWalk(api, reg.cert!.uuid, 'issued', [['APPROVAL_REQUEST', 'SUCCESS'], ['APPROVAL_CLOSE', 'SUCCESS'], ['ISSUE', 'SUCCESS']]);
                });
            } finally {
                await gate.release();
            }
        });
});
