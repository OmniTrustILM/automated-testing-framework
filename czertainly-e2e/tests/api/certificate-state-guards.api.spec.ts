/**
 * The state and operation refusal matrix: for an own certificate in each fixture state, every operation that is not a
 * legal transition (renew, rekey, revoke, issue-existing, confirm revoke, cancel, finalize) answers a 422 with the
 * quoted one-element string array and changes nothing, never a 5xx.
 * Shared-tier safety: each test builds its own certificate; gated clones are released at the end.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { ApprovalGate, decideApproval, findApproval, openApprovalGate } from '../../utils/regression/lifecycle/approvals';
import { historyMessages, historyOf, relationsOf } from '../../utils/regression/lifecycle/certificateHistory';
import { STATE_LABELS, stateGuardText } from '../../utils/regression/lifecycle/certificateLabels';
import { cancelPending, confirmRevoke, finalizeIssue, issueExisting, rekeyOwnCertificate, renewOwnCertificate, revokeOwnCertificate } from '../../utils/regression/lifecycle/certificateOperations';
import { newChallenge, registerOwnCertificate } from '../../utils/regression/lifecycle/preRegistration';
import { messagesOf, RawAnswer } from '../../utils/regression/lifecycle/rawAnswers';
import { csrWithEmailSan, newKeyPair, csrFromKey } from '../../utils/regression/pkiBuilders';
import { issueOwnCertificate, submitOwnCertificate } from '../../utils/regression/ownCertificates';
import type { RaLike } from '../../utils/regression/ownRaProfiles';
import type { GuardedApi } from '../../utils/regression/guard/types';
import { getCertificate } from '../../utils/regression/apiReads';
import { authorityConnectorName } from '../../utils/regression/config/authorities';
import { OwnRef } from '../../utils/regression/ledger/ledger';
import { runName } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';
import { ISSUE_MS, LIFECYCLE_MS } from '../../utils/regression/timeouts';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'API-CERT-08';

/**
 * The matrix on one fixture: every operation refused with its text, body a one-element string array, never 5xx; the
 * state, the history messages and the successor count are the same before and after.
 */
