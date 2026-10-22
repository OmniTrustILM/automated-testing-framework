/**
 * Unit tests of the shared test-design helpers the area specs call.
 *
 * WHAT: the SAN oracle of a connector, the refusal check, the health-group body check, the named wait budgets, and the
 *       filter evaluator both the reference rows and the stand-in use.
 * WHY: a rule written once is only safe if its helper is proven to pass the right answer and fail the wrong one.
 * HOW: pure calls with hand-made answers; no network, no ledger.
 */
import { expect, test } from '@playwright/test';
import { sanOracle, waitIssued, waitRevoked } from '../../utils/regression/ownCertificates';
import { fakeRequestContext } from './helpers/fakeRequestContext';
import { expectRefused, internalLeaks } from '../../utils/regression/errorContract';
import { expectHealthGroupUp, healthGroupProblems, isHealthGroupUp } from '../../utils/regression/platform/connectorApi';
import { ISSUED_WAIT_MS, REVOKED_WAIT_MS } from '../../utils/regression/timeouts';
import { satisfiesFilter } from '../../utils/regression/inventory/oracles/values';
import { expectImportRefused } from '../../utils/regression/inventory/importFixtures';

const csrSans = { dns: ['a.example.test', 'b.example.test'], ip: ['192.0.2.1'] };

test('sanOracle: an exact connector needs the same DNS and IP set', () => {
    const oracle = sanOracle('EJBCA-NG-Connector', {});
    expect(oracle.mode).toBe('exact');
    expect(oracle.describe()).toContain('exact SAN set');
    expect(() => oracle.expectSans({ dns: ['b.example.test', 'a.example.test'], ip: ['192.0.2.1'] }, csrSans)).not.toThrow();
    expect(() => oracle.expectSans({ dns: ['a.example.test'], ip: ['192.0.2.1'] }, csrSans)).toThrow();
});

test('sanOracle: another connector needs the DNS values only, in any case', () => {
    const oracle = sanOracle('MS-ADCS-NG-Connector', {});
    expect(oracle.mode).toBe('dns');
    expect(oracle.describe()).toContain('DNS values only');
    expect(() => oracle.expectSans({ dns: ['A.example.test', 'b.example.test', 'extra.example.test'], ip: [] }, csrSans)).not.toThrow();
    expect(() => oracle.expectSans({ dns: ['a.example.test'], ip: [] }, csrSans)).toThrow();
});

test('sanOracle: expectIssued reads the SANs of a certificate detail', () => {
    const oracle = sanOracle('MS-ADCS-NG-Connector', {});
    const detail = { subjectAlternativeNames: { dNSName: ['a.example.test', 'b.example.test'], iPAddress: ['192.0.2.1'] } };
    expect(() => oracle.expectIssued(detail, csrSans)).not.toThrow();
    expect(() => oracle.expectIssued({ subjectAlternativeNames: { dNSName: ['a.example.test'] } }, csrSans)).toThrow();
});

const json = 'application/json';
const refused422 = (messages: string[], contentType = json) => ({ status: 422, text: JSON.stringify(messages), contentType });
const refusedObject = (status: number, message: string, contentType = json) => ({ status, text: JSON.stringify({ message }), contentType });

test('expectRefused: a 422 is a message list, any other status is a message object', () => {
    expect(expectRefused(refused422(['Name must not be empty']), { status: 422, text: 'Name must not be empty' })).toEqual(['Name must not be empty']);
    expect(expectRefused(refusedObject(404, 'Group not found'), { status: 404, text: 'Group not found' })).toEqual(['Group not found']);
    expect(expectRefused(refused422(['a', 'b']), { status: 422 })).toEqual(['a', 'b']);
    expect(() => expectRefused({ status: 422, text: '{"message":"x"}', contentType: json }, { status: 422 })).toThrow();
    expect(() => expectRefused({ status: 404, text: '["x"]', contentType: json }, { status: 404 })).toThrow();
    expect(() => expectRefused({ status: 404, text: '{"message":"x","extra":1}', contentType: json }, { status: 404 })).toThrow();
    expect(() => expectRefused(refusedObject(400, 'x'), { status: 422 })).toThrow();
});

test('expectRefused: a string text is the one message, exactly; a substring does not pass', () => {
    expect(() => expectRefused(refused422(['Name must not be empty']), { status: 422, text: 'must not be empty' })).toThrow();
    expect(() => expectRefused(refused422(['Name must not be empty.']), { status: 422, text: 'Name must not be empty' })).toThrow();
    expect(() => expectRefused(refused422(['Name must not be empty ']), { status: 422, text: 'Name must not be empty' })).toThrow();
    expect(() => expectRefused(refused422(['other']), { status: 422, text: 'wanted' })).toThrow();
    expect(() => expectRefused(refusedObject(404, 'Group not found, really'), { status: 404, text: 'Group not found' })).toThrow();
});

