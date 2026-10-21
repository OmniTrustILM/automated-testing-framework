/**
 * TRACE through the guard (the refused-method check of the migration gate), on the wire: a bodyless read held to the GET
 * rules and stricter (no body, no identity header, no text/plain, no redirect, no side-effect-GET path). It may name any
 * object, because it changes nothing; any other unknown method stays refused.
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import { guardApiWithSeams } from '../../utils/regression/guard/createGuard';
import { OwnObjectViolation, RefusalKind } from '../../utils/regression/ledger/ownership';
import { LedgerLine } from '../../utils/regression/ledger/ledger';
import { loopbackServer, LoopbackServer } from './helpers/loopbackServer';
import { registerGuardRig, withProcessEnv } from './helpers/guardRig';

const RUN = 'qa-reg-20261014-090000-tr01';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWN_ROLE = U(3);
const OWN_CERT = U(5);
const FOREIGN_ROLE = U(20);

const lines: LedgerLine[] = [
    { at: 'a', runId: RUN, type: 'roles', name: `${RUN}-role`, uuid: OWN_ROLE, spec: 'T', event: 'created' },
    { at: 'a', runId: RUN, type: 'certificates', name: `${RUN}.example.test`, uuid: OWN_CERT, spec: 'T', event: 'created' },
];

let A: LoopbackServer;
let B: LoopbackServer;
let raw: APIRequestContext;
let BASE_URL: string;

registerGuardRig(
    {
        // TRACE answers 400 with an empty body, like core's firewall on main; a redirect is offered for the hop rule.
        answer: (a) => (a.url === '/api/v1/redirect-me' ? { status: 302, headers: { location: '/api/v1/info' } } : a.method === 'TRACE' ? { status: 400 } : undefined),
    },
    (rig) => {
        A = rig.A;
        B = rig.B;
        raw = rig.raw;
        BASE_URL = rig.BASE_URL;
    },
);

const guard = () => guardApiWithSeams(raw, { lines, runId: RUN, tier: null, env: { BASE_URL } });

async function outcome(call: Promise<unknown>): Promise<RefusalKind | 'sent' | string> {
    try {
        await call;
        return 'sent';
    } catch (e) {
        return e instanceof OwnObjectViolation ? e.kind : `error: ${String(e).slice(0, 160)}`;
    }
}

// TRACE on an own, a foreign and a plain path is sent (a read changes nothing), bodyless, without following anything
test('TRACE on an own, a foreign and a plain path is sent bodyless and follows nothing', async () => {
    const g = guard();
    expect(await outcome(g.fetch(`/api/v1/roles/${OWN_ROLE}`, { method: 'TRACE' }))).toBe('sent');
    expect(await outcome(g.fetch(`/api/v1/roles/${FOREIGN_ROLE}`, { method: 'TRACE' }))).toBe('sent');
    const res = await g.fetch('/api/v1/info', { method: 'trace' });
    expect(res.status()).toBe(400);
    expect(await outcome(g.check('TRACE', '/api/v1/info'))).toBe('sent');
    const traces = A.arrived.filter((a) => a.method === 'TRACE');
    expect(traces.map((a) => a.url)).toEqual([`/api/v1/roles/${OWN_ROLE}`, `/api/v1/roles/${FOREIGN_ROLE}`, '/api/v1/info']);
    expect(traces.every((a) => a.body === '')).toBe(true);
    // The context's own token goes along (the run's identity), never a header the caller added.
    expect(traces.every((a) => a.headers.authorization === 'Bearer SECRET-TOKEN')).toBe(true);
    expect(A.arrived.filter((a) => a.method !== 'TRACE')).toEqual([]);
    expect(B.arrived).toEqual([]);
});

// TRACE with a body, a `//` / dotted / encoded path, another origin, an identity header, identityOverride, text/plain, a
// redirect follow or a _method is refused (request)
test('TRACE with a body, odd path, other origin, identity header, redirect or _method is refused', async () => {
    const g = guard();
    const vectors: Array<[string, () => Promise<unknown>]> = [
        ['a JSON body', () => g.fetch('/api/v1/info', { method: 'TRACE', data: { a: 1 } })],
        ['a string body', () => g.fetch('/api/v1/info', { method: 'TRACE', data: 'x' })],
        ['a Buffer body', () => g.fetch('/api/v1/info', { method: 'TRACE', data: Buffer.from('x') })],
        ['`//` in the path', () => g.fetch('/api/v1//info', { method: 'TRACE' })],
        ['a protocol-relative URL', () => g.fetch(`//127.0.0.1:${B.port}/api/v1/info`, { method: 'TRACE' })],
        ['a dot segment', () => g.fetch('/api/v1/x/../info', { method: 'TRACE' })],
        ['an encoded slash', () => g.fetch('/api/v1%2finfo', { method: 'TRACE' })],
        ['a matrix ;', () => g.fetch('/api/v1/info;x=1', { method: 'TRACE' })],
        ['another origin', () => g.fetch(`${B.origin}/api/v1/info`, { method: 'TRACE' })],
        ['an Authorization header', () => g.fetch('/api/v1/info', { method: 'TRACE', headers: { Authorization: 'Bearer OTHER' } })],
        ['a cookie header', () => g.fetch('/api/v1/info', { method: 'TRACE', headers: { cookie: 'session-id=x' } })],
        ['identityOverride', () => g.fetch('/api/v1/info', { method: 'TRACE', identityOverride: true } as never)],
        ['identityOverride + an identity header', () => g.fetch('/api/v1/info', { method: 'TRACE', identityOverride: true, headers: { Authorization: 'Bearer OTHER' } } as never)],
        ['text/plain', () => g.fetch('/api/v1/info', { method: 'TRACE', headers: { 'Content-Type': 'text/plain' }, data: 'x' })],
        ['text/plain without a body', () => g.fetch('/api/v1/info', { method: 'TRACE', headers: { 'Content-Type': 'text/plain' } })],
        ['maxRedirects > 0', () => g.fetch('/api/v1/redirect-me', { method: 'TRACE', maxRedirects: 1 })],
        ['a _method parameter', () => g.fetch('/api/v1/info?_method=DELETE', { method: 'TRACE' })],
        ['check(): a body', () => g.check('TRACE', '/api/v1/info', { a: 1 })],
        ['an unknown method stays refused', () => g.fetch('/api/v1/info', { method: 'FOO' })],
    ];
    for (const [name, call] of vectors) expect(await outcome(call()), name).toBe('request');
    // The refusal of a bodyless text/plain TRACE is the TRACE rule itself, not the generic "text/plain needs a body" one.
    const textPlain = await g.fetch('/api/v1/info', { method: 'TRACE', headers: { 'Content-Type': 'text/plain' } }).then(() => undefined, (e: unknown) => e);
    expect(String((textPlain as Error | undefined)?.message)).toMatch(/text\/plain on a GET \/ HEAD \/ TRACE/);
    expect(A.arrived, 'nothing refused reached the core').toEqual([]);
    expect(B.arrived, 'nothing reached the other origin').toEqual([]);
});

// TRACE on a side-effect GET path is refused even on an own object; TRACE never follows the 3xx it gets
test('TRACE on a side-effect GET path is refused even on an own object, and never follows the 3xx it gets', async () => {
    const g = guard();
    expect(await outcome(g.fetch(`/api/v1/certificates/${OWN_CERT}/validate`, { method: 'TRACE' }))).toBe('request');
    expect(await outcome(g.fetch(`/api/v1/certificates/${OWN_CERT}/chain`, { method: 'TRACE' }))).toBe('request');
    expect(await outcome(g.fetch('/api/v1/approvals', { method: 'TRACE' }))).toBe('request');
    expect(A.arrived).toEqual([]);
    // A GET of the same own certificate's validation is still judged as before (own: sent).
    expect(await outcome(g.get(`/api/v1/certificates/${OWN_CERT}/validate`))).not.toBe('request');
    A.reset();
    const res = await g.fetch('/api/v1/redirect-me', { method: 'TRACE' });
    expect(res.status()).toBe(302);
    expect(A.arrived.map((a) => `${a.method} ${a.url}`)).toEqual(['TRACE /api/v1/redirect-me']);
});

// TRACE on a mutation path of a foreign object changes nothing: it is sent as TRACE, never as the mutation
test('TRACE on a mutation path of a foreign object changes nothing: sent as TRACE, never as the mutation', async () => {
    const g = guard();
    expect(await outcome(g.fetch(`/api/v1/roles/${FOREIGN_ROLE}`, { method: 'TRACE' }))).toBe('sent');
    expect(await outcome(g.fetch(`/api/v1/roles/${FOREIGN_ROLE}`, { method: 'DELETE' }))).toBe('ownership');
    expect(A.arrived.map((a) => a.method)).toEqual(['TRACE']);
});