async function assertMatrix(api: GuardedApi, cert: OwnRef & { name: string }, ra: RaLike, state: string): Promise<void> {
    const label = STATE_LABELS[state];
    const before = await getCertificate(api, cert.uuid);
    expect(before.state, 'fixture state').toBe(state);
    const history = historyMessages(await historyOf(api, cert.uuid));
    const successors = (await relationsOf(api, cert.uuid)).successors.length;
    const csr = csrFromKey(csrKeys(), cert.name);

    const expectRefusal = (a: RawAnswer, what: string, text: string | RegExp) => {
        expect(a.status, `${what}: ${a.text.slice(0, 300)}`).toBe(422);
        const messages = messagesOf(a);
        expect(messages, `${what}: one message`).toHaveLength(1);
        if (typeof text === 'string') expect(messages[0], what).toMatch(new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        else expect(messages[0], what).toMatch(text);
    };

    await test.step(`renew / rekey / revoke on ${label} → 422 "Cannot perform operation <op> on certificate in state ${label}."`, async () => {
        expectRefusal(await renewOwnCertificate(api, cert, ra, SPEC, { csrDerBase64: csr.derBase64 }), 'renew', stateGuardText('renew', state));
        expectRefusal(await rekeyOwnCertificate(api, cert, ra, SPEC, { csrDerBase64: csr.derBase64 }), 'rekey', stateGuardText('rekey', state));
        // An already revoked certificate is refused with its own text before the generic state check.
        expectRefusal(await revokeOwnCertificate(api, cert, ra, { reason: 'unspecified' }), 'revoke', state === 'revoked' ? 'Certificate is already revoked. Certificate: ' : stateGuardText('revoke', state));
    });

    await test.step(`issue-existing on ${label} → 422`, async () => {
        const a = await issueExisting(api, cert, ra, state === 'registered' ? {} : { request: csr.derBase64 });
        expectRefusal(a, 'issue-existing', state === 'registered' ? 'A certificate signing request is required to issue a registered certificate. Certificate: ' : `Cannot issue certificate with state ${label}. Certificate: `);
    });

    await test.step(`confirm revoke, cancel, finalize on ${label} → 422 naming the current state`, async () => {
        expectRefusal(await confirmRevoke(api, cert, ra), 'confirm revoke', `Cannot confirm revocation: certificate is not in PENDING_REVOKE. Current state: ${label}. Certificate: `);
        expectRefusal(await cancelPending(api, cert, ra), 'cancel', `Cannot cancel: certificate is not in a pending state. Current state: ${label}. Certificate: `);
        expectRefusal(await finalizeIssue(api, cert, ra), 'finalize', `Cannot finalize issuance: certificate is not in PENDING_ISSUE. Current state: ${label}. Certificate: `);
    });

    await test.step('Nothing changed: state, history and successor count', async () => {
        const after = await getCertificate(api, cert.uuid);
        expect(after.state).toBe(state);
        expect(historyMessages(await historyOf(api, cert.uuid))).toEqual(history);
        expect((await relationsOf(api, cert.uuid)).successors.length).toBe(successors);
    });
}

/**
 * One key pair for the probe CSRs of the file: a read-only memo (the state check precedes every CSR check, so any key
 * serves and the test order does not matter).
 */
let cachedKeys: ReturnType<typeof newKeyPair> | undefined;
const csrKeys = (): ReturnType<typeof newKeyPair> => (cachedKeys ??= newKeyPair());

const RULES = [
    'renew / rekey / revoke only from ISSUED ("Cannot perform operation <op> on certificate in state <label>. Certificate: …"); an already revoked certificate is refused',
    'issue-existing ("Cannot issue certificate with state <label>", a registered certificate needs the operator\'s CSR)',
    'finalize only from PENDING_ISSUE, confirm only from PENDING_REVOKE, cancel only from a pending state; no other state / operation pair is legal',
    'a ValidationException is a 422 JSON string array, never 400 or 500',
];

test.describe('Certificate state and operation refusal matrix', { tag: tags.api }, () => {
    test('every operation on a certificate pending approval is refused',
        testMeta({ id: 'API-CERT-08', row: 'pending_approval', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(ISSUE_MS);
            // ownRaProfile: requested for its skip without a CA
            const gate: ApprovalGate = await openApprovalGate(api, SPEC, 'g08pa');
            let cert: OwnRef & { name: string } | undefined;
            try {
                cert = await test.step('Fixture: an issue on the gated RA+ clone that waits for its approval', async () => {
                    const c = await submitOwnCertificate(api, gate.ra, SPEC, { suffix: 'c08pa', note: 'API-CERT-08 pending_approval fixture' });
                    expect(c.answer.status, c.answer.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, c.uuid, 'pending_approval', 60_000);
                    return c;
                });
                await assertMatrix(api, cert, gate.ra, 'pending_approval');
            } finally {
                // Decide the leftover (the own approval is rejected through the override path), then ungate the clone.
                if (cert) {
                    const approval = await findApproval(api, cert, SPEC, { timeoutMs: 10_000 }).catch(() => undefined);
                    if (approval) await decideApproval(api, approval, 'reject').catch(() => undefined);
                }
                await gate.release();
            }
        });

    test('every operation on a rejected certificate is refused',
        testMeta({ id: 'API-CERT-08', row: 'rejected', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(ISSUE_MS);
            // ownRaProfile: requested for its skip without a CA
            const gate = await openApprovalGate(api, SPEC, 'g08rj');
            let cert: OwnRef & { name: string };
            try {
                cert = await test.step('Fixture: an issue under the gate, rejected through the override path → rejected', async () => {
                    const c = await submitOwnCertificate(api, gate.ra, SPEC, { suffix: 'c08rj', note: 'API-CERT-08 rejected fixture' });
                    expect(c.answer.status, c.answer.text.slice(0, 300)).toBe(200);
                    await waitForCertificateState(api, c.uuid, 'pending_approval', 60_000);
                    const approval = await findApproval(api, c, SPEC);
                    const d = await decideApproval(api, approval, 'reject');
                    expect(d.status, d.text.slice(0, 200)).toBe(204);
                    await waitForCertificateState(api, c.uuid, 'rejected', 60_000, { failOn: ['failed', 'issued'] });
                    return c;
                });
            } finally {
                await gate.release();
            }
            await assertMatrix(api, cert, gate.ra, 'rejected');
        });

    test('every operation on a revoked certificate is refused',
        testMeta({ id: 'API-CERT-08', row: 'revoked', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            const cert = await test.step('Fixture: an own issued certificate, revoked', async () => {
                const c = await issueOwnCertificate(api, ra, SPEC, { suffix: 'c08rv' });
                const a = await revokeOwnCertificate(api, c, ra, { reason: 'superseded' });
                expect(a.status, a.text.slice(0, 200)).toBe(204);
                await waitForCertificateState(api, c.uuid, 'revoked', 120_000);
                return c;
            });
            await assertMatrix(api, cert, ra, 'revoked');
        });

    test('every operation on a failed certificate is refused',
        testMeta({ id: 'API-CERT-08', row: 'failed', prio: 'P1', issue: 'ilm#429', needs: 'ejbca-ng', rule: [...RULES, 'EJBCA-NG end-entity profile refuses an e-mail SAN: the only shared-tier producer of failed'] }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(ISSUE_MS);
            const ra = ownRaProfile;
            const connector = await authorityConnectorName(api, ra.authorityUuid);
            test.skip(connector !== 'EJBCA-NG-Connector', `needs ejbca-ng: the run RA profile is on ${connector || 'an unknown connector'}; only the EJBCA-NG end-entity profile refuses the e-mail SAN`);
            const cert = await test.step('Fixture: an issue with an e-mail SAN the end-entity profile refuses → failed', async () => {
                const cn = `${runName('c08fl-' + Date.now().toString(36))}.example.test`;
                const csr = csrWithEmailSan(cn, `qa@${cn}`);
                const c = await submitOwnCertificate(api, ra, SPEC, { suffix: 'c08fl', body: { request: csr.derBase64 }, note: 'API-CERT-08 failed fixture (e-mail SAN)' });
                expect(c.answer.status, c.answer.text.slice(0, 300)).toBe(200);
                try {
                    await waitForCertificateState(api, c.uuid, 'failed', 180_000, { failOn: ['issued', 'rejected'] });
                } catch (e) {
                    const state = (await getCertificate(api, c.uuid)).state;
                    test.skip(state === 'issued', 'the CA accepted the e-mail SAN: no failed fixture on this tier (end-entity profile configuration)');
                    throw e;
                }
                return c;
            });
            await assertMatrix(api, cert, ra, 'failed');
        });

    test('every operation on a registered certificate is refused',
        testMeta({ id: 'API-CERT-08', row: 'registered', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(120_000);
            const ra = ownRaProfile;
            const cert = await test.step('Fixture: a platform-level pre-registration with a challenge → registered (ACTIVE)', async () => {
                const r = await registerOwnCertificate(api, ra, SPEC, { suffix: 'c08rg', secret: newChallenge(), note: 'API-CERT-08 registered fixture' });
                expect(r.answer.status, r.answer.text.slice(0, 300)).toBe(200);
                expect(r.cert?.uuid, 'the answer names the placeholder').toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
                await waitForCertificateState(api, r.cert!.uuid, 'registered', 30_000);
                return r.cert!;
            });
            await assertMatrix(api, cert, ra, 'registered');
        });
});