test('expectRefused: a string text needs exactly one message, a second message fails it', () => {
    expect(() => expectRefused(refused422(['wanted', 'another']), { status: 422, text: 'wanted' })).toThrow(/exactly one message/);
    expect(() => expectRefused(refused422(['wanted', 'another']), { status: 422, text: /^wanted$/ })).toThrow(/exactly one message/);
});

test('expectRefused: a regular expression matches the one message as written', () => {
    expect(() => expectRefused(refused422(['Field X is bad']), { status: 422, text: /^Field \w is bad$/ })).not.toThrow();
    expect(() => expectRefused(refused422(['Field X is bad']), { status: 422, text: /is bad/ })).not.toThrow();
    expect(() => expectRefused(refused422(['Field X is bad, very']), { status: 422, text: /^Field \w is bad$/ })).toThrow();
    expect(() => expectRefused(refused422(['no match']), { status: 422, text: /^Field/ })).toThrow();
});

test('expectRefused among: some message equals or matches, the others are allowed, none that does fails', () => {
    expect(() => expectRefused(refused422(['one', 'wanted']), { status: 422, text: 'wanted', among: true })).not.toThrow();
    expect(() => expectRefused(refused422(['one', 'wanted']), { status: 422, text: /^wan/, among: true })).not.toThrow();
    expect(() => expectRefused(refused422(['one', 'wanted too']), { status: 422, text: 'wanted', among: true })).toThrow();
    expect(() => expectRefused(refused422(['one', 'two']), { status: 422, text: /three/, among: true })).toThrow();
});

test('expectRefused prefix: the message starts with the text; the exact reading and a regular expression are not mixed in', () => {
    expect(() => expectRefused(refused422(['Cannot perform operation renew. Certificate: abc']), { status: 422, text: 'Cannot perform operation renew.', prefix: true })).not.toThrow();
    expect(() => expectRefused(refused422(['Certificate: Cannot perform operation renew.']), { status: 422, text: 'Cannot perform operation renew.', prefix: true })).toThrow();
    expect(() => expectRefused(refused422(['a', 'Cannot perform']), { status: 422, text: 'Cannot', prefix: true })).toThrow(/exactly one message/);
    expect(() => expectRefused(refused422(['a', 'Cannot perform']), { status: 422, text: 'Cannot', prefix: true, among: true })).not.toThrow();
    expect(() => expectRefused(refused422(['x']), { status: 422, text: /x/, prefix: true })).toThrow(/prefix needs a string/);
});

test('expectRefused: the content type is application/json unless the caller gives a reason', () => {
    expect(() => expectRefused(refused422(['x'], 'text/html'), { status: 422, text: 'x' })).toThrow(/content type/);
    expect(() => expectRefused(refused422(['x'], ''), { status: 422, text: 'x' })).toThrow(/content type/);
    expect(() => expectRefused(refused422(['x'], 'application/json;charset=UTF-8'), { status: 422, text: 'x' })).not.toThrow();
    expect(() => expectRefused(refused422(['x'], 'text/plain'), { status: 422, text: 'x', contentTypeNotChecked: 'the proxy rewrites the header' })).not.toThrow();
    expect(() => expectRefused(refused422(['x'], 'text/plain'), { status: 422, text: 'x', contentTypeNotChecked: ' ' })).toThrow(/needs the reason/);
});

test('expectRefused: a leak in the body fails it', () => {
    expect(() => expectRefused(refused422(['org.hibernate.Exception: boom']), { status: 422 })).toThrow(/leaks/);
    expect(() => expectRefused(refused422(['at com.example.Foo.bar']), { status: 422 })).toThrow(/leaks/);
    expect(() => expectRefused(refused422(['SQLSTATE 23503']), { status: 422 })).toThrow(/leaks/);
    expect(() => expectRefused(refused422(['IllegalStateException happened']), { status: 422 })).toThrow(/leaks/);
});

// A JSON body writes a line break as the two characters backslash and n (a tab: backslash and t), so the next word is joined
// to a letter: the plain word boundary the list started with missed `\torg.hibernate`, which the unanchored pattern had found.
test('internalLeaks: a trace written with JSON escapes is caught; a word that only ends in the same letters is not', () => {
    const body = (text: string): string => JSON.stringify({ message: text });
    expect(internalLeaks(body('boom\norg.hibernate.exception.ConstraintViolationException'))).not.toEqual([]);
    expect(internalLeaks(body('boom\n\torg.springframework.web.Foo'))).not.toEqual([]);
    expect(internalLeaks(body('boom\r\torg.postgresql.util.Foo'))).not.toEqual([]);
    expect(internalLeaks(body('x\n\tat com.otilm.core.Foo.bar'))).not.toEqual([]);
    expect(internalLeaks(body('x\n\tat java.base.Foo.bar(Foo.java:1)'))).not.toEqual([]);
    expect(internalLeaks('\\norg.hibernate'), 'the two characters backslash and n').not.toEqual([]);
    expect(internalLeaks('Georg.springer wrote it')).toEqual([]);
    expect(internalLeaks('sorg.hibernate')).toEqual([]);
    expect(internalLeaks('the norg.postgresql file')).toEqual([]);
    expect(internalLeaks('what at compare.notes')).toEqual([]);
    expect(internalLeaks('that com.example is a domain')).toEqual([]);
});

