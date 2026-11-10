/**
 * errorContract — the error shapes core answers with (a 422 is a JSON array of non-empty strings, any other error is
 * exactly `{message}`) and `checkRefusedMethod`, which wants TRACE refused with 405 by whoever answers, tells a gateway's
 * other answers from core's and never copies the response body into its verdict.
 */
import { expect, test } from '@playwright/test';
import { errorShape, expect422Messages, expectMessageObject, INGRESS_SKIP_MESSAGE, checkRefusedMethod } from '../../utils/regression/errorContract';

test('checkRefusedMethod: 405 passes (core\'s with Allow); 2xx and 5xx fail; another gateway answer skips, core\'s fails', () => {
    const answer = (status: number, bodyText = '', headers: Record<string, string> = {}) => ({ status, headers, bodyText });
    expect(INGRESS_SKIP_MESSAGE).toBe('refused by the ingress before core (its firewall allow list)');
    // Refused with 405: no problem, from the gateway (nginx refuses TRACE itself) or from core; the verdict names who answered.
    expect(checkRefusedMethod(answer(405, '<html>Not Allowed</html>', { server: 'nginx' }))).toEqual({ outcome: 'judged', answeredBy: 'a proxy (nginx)', problems: [] });
    expect(checkRefusedMethod(answer(405, '{"message":"x"}', { server: 'kong/3.9.1' }))).toEqual({ outcome: 'judged', answeredBy: 'a proxy (kong)', problems: [] });
    expect(checkRefusedMethod(answer(405, '<html>Not Allowed</html>'))).toEqual({ outcome: 'judged', answeredBy: 'a gateway (non-JSON body, 24 bytes)', problems: [] });
    expect(checkRefusedMethod(answer(405, '', { allow: 'GET, HEAD, POST' }))).toEqual({ outcome: 'judged', answeredBy: 'core', problems: [] });
    expect(checkRefusedMethod(answer(405))).toEqual({ outcome: 'judged', answeredBy: 'core', problems: ['405 without an Allow header'] });
    // Accepted: a problem whoever answers.
    expect(checkRefusedMethod(answer(200, '<html>TRACE echo</html>', { server: 'nginx' }))).toEqual({ outcome: 'judged', answeredBy: 'a proxy (nginx)', problems: ['status 200: the method was accepted'] });
    expect(checkRefusedMethod(answer(204))).toEqual({ outcome: 'judged', answeredBy: 'core', problems: ['status 204: the method was accepted'] });
    // Another 3xx or 4xx from a gateway says nothing about core: skip. A 5xx is no refusal: a problem.
    expect(checkRefusedMethod(answer(301, 'Moved Permanently', { location: 'https://x/api/v1/info' }))).toEqual({ outcome: 'skip', why: 'a gateway (non-JSON body, 17 bytes) answered 301' });
    expect(checkRefusedMethod(answer(400, '', { server: 'envoy' }))).toEqual({ outcome: 'skip', why: 'a proxy (envoy) answered 400' });
    expect(checkRefusedMethod(answer(401, '', { server: 'Traefik/3.0' }))).toMatchObject({ outcome: 'skip' });
    expect(checkRefusedMethod(answer(403, '<html>Forbidden</html>'))).toEqual({ outcome: 'skip', why: 'a gateway (non-JSON body, 22 bytes) answered 403' });
    expect(checkRefusedMethod(answer(502, '<html><body>Bad Gateway</body></html>'))).toEqual({ outcome: 'judged', answeredBy: 'a gateway (non-JSON body, 37 bytes)', problems: ['status 502, expected 405'] });
    expect(checkRefusedMethod(answer(503, '', { server: 'kong/3.9.1' }))).toEqual({ outcome: 'judged', answeredBy: 'a proxy (kong)', problems: ['status 503, expected 405'] });
    // Core's other answers (Tomcat sends no proxy Server header; "Apache-Coyote" is core): 401 was core#2502, 400 the old answer.
    expect(checkRefusedMethod(answer(401))).toEqual({ outcome: 'judged', answeredBy: 'core', problems: ['status 401, expected 405'] });
    expect(checkRefusedMethod(answer(400, '\n', { server: 'Apache-Coyote/1.1' }))).toEqual({ outcome: 'judged', answeredBy: 'core', problems: ['status 400, expected 405'] });
    expect(checkRefusedMethod(answer(400, '{"message":"x"}'))).toEqual({ outcome: 'judged', answeredBy: 'core', problems: ['status 400, expected 405'] });
    expect(checkRefusedMethod(answer(302, '', { location: '/login' }))).toEqual({ outcome: 'judged', answeredBy: 'core', problems: ['status 302, expected 405'] });
});

// checkRefusedMethod never puts the response body into a verdict
// (a proxy or an error forward could echo the bearer token)
test('checkRefusedMethod never puts the response body into a verdict, since a proxy could echo the token', () => {
    const echo = 'Bearer SECRET-TOKEN-ECHOED';
    for (const verdict of [
        checkRefusedMethod({ status: 400, headers: {}, bodyText: `{"message":"${echo}"}` }),
        checkRefusedMethod({ status: 401, headers: {}, bodyText: echo }),
        checkRefusedMethod({ status: 400, headers: {}, bodyText: `Authorization: ${echo}` }),
        checkRefusedMethod({ status: 405, headers: { server: 'nginx' }, bodyText: echo }),
        checkRefusedMethod({ status: 502, headers: {}, bodyText: `<html><body>Bad Gateway ${echo}</body></html>` }),
        checkRefusedMethod({ status: 200, headers: { server: `nginx ${echo}` }, bodyText: echo }),
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
