/**
 * errorContract — the error shapes core answers with (a 422 is a JSON array of non-empty strings, any other error is
 * exactly `{message}`) and `checkRefusedMethod`, which tells core's answer to a refused method from an ingress answer
 * and never copies the response body into its verdict. Pure, no environment.
 */
import { expect, test } from '@playwright/test';
import { errorShape, expect422Messages, expectMessageObject, INGRESS_SKIP_MESSAGE, checkRefusedMethod } from '../../utils/regression/errorContract';

// checkRefusedMethod for the refused-method case: an ingress answer skips; core 400 + empty body passes on main; core 401 is
// the known bug on a migrated build
test('checkRefusedMethod: ingress answer skips, core 400 with empty body passes, core 401 is the known bug', () => {
    const answer = (status: number, bodyText = '', headers: Record<string, string> = {}) => ({ status, headers, bodyText });
    // Not core's answer: skip (the test reports INGRESS_SKIP_MESSAGE, never a pass, never a red gate).
    expect(INGRESS_SKIP_MESSAGE).toBe('refused by the ingress before core (its firewall allow list)');
    expect(checkRefusedMethod(answer(405, '<html>Not Allowed</html>', { server: 'nginx' }))).toEqual({ outcome: 'skip', why: 'HTTP 405' });
    expect(checkRefusedMethod(answer(405))).toEqual({ outcome: 'skip', why: 'HTTP 405' });
    expect(checkRefusedMethod(answer(400, '', { server: 'envoy' }))).toEqual({ outcome: 'skip', why: 'server header names a proxy (envoy)' });
    expect(checkRefusedMethod(answer(401, '', { server: 'Traefik/3.0' }))).toMatchObject({ outcome: 'skip' });
    expect(checkRefusedMethod(answer(502, '<html><body>Bad Gateway</body></html>'))).toEqual({ outcome: 'skip', why: 'non-JSON body (37 bytes)' });
    // Core's own answers (Tomcat sends no proxy Server header; "Apache-Coyote" is core, not a proxy).
    expect(checkRefusedMethod(answer(400))).toEqual({ outcome: 'core', problems: [] });
    expect(checkRefusedMethod(answer(400, '\n', { server: 'Apache-Coyote/1.1' }))).toEqual({ outcome: 'core', problems: [] });
    // On a migrated build core answers 401 (core#2502): problems, so the spec's `expect(problems).toEqual([])` fails — expected there.
    expect(checkRefusedMethod(answer(401))).toEqual({ outcome: 'core', problems: ['status 401, expected 400'] });
    expect(checkRefusedMethod(answer(400, '{"message":"x"}'))).toEqual({ outcome: 'core', problems: ['body is not empty (15 bytes), expected an empty body'] });
});

// checkRefusedMethod never puts the response body into a verdict (a proxy or an error forward could echo the bearer token)
test('checkRefusedMethod never puts the response body into a verdict, since a proxy could echo the token', () => {
    const echo = 'Bearer SECRET-TOKEN-ECHOED';
    for (const verdict of [
        checkRefusedMethod({ status: 400, headers: {}, bodyText: `{"message":"${echo}"}` }),
        checkRefusedMethod({ status: 401, headers: {}, bodyText: echo }),
        checkRefusedMethod({ status: 400, headers: {}, bodyText: `Authorization: ${echo}` }),
        checkRefusedMethod({ status: 405, headers: { server: 'nginx' }, bodyText: echo }),
    ]) expect(JSON.stringify(verdict)).not.toContain('SECRET');
});

test('errorShape: 422 = array of non-empty strings, others = exactly {message}', () => {
    expect(errorShape('["Unknown sort field identifier X."]')).toEqual({ kind: 'messages', messages: ['Unknown sort field identifier X.'] });
    expect(errorShape('{"message":"Object of type \'Certificate\' identified by x is not found."}')).toMatchObject({ kind: 'message' });
    expect(errorShape('')).toEqual({ kind: 'empty' });
    expect(errorShape('[]').kind).toBe('other');
    expect(errorShape('["", "x"]').kind).toBe('other');
    expect(errorShape('[1]').kind).toBe('other');
    expect(errorShape('{"message":"x","trace":"y"}').kind).toBe('other');
    expect(errorShape('{"message":1}').kind).toBe('other');
    expect(errorShape('<html/>').kind).toBe('other');
    expect(errorShape('"x"').kind).toBe('other');
    expect(expect422Messages('["a"]')).toEqual(['a']);
    expect(() => expect422Messages('{"message":"a"}')).toThrow(/JSON array/);
    expect(expectMessageObject('{"message":"Failed to submit certificate request"}')).toBe('Failed to submit certificate request');
    expect(() => expectMessageObject('["a"]')).toThrow(/\{"message"/);
});

// ------------------------------------------------------------------ the auth caller's cases, moved from authPure.spec.ts

// checkRefusedMethod (the regression cases re-run for the auth caller): an ingress answer skips with the named reason; core 400
// + empty body is the baseline; no body text in any message
test('checkRefusedMethod for the auth caller: ingress skips, 400 + empty body is baseline, no body text', () => {
    const answer = (status: number, bodyText = '', headers: Record<string, string> = {}) => ({ status, headers, bodyText });
    expect(INGRESS_SKIP_MESSAGE).toBe('refused by the ingress before core (its firewall allow list)');
    expect(checkRefusedMethod(answer(405, '<html>Not Allowed</html>', { server: 'nginx' }))).toEqual({ outcome: 'skip', why: 'HTTP 405' });
    expect(checkRefusedMethod(answer(400, '', { server: 'envoy' }))).toEqual({ outcome: 'skip', why: 'server header names a proxy (envoy)' });
    expect(checkRefusedMethod(answer(502, '<html><body>Bad Gateway Bearer eyJabc</body></html>'))).toEqual({ outcome: 'skip', why: expect.stringMatching(/^non-JSON body \(\d+ bytes\)$/) });
    expect(checkRefusedMethod(answer(400))).toEqual({ outcome: 'core', problems: [] });
    expect(checkRefusedMethod(answer(400, '\n', { server: 'Apache-Coyote/1.1' }))).toEqual({ outcome: 'core', problems: [] });
    expect(checkRefusedMethod(answer(401))).toEqual({ outcome: 'core', problems: ['status 401, expected 400'] });
    const withBody = checkRefusedMethod(answer(400, '{"token":"SECRET"}'));
    expect(withBody).toEqual({ outcome: 'core', problems: ['body is not empty (18 bytes), expected an empty body'] });
    expect(JSON.stringify(withBody)).not.toContain('SECRET');
});
