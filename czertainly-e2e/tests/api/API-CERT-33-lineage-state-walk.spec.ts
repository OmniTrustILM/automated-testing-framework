/**
 * API-CERT-34 — the audit trail per legal transition (cert-lifecycle rules §7.3, the 25-row CertificateStateTransition
 * table; §7.7 walk rows; core#1599): the 0-switch walks T-1…T-10 of the area plan §2.3 / §2.4. Oracle per walk: the final
 * state and the history event / status rows of each transition, in order; presence and order only, never counts
 * (§10 C13); no 5xx anywhere.
 *
 * T-1 / T-2 on the run RA profile; T-3…T-6 through an own RA+ clone with the run approval profile (associated only
 * while the walk needs it, released at the end). T-7…T-10 start with a platform-level register: that route needs the
 * guard's create list (guard request, API-CERT-21) and the four walks are declared `test.fixme` with their full bodies.
 */
import { expect, test } from '../../fixtures/testFixtures';
import {
    approvalClosedText, createdAfterOf, decideApproval, findApproval, HistoryStep, historyMessages, historyOf, historyOrderProblem, issueExisting, issueOwnCertificate,
    newChallenge, newKeyPair, openApprovalGate, registerOwn, registrationDefaults, revokeOwn, submitOwnCertificate,
} from '../../utils/regression/lifecycle';
import { csrFromKey } from '../../utils/regression/pki';
import { ensureRaProfileOrSkip, getCertificate, recordDerivedKeyOf } from '../../utils/regression/regressionApi';
import { meta, tags } from '../../utils/regression/tags';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'API-CERT-34';

const RULES = [
    'cert-lifecycle §7.3 (the 25 legal transitions and their audit event / status: ISSUE, APPROVAL_REQUEST, APPROVAL_CLOSE, REVOKE, UPDATE_STATE with SUCCESS / FAILED)',
    'cert-lifecycle §7.7 (walk rows), §10 C13 (approval history rows: presence and text, never counts), core#1599 / core#1605 (the state machine)',
];

/** The walk's history carries the expected rows in order (collapsed: a row the machine audits twice counts once). */
async function expectWalk(api: Parameters<typeof historyOf>[0], uuid: string, finalState: string, expected: readonly HistoryStep[]): Promise<void> {
    expect((await getCertificate(api, uuid)).state, 'final state').toBe(finalState);
    const rows = await historyOf(api, uuid);
    expect(historyOrderProblem(rows, expected), `history rows in order: ${rows.map((r) => `${r.event}/${r.status}`).join(', ')}`).toBeUndefined();
}

