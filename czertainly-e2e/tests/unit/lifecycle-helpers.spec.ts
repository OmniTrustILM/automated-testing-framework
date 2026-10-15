/**
 * cert-lifecycle (B2 / B3) — pure helpers of utils/regression/lifecycle.ts, without an environment (npm run test:unit):
 * the state-walk subsequence oracle, the history order oracle (event codes, presence and order, never counts), the
 * sorted history, the rule texts (state guards, revoke reasons, approval close), the raw-answer readers, the leak words,
 * the e-mail SAN CSR and the challenge format.
 */
import { expect, test } from '@playwright/test';
import {
    approvalClosedText, csrFromKeyWithSubject, csrWithEmailSan, EVENT_CODES, historyOrderProblem, isSubsequenceOf, leaksIn, messageOf, messagesOf, msBetween,
    newChallenge, newKeyPair, opsBase, recipientComments, REVOKE_REASONS, revokedText, sortedHistory, STATE_LABELS, stateGuardText, subjectAttributesOf, specialCharCn,
} from '../../utils/regression/lifecycle';
import { carriesRunPrefix } from '../../utils/regression/ownObjects';
import { csrInfo } from '../../utils/regression/pki';
import { regName, RUN_ID } from '../../utils/regression/regressionRun';

const answer = (status: number, text: string) => ({ status, text, elapsedMs: 1 });

test('isSubsequenceOf: the observed state walk must appear in the expected order, nothing else', () => {
    const walk = ['requested', 'pending_issue', 'issued'];
    expect(isSubsequenceOf(['issued'], walk)).toBe(true);
    expect(isSubsequenceOf(['requested', 'issued'], walk)).toBe(true);
    expect(isSubsequenceOf(['requested', 'pending_issue', 'issued'], walk)).toBe(true);
    expect(isSubsequenceOf(['pending_issue', 'requested'], walk), 'wrong order').toBe(false);
    expect(isSubsequenceOf(['requested', 'failed'], walk), 'a state outside the walk').toBe(false);
    expect(isSubsequenceOf(['issued', 'issued'], walk), 'a repeat is not a subsequence').toBe(false);
    expect(isSubsequenceOf([], walk)).toBe(true);
});

const row = (event: string, status: string, created: string, message = '') => ({ event, status, created, message });

test('sortedHistory: oldest first by created; equal timestamps keep the server\'s newest-first order reversed; unparsable dates too', () => {
    // The server lists newest first: b (10:00:02, listed before c) is the NEWER of the two equal timestamps.
    const rows = [row('b', 'SUCCESS', '2026-10-14T10:00:02Z'), row('c', 'SUCCESS', '2026-10-14T10:00:02Z'), row('a', 'SUCCESS', '2026-10-14T10:00:01Z')];
    expect(sortedHistory(rows).map((r) => r.event)).toEqual(['a', 'c', 'b']);
    expect(sortedHistory([row('x', 'S', 'nope'), row('y', 'S', 'nope')]).map((r) => r.event), 'no dates: the server order reversed').toEqual(['y', 'x']);
    // Mutant: a plain index tie-break would answer a, b, c.
    expect(sortedHistory(rows).map((r) => r.event)).not.toEqual(['a', 'b', 'c']);
});