test('internalLeaks: stack frames, exception names, SQL states and framework packages; a plain message is clean', () => {
    expect(internalLeaks('{"message":"Object of type \'RaProfile\' identified by x is not found."}')).toEqual([]);
    expect(internalLeaks('java.lang.NullPointerException at com.otilm.core.service')).not.toEqual([]);
    expect(internalLeaks('trace at org.foo.Bar(Bar.java:1)')).not.toEqual([]);
    expect(internalLeaks('SQLState: 23503')).not.toEqual([]);
    expect(internalLeaks('sqlstate: 23503')).not.toEqual([]);
    expect(internalLeaks('org.postgresql.util.PSQLException')).not.toEqual([]);
    expect(internalLeaks('org.springframework.web.Foo')).not.toEqual([]);
});

test('expectImportRefused: the refusal of an import file is a 422 JSON list with exactly the message', () => {
    expect(() => expectImportRefused(refused422(['The file exceeds the limit']), 'The file exceeds the limit')).not.toThrow();
    expect(() => expectImportRefused(refused422(['The file exceeds the limit']), 'exceeds')).toThrow();
    expect(() => expectImportRefused(refused422(['The file exceeds the limit']), /exceeds the limit$/)).not.toThrow();
    expect(() => expectImportRefused(refused422(['The file exceeds the limit', 'second']), 'The file exceeds the limit')).toThrow();
    expect(() => expectImportRefused(refusedObject(400, 'The file exceeds the limit'), 'The file exceeds the limit')).toThrow();
    expect(() => expectImportRefused(refused422(['The file exceeds the limit'], 'text/plain'), 'The file exceeds the limit')).toThrow(/content type/);
});

test('healthGroupProblems: only 200 with exactly the UP body is clean', () => {
    expect(healthGroupProblems({ status: 200, json: { status: 'UP' } })).toEqual([]);
    expect(healthGroupProblems({ status: 503, json: { status: 'DOWN' } })).toHaveLength(2);
    expect(healthGroupProblems({ status: 200, json: { status: 'UP', groups: [] } })).toHaveLength(1);
});

test('the liveness oracle: status 200 and exactly {"status":"UP"}, nothing more, nothing else', () => {
    const up = { status: 200, json: { status: 'UP' }, text: '{"status":"UP"}' };
    expect(isHealthGroupUp(up)).toBe(true);
    expect(() => expectHealthGroupUp(up, 'liveness')).not.toThrow();
    const bad: Array<[string, { status: number; json?: unknown; text?: string }]> = [
        ['status 204', { status: 204, json: { status: 'UP' } }],
        ['status 503', { status: 503, json: { status: 'UP' } }],
        ['an extra member', { status: 200, json: { status: 'UP', components: {} } }],
        ['another status word', { status: 200, json: { status: 'DOWN' } }],
        ['a lower-case word', { status: 200, json: { status: 'up' } }],
        ['no body', { status: 200, json: undefined, text: '' }],
        ['a text that is no JSON', { status: 200, json: undefined, text: 'UP' }],
        ['an array', { status: 200, json: [{ status: 'UP' }] }],
        ['a nested status', { status: 200, json: { status: { value: 'UP' } } }],
    ];
    for (const [what, answer] of bad) {
        expect(isHealthGroupUp(answer), what).toBe(false);
        expect(() => expectHealthGroupUp(answer, 'readiness'), what).toThrow(/readiness/);
    }
});

test('the wait budgets are named and ordered', () => {
    expect(ISSUED_WAIT_MS).toBe(180_000);
    expect(REVOKED_WAIT_MS).toBe(120_000);
});

test('waitIssued and waitRevoked are exported, resolve on their state and fail at once on a failed certificate', async () => {
    await waitIssued(fakeRequestContext([{ status: 200, body: { state: 'issued' } }]).api, 'c-1');
    await waitRevoked(fakeRequestContext([{ status: 200, body: { state: 'revoked' } }]).api, 'c-1');
    await expect(waitIssued(fakeRequestContext([{ status: 200, body: { state: 'failed' } }]).api, 'c-1')).rejects.toThrow(/reached "failed" instead of "issued"/);
    await expect(waitRevoked(fakeRequestContext([{ status: 200, body: { state: 'rejected' } }]).api, 'c-1')).rejects.toThrow(/reached "rejected" instead of "revoked"/);
});

test('satisfiesFilter: the strict reading is case-exact, the core reading is not', () => {
    expect(satisfiesFilter(['qa-FLT-1'], 'CONTAINS', 'flt')).toBe(true);
    expect(satisfiesFilter(['qa-FLT-1'], 'CONTAINS', 'flt', { caseSensitive: true })).toBe(false);
    expect(satisfiesFilter(['qa-FLT-1'], 'NOT_CONTAINS', 'flt')).toBe(true);
});