test.describe('API-CERT-33 lineage and state walk', { tag: tags.api }, () => {
    test('API-CERT-34[T-1]: requested → pending_issue → issued audits ISSUE SUCCESS',
        meta({ id: 'API-CERT-34', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api }) => {
            test.setTimeout(240_000);
            const ra = await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const cert = await issueOwnCertificate(api, ra, SPEC, { suffix: 'w1' });
            await expectWalk(api, cert.uuid, 'issued', [['ISSUE', 'SUCCESS']]);
        });

    test('API-CERT-34[T-2]: issued → revoked audits ISSUE SUCCESS then REVOKE SUCCESS',
        meta({ id: 'API-CERT-34', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api }) => {
            test.setTimeout(420_000);
            const ra = await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const cert = await issueOwnCertificate(api, ra, SPEC, { suffix: 'w2' });
            const a = await revokeOwn(api, cert, ra, { reason: 'unspecified' });
            expect(a.status, a.text.slice(0, 200)).toBe(204);
            await waitForCertificateState(api, cert.uuid, 'revoked', 120_000);
            await expectWalk(api, cert.uuid, 'revoked', [['ISSUE', 'SUCCESS'], ['REVOKE', 'SUCCESS']]);
        });

    test('API-CERT-34[T-3,T-4]: requested → pending_approval → pending_issue → issued (approved) and → rejected (rejected) audit APPROVAL_REQUEST, APPROVAL_CLOSE SUCCESS / FAILED',
        meta({ id: 'API-CERT-34', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api }) => {
            test.setTimeout(480_000);
            await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const gate = await openApprovalGate(api, SPEC, 'g34a');
            try {
                await test.step('T-3: approved issue', async () => {
                    const cert = await submitOwnCertificate(api, gate.ra, SPEC, { suffix: 'w3' });
                    expect(cert.answer.status, cert.answer.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, cert.uuid, 'pending_approval', 60_000);
                    const approval = await findApproval(api, cert, SPEC, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'approve')).status).toBe(204);
                    await waitForCertificateState(api, cert.uuid, 'issued', 180_000);
                    await recordDerivedKeyOf(api, cert.uuid, createdAfterOf(cert.answer), SPEC);
                    await expectWalk(api, cert.uuid, 'issued', [['APPROVAL_REQUEST', 'SUCCESS'], ['APPROVAL_CLOSE', 'SUCCESS'], ['ISSUE', 'SUCCESS']]);
                    expect(historyMessages(await historyOf(api, cert.uuid))).toContainEqual(expect.stringContaining(approvalClosedText('issue', gate.approvalProfile.name, 'Approved')));
                });
                await test.step('T-4: rejected issue', async () => {
                    const cert = await submitOwnCertificate(api, gate.ra, SPEC, { suffix: 'w4' });
                    expect(cert.answer.status, cert.answer.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, cert.uuid, 'pending_approval', 60_000);
                    const approval = await findApproval(api, cert, SPEC, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'reject')).status).toBe(204);
                    await waitForCertificateState(api, cert.uuid, 'rejected', 60_000, { failOn: ['failed', 'issued'] });
                    // Rules §7.3 (corrected 2026-10-15): the approval close is SUCCESS, the state machine then audits the
                    // rejection as UPDATE_STATE / FAILED "Certificate state changed from Pending approval to Rejected." (core
                    // handleFailedOrRejectedEvent).
                    await expectWalk(api, cert.uuid, 'rejected', [['APPROVAL_REQUEST', 'SUCCESS'], ['APPROVAL_CLOSE', 'SUCCESS'], ['UPDATE_STATE', 'FAILED']]);
                    expect(historyMessages(await historyOf(api, cert.uuid))).toContainEqual(expect.stringContaining('Certificate state changed from Pending approval to Rejected.'));
                });
            } finally {
                await gate.release();
            }
        });

    test('API-CERT-34[T-5,T-6]: issued → pending_approval → issued (revoke rejected) and → revoked (revoke approved) audit APPROVAL_REQUEST, then APPROVAL_CLOSE FAILED or REVOKE SUCCESS',
        meta({ id: 'API-CERT-34', prio: 'P1', issue: 'ilm#429', rule: [...RULES, 'cert-lifecycle §4.2 RV-7 (reject restores ISSUED; core#1553)'] }),
        async ({ api }) => {
            test.setTimeout(600_000);
            await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            // The certificates are issued on the clone BEFORE the approval profile is associated (an ungated issue), so the
            // revoke is the first gated operation (rows 17, 12, 11).
            const gate = await openApprovalGate(api, SPEC, 'g34r', { associate: false });
            try {
                const [a, b] = await test.step('Fixture: two own certificates issued on the (not yet gated) clone', async () =>
                    Promise.all([issueOwnCertificate(api, gate.ra, SPEC, { suffix: 'w5' }), issueOwnCertificate(api, gate.ra, SPEC, { suffix: 'w6' })]));
                await gate.associate();
                await test.step('T-5: revoke → pending_approval; reject → issued again', async () => {
                    expect((await revokeOwn(api, a, gate.ra, { reason: 'unspecified' })).status).toBe(204);
                    await waitForCertificateState(api, a.uuid, 'pending_approval', 60_000);
                    const approval = await findApproval(api, a, SPEC, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'reject')).status).toBe(204);
                    await waitForCertificateState(api, a.uuid, 'issued', 60_000);
                    // Rules §7.3 (corrected 2026-10-15): APPROVAL_CLOSE / SUCCESS, then the restore is audited as REVOKE / FAILED.
                    await expectWalk(api, a.uuid, 'issued', [['ISSUE', 'SUCCESS'], ['APPROVAL_REQUEST', 'SUCCESS'], ['APPROVAL_CLOSE', 'SUCCESS'], ['REVOKE', 'FAILED']]);
                    expect(historyMessages(await historyOf(api, a.uuid))).toContainEqual(expect.stringContaining('Revocation approval was rejected; certificate restored to Issued.'));
                });
                await test.step('T-6: revoke → pending_approval; approve → revoked', async () => {
                    expect((await revokeOwn(api, b, gate.ra, { reason: 'unspecified' })).status).toBe(204);
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

    test(`API-CERT-34[T-7,T-8]: requested → pending_registration → registered (UPDATE_STATE SUCCESS) and registered → pending_issue → issued (ISSUE SUCCESS)`,
        meta({ id: 'API-CERT-34', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api }) => {
            test.setTimeout(300_000);
            const ra = await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const reg = await registerOwn(api, ra, SPEC, { suffix: 'w7', secret: newChallenge() });
            expect(reg.answer.status, reg.answer.text.slice(0, 300)).toBe(200);
            await waitForCertificateState(api, reg.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
            await expectWalk(api, reg.cert!.uuid, 'registered', [['UPDATE_STATE', 'SUCCESS']]);
            const a = await issueExisting(api, reg.cert!, ra, { request: csrFromKey(newKeyPair(), reg.cn).derBase64, authorizationSecret: reg.secret });
            expect(a.status, a.text.slice(0, 300)).toBe(200);
            await waitForCertificateState(api, reg.cert!.uuid, 'issued', 180_000);
            await recordDerivedKeyOf(api, reg.cert!.uuid, reg.createdAfter, SPEC);
            await expectWalk(api, reg.cert!.uuid, 'issued', [['UPDATE_STATE', 'SUCCESS'], ['ISSUE', 'SUCCESS']]);
        });

    test(`API-CERT-34[T-9,T-10]: registered → pending_approval → registered (completion rejected) and → pending_issue → issued (completion approved)`,
        meta({ id: 'API-CERT-34', prio: 'P1', issue: 'ilm#429', rule: [...RULES, 'cert-lifecycle §5.2 AP-8 / §6.2 PR-8 (a rejected completion restores REGISTERED, authorization ACTIVE; ilm#284)'] }),
        async ({ api }) => {
            test.setTimeout(480_000);
            await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const defaults = await registrationDefaults(api);
            test.skip(defaults.maxFailedAttempts < 1 || defaults.defaultIssuanceWindowDays < 1, `registration settings on this tier (maxFailedAttempts ${defaults.maxFailedAttempts}, window ${defaults.defaultIssuanceWindowDays} days) cannot hold a challenge-protected registration`);
            const gate = await openApprovalGate(api, SPEC, 'g34c');
            try {
                const reg = await registerOwn(api, gate.ra, SPEC, { suffix: 'w9', secret: newChallenge() });
                expect(reg.answer.status, reg.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, reg.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                const csr = csrFromKey(newKeyPair(), reg.cn);
                await test.step('T-9: complete → pending_approval; reject → registered, authorization ACTIVE', async () => {
                    const a = await issueExisting(api, reg.cert!, gate.ra, { request: csr.derBase64, authorizationSecret: reg.secret });
                    expect(a.status, a.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, reg.cert!.uuid, 'pending_approval', 60_000);
                    const approval = await findApproval(api, reg.cert!, SPEC, { status: 'Pending' });
                    expect((await decideApproval(api, approval, 'reject')).status).toBe(204);
                    await waitForCertificateState(api, reg.cert!.uuid, 'registered', 60_000, { failOn: ['failed', 'rejected', 'issued'] });
                    await expectWalk(api, reg.cert!.uuid, 'registered', [['UPDATE_STATE', 'SUCCESS'], ['APPROVAL_REQUEST', 'SUCCESS'], ['APPROVAL_CLOSE', 'FAILED']]);
                    expect((await getCertificate(api, reg.cert!.uuid)).registration?.state).toBe('active');
                });
                await test.step('T-10: complete again → pending_approval; approve → issued', async () => {
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