test('historyOrderProblem: the JSON event codes in order; presence and order only; a missing or misordered row is named', () => {
    const rows = [
        row(EVENT_CODES.APPROVAL_REQUEST, 'SUCCESS', '2026-10-14T10:00:01Z'),
        row(EVENT_CODES.APPROVAL_CLOSE, 'SUCCESS', '2026-10-14T10:00:02Z'),
        row(EVENT_CODES.ISSUE, 'SUCCESS', '2026-10-14T10:00:03Z'),
        row(EVENT_CODES.ISSUE, 'SUCCESS', '2026-10-14T10:00:04Z'),
    ];
    expect(historyOrderProblem(rows, [['APPROVAL_REQUEST', 'SUCCESS'], ['APPROVAL_CLOSE', 'SUCCESS'], ['ISSUE', 'SUCCESS']])).toBeUndefined();
    expect(historyOrderProblem(rows, [['ISSUE', 'SUCCESS']]), 'a subset passes (no counts)').toBeUndefined();
    expect(historyOrderProblem(rows, [['ISSUE', 'SUCCESS'], ['ISSUE', 'SUCCESS']]), 'two rows of one kind are allowed when present').toBeUndefined();
    expect(historyOrderProblem(rows, [['ISSUE', 'SUCCESS'], ['APPROVAL_CLOSE', 'SUCCESS']])).toMatch(/missing Approve action closed\/SUCCESS after position/);
    expect(historyOrderProblem(rows, [['REVOKE', 'SUCCESS']])).toMatch(/missing Revoke Certificate\/SUCCESS/);
    expect(historyOrderProblem(rows, [['APPROVAL_CLOSE', 'FAILED']]), 'the status is part of the row').toMatch(/missing/);
    // The order is judged on the sorted rows, whatever the server's list order.
    expect(historyOrderProblem([...rows].reverse(), [['APPROVAL_REQUEST', 'SUCCESS'], ['ISSUE', 'SUCCESS']])).toBeUndefined();
    // Mutant (row reuse): one history row may satisfy one expected step only — two expected ISSUE rows need two rows.
    const single = rows.slice(0, 3);
    expect(historyOrderProblem(single, [['ISSUE', 'SUCCESS']])).toBeUndefined();
    expect(historyOrderProblem(single, [['ISSUE', 'SUCCESS'], ['ISSUE', 'SUCCESS']])).toMatch(/missing Issue Certificate\/SUCCESS after position 3/);
    expect(historyOrderProblem(single, [['APPROVAL_CLOSE', 'SUCCESS'], ['APPROVAL_CLOSE', 'SUCCESS']])).toMatch(/missing/);
});

test('rule texts: state guards use the state label, the nine revoke reasons carry their labels, approval close and revoke lines', () => {
    expect(stateGuardText('renew', 'pending_approval')).toBe('Cannot perform operation renew on certificate in state Pending approval. Certificate: ');
    expect(stateGuardText('revoke', 'rejected')).toBe('Cannot perform operation revoke on certificate in state Rejected. Certificate: ');
    expect(stateGuardText('rekey', 'registered')).toBe('Cannot perform operation rekey on certificate in state Registered. Certificate: ');
    expect(STATE_LABELS).toEqual({
        requested: 'Requested', rejected: 'Rejected', pending_approval: 'Pending approval', pending_issue: 'Pending issue', pending_revoke: 'Pending revoke',
        pending_registration: 'Pending registration', registered: 'Registered', failed: 'Failed', issued: 'Issued', revoked: 'Revoked',
    });
    expect(REVOKE_REASONS.map((r) => r.label)).toEqual(['Unspecified', 'Key compromise', 'CA compromise', 'Affiliation changed', 'Superseded', 'Cessation of operation', 'Certificate hold', 'Privilege withdrawn', 'AA compromise']);
    expect(REVOKE_REASONS).toHaveLength(9);
    expect(REVOKE_REASONS.map((r) => r.code)).toEqual(['unspecified', 'keyCompromise', 'cACompromise', 'affiliationChanged', 'superseded', 'cessationOfOperation', 'certificateHold', 'privilegeWithdrawn', 'aACompromise']);
    expect(REVOKE_REASONS.find((r) => r.code === 'keyCompromise')!.label).toBe('Key compromise');
    expect(revokedText('Key compromise')).toBe('Certificate revoked. Reason: Key compromise');
    expect(approvalClosedText('issue', 'qa-reg-x-ap', 'Approved')).toBe('Approval for action issue with approval profile qa-reg-x-ap closed with status Approved');
    expect(opsBase({ uuid: 'r', authorityUuid: 'a' })).toBe('/api/v2/operations/authorities/a/raProfiles/r');
});

test('raw-answer readers: a 422 is a string array, a 400 / 404 is {message}; anything else names the shape', () => {
    expect(messagesOf(answer(422, '["Certificate is already revoked. Certificate: x"]'))).toEqual(['Certificate is already revoked. Certificate: x']);
    expect(() => messagesOf(answer(422, '{"message":"x"}'))).toThrow(/JSON array of non-empty strings/);
    expect(messageOf(answer(400, '{"message":"Failed to submit certificate request"}'))).toBe('Failed to submit certificate request');
    expect(() => messageOf(answer(400, '["x"]'))).toThrow(/\{"message": "<text>"\}/);
    expect(recipientComments({ approvalSteps: [{ approvalStepRecipients: [{ comment: 'Approval flow overridden' }, { comment: null }] }] })).toEqual(['Approval flow overridden']);
    expect(recipientComments({})).toEqual([]);
});

