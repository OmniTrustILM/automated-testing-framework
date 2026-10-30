/**
 * API-CERT-08 — The state and operation refusal matrix of an own certificate (ilm#429).
 *
 * A ValidationException is a 422, never a 400 or 5xx. Each test builds and ledgers its own certificate before any
 * assertion. Gated states use an own RA profile clone with the approval profile, released in `finally`.
 * The failed state needs EJBCA NG; it skips elsewhere.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { ApprovalGate, decideApproval, findApproval, openApprovalGate } from '../../../utils/regression/lifecycle/approvals';
import { historyMessages, historyOf, relationsOf } from '../../../utils/regression/lifecycle/certificateHistory';
import { STATE_LABELS, stateGuardText } from '../../../utils/regression/lifecycle/certificateLabels';
import { cancelPending, confirmRevoke, finalizeIssue, issueExisting, rekeyOwnCertificate, renewOwnCertificate, revokeOwnCertificate } from '../../../utils/regression/lifecycle/certificateOperations';
import { newChallenge, registerOwnCertificate } from '../../../utils/regression/lifecycle/preRegistration';
import { expectRefused } from '../../../utils/regression/errorContract';
import { csrWithEmailSan, newKeyPair, csrFromKey } from '../../../utils/regression/pkiBuilders';
import { submitOwnCertificate, waitRevoked } from '../../../utils/regression/ownCertificates';
import type { RaLike } from '../../../utils/regression/ownRaProfiles';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import { getCertificate, ApiAnswer } from '../../../utils/regression/apiReads';
import { OwnRef } from '../../../utils/regression/ledger/ledger';
import { ownCommonName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { ISSUED_WAIT_MS, ISSUE_MS, LEFTOVER_APPROVAL_LOOKUP_MS, LIFECYCLE_MS, MANY_STEPS_TEST_MS, QUICK_STATE_WAIT_MS, STATE_CHANGE_WAIT_MS } from '../../../utils/regression/timeouts';
import { waitForCertificateState } from '../../../utils/regression/wait/certificateState';

/**
 * The matrix on one fixture: every operation refused with its text, body a one-element string array, never 5xx; the
 * state, the history messages and the successor count are the same before and after.
 */
async function assertMatrix(api: GuardedApi, spec: string, cert: OwnRef & { name: string }, ra: RaLike, state: string): Promise<void> {
    const label = STATE_LABELS[state];
    const before = await getCertificate(api, cert.uuid);
    expect(before.state, 'fixture state').toBe(state);
    const history = historyMessages(await historyOf(api, cert.uuid));
    const successors = (await relationsOf(api, cert.uuid)).successors.length;
    // The state check precedes every CSR check, so any key serves.
    const csr = csrFromKey(newKeyPair(), cert.name);

    // Every refusal is a 422 with exactly one message that STARTS with the text (the rest names the certificate).

    await test.step(`renew / rekey / revoke on ${label} → 422 "Cannot perform operation <op> on certificate in state ${label}."`, async () => {
        expectRefused(await renewOwnCertificate(api, cert, ra, spec, { csrDerBase64: csr.derBase64 }), { status: 422, text: stateGuardText('renew', state), prefix: true, what: 'renew' });
        expectRefused(await rekeyOwnCertificate(api, cert, ra, spec, { csrDerBase64: csr.derBase64 }), { status: 422, text: stateGuardText('rekey', state), prefix: true, what: 'rekey' });
        // An already revoked certificate is refused with its own text before the generic state check.
        expectRefused(await revokeOwnCertificate(api, cert, ra, { reason: 'unspecified' }), { status: 422, text: state === 'revoked' ? 'Certificate is already revoked. Certificate: ' : stateGuardText('revoke', state), prefix: true, what: 'revoke' });
    });

    await test.step(`issue-existing on ${label} → 422`, async () => {
        const a = await issueExisting(api, cert, ra, state === 'registered' ? {} : { request: csr.derBase64 });
        expectRefused(a, { status: 422, text: state === 'registered' ? 'A certificate signing request is required to issue a registered certificate. Certificate: ' : `Cannot issue certificate with state ${label}. Certificate: `, prefix: true, what: 'issue-existing' });
    });

    await test.step(`confirm revoke, cancel, finalize on ${label} → 422 naming the current state`, async () => {
        expectRefused(await confirmRevoke(api, cert, ra), { status: 422, text: `Cannot confirm revocation: certificate is not in PENDING_REVOKE. Current state: ${label}. Certificate: `, prefix: true, what: 'confirm revoke' });
        expectRefused(await cancelPending(api, cert, ra), { status: 422, text: `Cannot cancel: certificate is not in a pending state. Current state: ${label}. Certificate: `, prefix: true, what: 'cancel' });
        expectRefused(await finalizeIssue(api, cert, ra), { status: 422, text: `Cannot finalize issuance: certificate is not in PENDING_ISSUE. Current state: ${label}. Certificate: `, prefix: true, what: 'finalize' });
    });

    await test.step('Nothing changed: state, history and successor count', async () => {
        const after = await getCertificate(api, cert.uuid);
        expect(after.state).toBe(state);
        expect(historyMessages(await historyOf(api, cert.uuid))).toEqual(history);
        expect((await relationsOf(api, cert.uuid)).successors.length).toBe(successors);
    });
}

