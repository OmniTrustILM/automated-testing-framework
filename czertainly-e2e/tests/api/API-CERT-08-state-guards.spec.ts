/**
 * API-CERT-08 — the state × operation refusal matrix (cert-lifecycle rules §2.3 / §3.3 Illegal, §7.3, §7.4, §3.2 RR-2 3,
 * §4.2 RV-3, §6.2 PR-6; catalogue D / J): for an own certificate in each fixture state, renew / rekey / revoke /
 * issue-existing / confirm revoke / cancel / finalize answer a 422 with the quoted one-element string array, and nothing
 * changes (state, history, successor count); never a 5xx.
 *
 * One self-contained test per fixture state (each builds its own certificate; `pending_approval` and `rejected` through
 * an own RA+ clone with the run approval profile, released at the end; `revoked` through a revoke; `failed` through an
 * e-mail SAN the EJBCA-NG end-entity profile refuses, `@needs:ejbca-ng`). The `registered` fixture needs the register
 * route on the guard's create list (guard request, see API-CERT-21): rendered as `test.fixme` with its full body. The
 * rows for requested / pending_issue / pending_revoke / pending_registration run in API-CERT-37 (local stack only).
 */
import { expect, test } from '../../fixtures/testFixtures';
import {
    ApprovalGate, cancelPending, confirmRevoke, csrWithEmailSan, decideApproval, findApproval, finalizeIssue, historyMessages, historyOf, issueExisting,
    issueOwnCertificate, messagesOf, newChallenge, newKeyPair, openApprovalGate, RaLike, RawAnswer, registerOwn, rekeyOwn, relationsOf, renewOwn, revokeOwn,
    stateGuardText, STATE_LABELS, submitOwnCertificate,
} from '../../utils/regression/lifecycle';
import type { GuardedApi } from '../../utils/regression/guardedApi';
import { csrFromKey } from '../../utils/regression/pki';
import { authorityConnectorName, ensureRaProfileOrSkip, getCertificate } from '../../utils/regression/regressionApi';
import { OwnRef, regName } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';
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
        expectRefusal(await renewOwn(api, cert, ra, SPEC, { csrDerBase64: csr.derBase64 }), 'renew', stateGuardText('renew', state));
        expectRefusal(await rekeyOwn(api, cert, ra, SPEC, { csrDerBase64: csr.derBase64 }), 'rekey', stateGuardText('rekey', state));
        // RV-3: an already revoked certificate is refused with its own text before the generic state check.
        expectRefusal(await revokeOwn(api, cert, ra, { reason: 'unspecified' }), 'revoke', state === 'revoked' ? 'Certificate is already revoked. Certificate: ' : stateGuardText('revoke', state));
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

/** One key pair for the probe CSRs of the file (the state check precedes every CSR check, so any key serves). */
let cachedKeys: ReturnType<typeof newKeyPair> | undefined;
const csrKeys = (): ReturnType<typeof newKeyPair> => (cachedKeys ??= newKeyPair());

const RULES = [
    'cert-lifecycle §3.2 RR-2 3 (renew / rekey / revoke only from ISSUED: "Cannot perform operation <op> on certificate in state <label>. Certificate: …"), §4.2 RV-3 (already revoked)',
    'cert-lifecycle §2.2 API-11 / §6.2 PR-6 (issue-existing: "Cannot issue certificate with state <label>", a registered certificate needs the operator\'s CSR)',
    'cert-lifecycle §7.4 (finalize only from PENDING_ISSUE, confirm only from PENDING_REVOKE, cancel only from a pending state), §7.3 (no other legal pair), §11 rule 9',
    'cert-lifecycle §0.1 / §11 rule 2 (a ValidationException is a 422 JSON string array, never 400 or 500)',
];

test.describe('API-CERT-08 state × operation refusal matrix', { tag: tags.api }, () => {
    test('API-CERT-08[pending_approval]: every lifecycle operation on a certificate waiting for an approval is refused with the state text and changes nothing',
        meta({ id: 'API-CERT-08', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api }) => {
            test.setTimeout(240_000);
            await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
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

    test('API-CERT-08[rejected]: every lifecycle operation on a rejected certificate is refused with the state text and changes nothing',
        meta({ id: 'API-CERT-08', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api }) => {
            test.setTimeout(240_000);
            await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
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

    test('API-CERT-08[revoked]: every lifecycle operation on a revoked certificate is refused (revoke: "already revoked") and changes nothing',
        meta({ id: 'API-CERT-08', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api }) => {
            test.setTimeout(420_000);
            const ra = await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const cert = await test.step('Fixture: an own issued certificate, revoked', async () => {
                const c = await issueOwnCertificate(api, ra, SPEC, { suffix: 'c08rv' });
                const a = await revokeOwn(api, c, ra, { reason: 'superseded' });
                expect(a.status, a.text.slice(0, 200)).toBe(204);
                await waitForCertificateState(api, c.uuid, 'revoked', 120_000);
                return c;
            });
            await assertMatrix(api, cert, ra, 'revoked');
        });

    test('API-CERT-08[failed]: every lifecycle operation on a failed certificate is refused with the state text and changes nothing',
        meta({ id: 'API-CERT-08', prio: 'P1', issue: 'ilm#429', needs: 'ejbca-ng', rule: [...RULES, 'cert-lifecycle §2.2 API-12 (EJBCA-NG end-entity profile refuses an e-mail SAN: the only shared-tier producer of failed)'] }),
        async ({ api }) => {
            test.setTimeout(240_000);
            const ra = await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const connector = await authorityConnectorName(api, ra.authorityUuid);
            test.skip(connector !== 'EJBCA-NG-Connector', `needs ejbca-ng: the run RA profile is on ${connector || 'an unknown connector'}; only the EJBCA-NG end-entity profile refuses the e-mail SAN`);
            const cert = await test.step('Fixture: an issue with an e-mail SAN the end-entity profile refuses → failed', async () => {
                const cn = `${regName('c08fl-' + Date.now().toString(36))}.example.test`;
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

    test('API-CERT-08[registered]: every lifecycle operation on a registered certificate is refused (issue-existing: a CSR is required) and changes nothing',
        meta({ id: 'API-CERT-08', prio: 'P1', issue: 'ilm#429', rule: RULES }),
        async ({ api }) => {
            test.setTimeout(120_000);
            const ra = await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const cert = await test.step('Fixture: a platform-level pre-registration with a challenge → registered (ACTIVE)', async () => {
                const r = await registerOwn(api, ra, SPEC, { suffix: 'c08rg', secret: newChallenge(), note: 'API-CERT-08 registered fixture' });
                expect(r.answer.status, r.answer.text.slice(0, 300)).toBe(200);
                expect(r.cert, 'the answer names the placeholder').toBeTruthy();
                await waitForCertificateState(api, r.cert!.uuid, 'registered', 30_000);
                return r.cert!;
            });
            await assertMatrix(api, cert, ra, 'registered');
        });
});