test('leaksIn: stack frames, exception names, SQL states and framework packages are leaks; a plain message is clean', () => {
    expect(leaksIn('{"message":"Object of type \'RaProfile\' identified by x is not found."}')).toEqual([]);
    expect(leaksIn('java.lang.NullPointerException at com.otilm.core.service')).not.toEqual([]);
    expect(leaksIn('SQLState: 23503')).not.toEqual([]);
    expect(leaksIn('org.hibernate.exception.ConstraintViolation')).not.toEqual([]);
});

test('subjectAttributesOf / csrFromKeyWithSubject: the issued subject DN (several RDNs, escaped characters) becomes the CSR subject, in order', () => {
    expect(subjectAttributesOf('CN=qa-reg-x.example.test,O=QA Org,C=CZ')).toEqual([
        { name: 'commonName', value: 'qa-reg-x.example.test' }, { name: 'organizationName', value: 'QA Org' }, { name: 'countryName', value: 'CZ' },
    ]);
    expect(subjectAttributesOf('CN=a\\, b\\+c, OU = Unit,2.5.4.97=NTRCZ-1')).toEqual([
        { name: 'commonName', value: 'a, b+c' }, { name: 'organizationalUnitName', value: 'Unit' }, { shortName: '2.5.4.97', value: 'NTRCZ-1' },
    ]);
    const keys = newKeyPair();
    const csr = csrFromKeyWithSubject(keys, 'CN=qa-reg-x.example.test,O=QA Org,C=CZ', { dns: ['qa-reg-x.example.test'] });
    const info = csrInfo(csr.pem);
    expect(info.subject).toBe('CN=qa-reg-x.example.test, O=QA Org, C=CZ');
    expect(info.sans).toEqual({ dns: ['qa-reg-x.example.test'], ip: [] });
    expect(info.spkiBase64).toBe(csr.spkiBase64);
    // Mutant: a CN-only CSR differs from the issued subject the CA completed.
    expect(csrInfo(csrFromKeyWithSubject(keys, 'CN=qa-reg-x.example.test').pem).subject).toBe('CN=qa-reg-x.example.test');
});

test('csrWithEmailSan: a DNS name and an rfc822Name next to the CN; newChallenge is 12–255 printable ASCII and run-prefixed', () => {
    const csr = csrWithEmailSan('qa-reg-x-fl.example.test', 'qa@qa-reg-x-fl.example.test');
    const info = csrInfo(csr.pem);
    expect(info.subject).toBe('CN=qa-reg-x-fl.example.test');
    expect(info.sans.dns).toEqual(['qa-reg-x-fl.example.test']);
    expect(Buffer.from(csr.derBase64, 'base64').length).toBeGreaterThan(300);
    // The e-mail SAN is in the request (an rfc822Name is not a DNS / IP kind the SanSet reader lists).
    expect(csr.pem).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----/);
    for (let i = 0; i < 5; i++) {
        const s = newChallenge();
        expect(s.length).toBeGreaterThanOrEqual(12);
        expect(s.length).toBeLessThanOrEqual(255);
        expect(s).toMatch(/^[\x20-\x7E]+$/);
        expect(s).toMatch(/^qa-/);
    }
    expect(msBetween('2026-10-14T10:00:00Z', new Date('2026-10-14T10:05:00Z'))).toBe(5 * 60 * 1000);
});

test('merge review M1: the API-CERT-21[rfc4514] CN starts with the run prefix (the teardown\'s ownership rule), the special characters come after it; a leading space would not be own', () => {
    const cn = specialCharCn(regName('c21dn-x'));
    expect(cn.startsWith(`${RUN_ID}-`)).toBe(true);
    expect(cn).toMatch(/, O= QA\+Team$/);
    expect(carriesRunPrefix(cn, RUN_ID, 'certificates')).toBe(true);
    expect(carriesRunPrefix(` ${cn}`, RUN_ID, 'certificates'), 'the old shape (leading space) is refused by the ownership rule').toBe(false);
});