const RULES = [
    'renew / rekey / revoke only from ISSUED ("Cannot perform operation <op> on certificate in state <label>. Certificate: …"); an already revoked certificate is refused',
    'issue-existing ("Cannot issue certificate with state <label>", a registered certificate needs the operator\'s CSR)',
    'finalize only from PENDING_ISSUE, confirm only from PENDING_REVOKE, cancel only from a pending state; no other state / operation pair is legal',
    'a ValidationException is a 422 JSON string array, never 400 or 500',
];

test.describe('Certificate state and operation refusal matrix', { tag: tags.api }, () => {
    test('every operation on a certificate pending approval is refused',
        testMeta({ id: 'API-CERT-08', row: 'pending_approval', prio: 'P1', issue: 'ilm#429', needs: 'ca', rule: RULES }),
        async ({ api, own }) => {
            test.setTimeout(ISSUE_MS);
            const gate: ApprovalGate = await openApprovalGate(api, own.spec, 'g08pa');
            let cert: OwnRef & { name: string } | undefined;
            try {
                cert = await test.step('Fixture: an issue on the gated RA profile clone that waits for its approval', async () => {
                    const c = await submitOwnCertificate(api, gate.ra, own.spec, { suffix: 'c08pa', note: 'API-CERT-08 pending_approval fixture' });
                    expect(c.answer.status, c.answer.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, c.uuid, 'pending_approval', STATE_CHANGE_WAIT_MS);
                    return c;
                });
                await assertMatrix(api, own.spec, cert, gate.ra, 'pending_approval');
            } finally {
                // Decide the leftover (the own approval is rejected through the override path), then ungate the clone.
                if (cert) {
                    const approval = await findApproval(api, cert, own.spec, { timeoutMs: LEFTOVER_APPROVAL_LOOKUP_MS }).catch(() => undefined);
                    if (approval) await decideApproval(api, approval, 'reject').catch(() => undefined);
                }
                await gate.release();
            }
        });

    test('every operation on a rejected certificate is refused',
        testMeta({ id: 'API-CERT-08', row: 'rejected', prio: 'P1', issue: 'ilm#429', needs: 'ca', rule: RULES }),
        async ({ api, own }) => {
            test.setTimeout(ISSUE_MS);
            const gate = await openApprovalGate(api, own.spec, 'g08rj');
            let cert: OwnRef & { name: string };
            try {
                cert = await test.step('Fixture: an issue under the gate, rejected through the override path → rejected', async () => {
                    const c = await submitOwnCertificate(api, gate.ra, own.spec, { suffix: 'c08rj', note: 'API-CERT-08 rejected fixture' });
                    expect(c.answer.status, c.answer.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, c.uuid, 'pending_approval', STATE_CHANGE_WAIT_MS);
                    const approval = await findApproval(api, c, own.spec);
                    const d = await decideApproval(api, approval, 'reject');
                    expect(d.status, d.text.slice(0, 200)).toBe(204);
                    await waitForCertificateState(api, c.uuid, 'rejected', STATE_CHANGE_WAIT_MS, { failOn: ['failed', 'issued'] });
                    return c;
                });
            } finally {
                await gate.release();
            }
            await assertMatrix(api, own.spec, cert, gate.ra, 'rejected');
        });

    test('every operation on a revoked certificate is refused',
        testMeta({ id: 'API-CERT-08', row: 'revoked', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api, own, ownRaProfile }) => {
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            const cert = await test.step('Fixture: an own issued certificate, revoked', async () => {
                const c = await own.certificate.issue(ra, { suffix: 'c08rv' });
                const a = await revokeOwnCertificate(api, c, ra, { reason: 'superseded' });
                expect(a.status, a.text.slice(0, 200)).toBe(204);
                await waitRevoked(api, c.uuid);
                return c;
            });
            await assertMatrix(api, own.spec, cert, ra, 'revoked');
        });

    test('every operation on a failed certificate is refused',
        testMeta({ id: 'API-CERT-08', row: 'failed', prio: 'P1', issue: 'ilm#429', needs: 'ejbca-ng', rule: [...RULES, 'EJBCA-NG end-entity profile refuses an e-mail SAN: the only shared-tier producer of failed'] }),
        async ({ api, own, ownRaProfile }) => {
            test.setTimeout(ISSUE_MS);
            const ra = ownRaProfile;
            const cert = await test.step('Fixture: an issue with an e-mail SAN the end-entity profile refuses → failed', async () => {
                const cn = ownCommonName('c08fl');
                const csr = csrWithEmailSan(cn, `qa@${cn}`);
                const c = await submitOwnCertificate(api, ra, own.spec, { suffix: 'c08fl', body: { request: csr.derBase64 }, note: 'API-CERT-08 failed fixture (e-mail SAN)' });
                expect(c.answer.status, c.answer.text.slice(0, 300)).toBe(200);
                try {
                    await waitForCertificateState(api, c.uuid, 'failed', ISSUED_WAIT_MS, { failOn: ['issued', 'rejected'] });
                } catch (e) {
                    const state = (await getCertificate(api, c.uuid)).state;
                    // Not decidable before the issue: only the CA's answer to the e-mail SAN says whether the fixture ends `failed` or
                    // `issued`.
                    test.skip(state === 'issued', 'the CA accepted the e-mail SAN: no failed fixture on this tier (end-entity profile configuration)');
                    throw e;
                }
                return c;
            });
            await assertMatrix(api, own.spec, cert, ra, 'failed');
        });

    test('every operation on a registered certificate is refused',
        testMeta({ id: 'API-CERT-08', row: 'registered', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api, own, ownRaProfile }) => {
            test.setTimeout(MANY_STEPS_TEST_MS);
            const ra = ownRaProfile;
            const cert = await test.step('Fixture: a platform-level pre-registration with a challenge → registered (ACTIVE)', async () => {
                const r = await registerOwnCertificate(api, ra, own.spec, { suffix: 'c08rg', secret: newChallenge(), note: 'API-CERT-08 registered fixture' });
                expect(r.answer.status, r.answer.text.slice(0, 300)).toBe(200);
                expect(r.cert?.uuid, 'the answer names the placeholder').toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
                await waitForCertificateState(api, r.cert!.uuid, 'registered', QUICK_STATE_WAIT_MS);
                return r.cert!;
            });
            await assertMatrix(api, own.spec, cert, ra, 'registered');
        });
});
