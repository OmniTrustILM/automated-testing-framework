/**
 * The requests of the import, inspection and upload specs on the wire: sent through a real request context to a
 * loopback fake core (127.0.0.1), each test asserts what arrived, and `judge.check(...)` shows without sending what the
 * guard decides (uploads and body-judged creates pass, a key destination entry is refused).
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { GuardedApi } from '../../utils/regression/guard/types';
import { guardVerdict, GuardVerdict } from './helpers/guardVerdict';
import { isolation, propertyFilter, searchPage, send } from '../../utils/regression/inventory/searchApi';
import { certificate, csrPem, garbageBytes, importBody, importCn, inspectionBody, paddedCertificatePem, pkcs12, pkcs7Der, pkcs7Pem, ROUTES, uploadBody } from '../../utils/regression/inventory/importFixtures';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { findByName } from '../../utils/regression/listReads';
import { runId } from '../../utils/regression/ledger/runState';
import { UPLOAD_ROUTES, uploadBody as uploadBody2 } from '../../utils/regression/inventory/errorCases/uploads';
import { Arrived, LoopbackServer } from './helpers/loopbackServer';
import { registerFakeCore } from './helpers/guardRig';
import { randomBytes } from 'node:crypto';
// Run-scoped generated test passwords (merge follow-up 2026-10-15): no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;

test.describe.configure({ timeout: 60_000 });

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUTHORITY = U(11);

let server: LoopbackServer;
let raw: APIRequestContext;
let api: GuardedApi;
let judge: GuardVerdict;

const answer = (a: Arrived) => {
    const path = a.url.split('?')[0];
    if (a.method === 'POST' && path === ROUTES.upload) return { status: 201, body: { uuid: U(21) } };
    if (a.method === 'POST' && path === ROUTES.uploadAsync) return { status: 202, body: { fingerprint: 'ab'.repeat(32) } };
    if (a.method === 'POST' && path === '/api/v1/certificates') return { status: 200, body: { certificates: [], itemsPerPage: 10, pageNumber: 1, totalPages: 0, totalItems: 0 } };
    if (a.method === 'POST' && path === `/api/v1/authorities/${AUTHORITY}/raProfiles`) return { status: 422, body: ['Required attribute Certificate Template not found.'] };
    if (a.method === 'GET' && path === '/api/v1/raProfiles') return { status: 200, body: [{ uuid: U(30), name: 'someone-elses-ra' }] };
    return { status: 404, body: { message: 'not found' } };
};

registerFakeCore(() => ({ answer }), (rig) => ({ server, raw, api } = rig), { clear: [] });
test.beforeEach(() => {
    judge = guardVerdict(raw);
});

const kindOf = async (p: Promise<unknown>): Promise<string> => p.then(() => 'sent', (e: unknown) => (e instanceof OwnObjectViolation ? e.kind : `error: ${String(e).slice(0, 160)}`));

test('every upload body the specs build passes the guard and arrives as one JSON POST to the upload route (create list)', async () => {
    const id = certificate(importCn('wire'));
    const files: Record<string, Buffer> = {
        pem: Buffer.from(id.pem),
        der: id.der,
        'pkcs7-pem': Buffer.from(pkcs7Pem([id])),
        'pkcs7-der': pkcs7Der([id]),
        pkcs12: pkcs12(importCn('wire-p12'), GEN_PW_1).bytes,
        csr: Buffer.from(csrPem(importCn('wire-csr')).pem),
        garbage: garbageBytes(),
    };
    for (const [name, file] of Object.entries(files)) {
        const body = uploadBody(file, [{ uuid: U(77), name: 'required-attr', contentType: 'string', content: [{ data: 'qa' }] }]);
        await judge.check('POST', ROUTES.upload, body);
        await judge.check('POST', ROUTES.uploadAsync, body);
        const sent = await send(api, 'POST', ROUTES.upload, { data: body });
        expect(sent.status, name).toBe(201);
    }
    const arrived = server.mutations();
    expect(arrived.map((a) => `${a.method} ${a.url}`)).toEqual(Object.keys(files).map(() => `POST ${ROUTES.upload}`));
    arrived.forEach((a, i) => {
        expect(a.headers['content-type'], 'JSON body').toMatch(/application\/json/);
        expect(JSON.parse(a.body)).toEqual({ certificate: files[Object.keys(files)[i]].toString('base64'), customAttributes: expect.any(Array) });
    });
    // The asynchronous route too.
    server.reset();
    const async = await send(api, 'POST', ROUTES.uploadAsync, { data: uploadBody(files.pem, []) });
    expect(async.status).toBe(202);
    expect(async.json).toEqual({ fingerprint: 'ab'.repeat(32) });
    expect(server.mutations().map((a) => `${a.method} ${a.url}`)).toEqual([`POST ${ROUTES.uploadAsync}`]);
});

test('a 16-byte garbage file is the one upload body the guard refuses (its base64 is a padded 22-character uuid token); 64 bytes pass', async () => {
    expect(await kindOf(judge.check('POST', ROUTES.upload, uploadBody(garbageBytes(16), [])))).toBe('request');
    expect(await kindOf(judge.check('POST', ROUTES.upload, uploadBody(garbageBytes(64), [])))).toBe('sent');
    expect(server.arrived).toEqual([]);
});

test('the guard judges POST /v1/inspections and POST /v1/certificates/import by their body as creates: the specs\' shapes pass, a keyDestination entry (any case) and a stray top-level key are still refused (kind request)', async () => {
    const id = certificate(importCn('wire-refused'));
    const inspect = inspectionBody(Buffer.from(id.pem));
    const imp = importBody(Buffer.from(id.pem), [id.fingerprint]);
    // Before the guard change both routes were refused outright (the old pin of this test); the change made them creates.
    expect(await kindOf(judge.check('POST', ROUTES.inspect, inspect))).toBe('sent');
    expect(await kindOf(judge.check('POST', ROUTES.import, imp))).toBe('sent');
    expect(await kindOf(send(api, 'POST', ROUTES.inspect, { data: inspect }))).toBe('sent');
    expect(await kindOf(send(api, 'POST', ROUTES.import, { data: imp }))).toBe('sent');
    // The other API-CERT-65 inspection shapes (garbage, missing, empty file, a plain-string token profile) are sent too: only the
    // tokenProfileUuid is typed (own / probe / absent / plain string), the file content is never judged.
    for (const body of [inspectionBody({ raw: '***' }), inspectionBody(undefined), inspectionBody(Buffer.alloc(0)), inspectionBody(Buffer.from(id.pem), { tokenProfileUuid: 'not-a-uuid' })]) {
        expect(await kindOf(judge.check('POST', ROUTES.inspect, body))).toBe('sent');
    }
    expect(server.arrived.map((a) => `${a.method} ${a.url}`)).toEqual([`POST ${ROUTES.inspect}`, `POST ${ROUTES.import}`]);
    // Shape rule: an entry naming a key destination (any case, anywhere) would write into a pre-existing token: refused.
    const withDestination = { ...imp, entries: [{ entryReference: id.fingerprint, keyDestination: { tokenProfileUuid: U(77) } }] };
    expect(await kindOf(judge.check('POST', ROUTES.import, withDestination))).toBe('request');
    expect(await kindOf(judge.check('POST', ROUTES.import, { ...imp, KeyDestination: null }))).toBe('request');
    expect(await kindOf(judge.check('POST', ROUTES.import, { ...imp, surprise: 1 }))).toBe('request');
    expect(server.arrived).toHaveLength(2);
});

test('un-fixme follow-up (API-GEN-03 / API-GEN-07 / API-GEN-15): the size-row bodies (5 MiB, 5 MiB + 1, 6 MiB) of both upload routes, the sentinel method QAPROBE and the two no-handler pairs pass the guard; PROPFIND stays refused', async () => {
    for (const route of ['inspections', 'import'] as const) {
        for (const bytes of [5 * 1024 * 1024, 5 * 1024 * 1024 + 1, 6 * 1024 * 1024]) {
            expect(await kindOf(judge.check('POST', UPLOAD_ROUTES[route], uploadBody2(route, bytes))), `${route} ${bytes}`).toBe('sent');
        }
    }
    expect(await kindOf(judge.check('QAPROBE', '/api/v1/groups'))).toBe('sent');
    expect(await kindOf(judge.check('POST', '/api/v1/statistics'))).toBe('sent');
    expect(await kindOf(judge.check('DELETE', '/api/v1/info'))).toBe('sent');
    expect(await kindOf(judge.check('PROPFIND', '/api/v1/groups'))).toBe('request');
    expect(server.arrived).toEqual([]);
});

test('REG-CERT-68: the RA-profile create under a foreign authority (scope parent) is a create the guard sends; the 422 comes back as a JSON array; the list by name is a read', async () => {
    const name = importCn('wire-ra').replace('-imp-', '-form-val-api-');
    const created = await send(api, 'POST', `/api/v1/authorities/${AUTHORITY}/raProfiles`, {
        data: { name, description: `REG run ${runId()}`, attributes: [], customAttributes: [{ uuid: U(78), name: 'dept', contentType: 'string', content: [{ data: 'qa' }] }] },
    });
    expect(created.status).toBe(422);
    expect(created.json).toEqual(['Required attribute Certificate Template not found.']);
    expect(server.mutations().map((a) => `${a.method} ${a.url}`)).toEqual([`POST /api/v1/authorities/${AUTHORITY}/raProfiles`]);
    expect(await findByName(api, '/api/v1/raProfiles', name)).toBeUndefined();
});

test('the look-ups after a refusal are reads: search by common-name prefix, by exact name and by fingerprint (POST_READ), nothing else leaves', async () => {
    const found = await searchPage(api, { filters: [isolation(importCn('wire-look'))], itemsPerPage: 10, pageNumber: 1, includeArchived: true });
    expect(found.totalItems).toBe(0);
    await searchPage(api, { filters: [propertyFilter('COMMON_NAME', 'EQUALS', 'x')], itemsPerPage: 10, pageNumber: 1, includeArchived: true });
    await searchPage(api, { filters: [propertyFilter('FINGERPRINT', 'EQUALS', 'ab'.repeat(32))], itemsPerPage: 10, pageNumber: 1, includeArchived: true });
    expect(server.arrived.map((a) => `${a.method} ${a.url}`)).toEqual(Array(3).fill('POST /api/v1/certificates'));
    const bodies = server.arrived.map((a) => JSON.parse(a.body).filters[0]);
    expect(bodies[0]).toMatchObject({ fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH' });
    expect(bodies[2]).toMatchObject({ fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS' });
});

test('the 5 MiB padded file is built in memory for the browser only: its base64 body (~7 MB) is never sent through the API guard in these specs, but the guard accepts a body of that size on the upload route (create list), so no spec needs a bypass', async () => {
    const { file } = paddedCertificatePem(importCn('wire-big'), 5 * 1024 * 1024);
    await judge.check('POST', ROUTES.upload, uploadBody(file, []));
    expect(server.arrived).toEqual([]);
});
