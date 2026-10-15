/**
 * Fix pass after live run 2 (2026-10-15) — unit rows for what that pass added or changed:
 * - the ONE required-custom-attribute helper (`requiredAttributeItems`): version + contentType on every item, one row per content type;
 * - approval status compared case-insensitively (the API says `PENDING`, the UI `Pending`);
 * - the certificates teardown safety net for the `certKey_<CN>` key (`recordCertKeySafetyNet`): a qualifying key is recorded as a derived line
 *   by its WRAPPER uuid; an item uuid (404), a foreign name, a key in a token, a key used by another object are not;
 * - the compliance-profile removal (`removeComplianceProfile`): own RA associations removed, v1 delete, v2 force with the BulkActionMessageDto list;
 * - failures keep their full error text in the cleanup report and the run summary.
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { formatCleanupReport } from '../../utils/cleanupLedger';
import { approvalStatusLabel, sameApprovalStatus } from '../../utils/regression/lifecycle';
import { requestVersion } from '../../utils/regression/attributeVersion';
import { requiredAttributeItems, toRequestAttribute } from '../../utils/regression/regressionApi';
import { findConnectorWithInterface, requestAttributesFrom, secretContentFor, toRequestAttributes } from '../../utils/regression/platformApi';
import { LedgerLine, readLedger, recordCreated, regName, RUN_ID } from '../../utils/regression/regressionRun';
import { deletedBefore, DELETE_ORDER, REFERENCED_BY, runSummary, TeardownContext } from '../../utils/regression/runTeardown';
import { recordCertKeySafetyNet, removeComplianceProfile } from '../../utils/regression/teardownHandlers';

type Json = Record<string, any>;
test.beforeEach(({}, testInfo) => {
    // A ledger of its own per test (the safety-net rows write derived key lines).
    process.env.REG_STATE_DIR = testInfo.outputPath('state');
});

const NOW = new Date('2026-10-15T13:45:56.789Z');
const def = (o: Json): Json => ({ uuid: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'attr', properties: { required: true }, ...o });

test('requiredAttributeItems: version v3 by default (the definition\'s own kept) and the contentType on the attribute AND on every item', () => {
    const out = requiredAttributeItems([def({ contentType: 'string' }), def({ contentType: 'string', version: 'v2', uuid: 'aaaaaaaa-0000-4000-8000-000000000002' })], 'users', 'val', NOW);
    expect(out[0]).toMatchObject({ version: 'v3', contentType: 'string', content: [{ data: 'val', contentType: 'string' }] });
    expect(out[1].version).toBe('v2');
});

test('requiredAttributeItems: one value per content type (string, text, codeblock, integer, float, boolean, date, time, datetime)', () => {
    const data = (contentType: string): unknown => requiredAttributeItems([def({ contentType })], 'groups', 'val', NOW)[0].content[0].data;
    expect(['string', 'text', 'codeblock'].map(data)).toEqual(['val', 'val', 'val']);
    expect(['integer', 'float'].map(data)).toEqual([1, 1]);
    expect(data('boolean')).toBe(true);
    expect(data('date')).toBe('2026-10-15');
    expect(data('time'), 'HH:mm:ss (core TimeAttributeContentV3)').toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(data('time')).toBe('13:45:56');
    expect(data('datetime')).toBe('2026-10-15T13:45:56');
    for (const t of ['time', 'datetime', 'date']) expect(requiredAttributeItems([def({ contentType: t })], 'groups', 'val', NOW)[0].content[0].contentType).toBe(t);
});

test('requiredAttributeItems: a list copies its first predefined item as is and completes the contentType; optional attributes are left out; an unfillable type throws', () => {
    const list = def({ contentType: 'string', properties: { required: true, list: true }, content: [{ reference: 'r1', data: 'd1', contentType: 'string' }, { reference: 'r2', data: 'd2' }] });
    expect(requiredAttributeItems([list], 'users', 'val', NOW)[0].content).toEqual([{ reference: 'r1', data: 'd1', contentType: 'string' }]);
    const noType = def({ contentType: 'string', properties: { required: true, list: true }, content: [{ reference: 'r2', data: 'd2' }] });
    expect(requiredAttributeItems([noType], 'users', 'val', NOW)[0].content).toEqual([{ reference: 'r2', data: 'd2', contentType: 'string' }]);
    expect(requiredAttributeItems([def({ contentType: 'string', properties: { required: false } })], 'users', 'val', NOW)).toEqual([]);
    expect(() => requiredAttributeItems([def({ contentType: 'secret' })], 'users', 'val', NOW)).toThrow(/cannot fill/);
});

test('approval status: the API enum name (PENDING) and the UI label (Pending) are the same status; other statuses are not', () => {
    expect(approvalStatusLabel('PENDING')).toBe('Pending');
    expect(approvalStatusLabel('approved')).toBe('Approved');
    expect(approvalStatusLabel(undefined)).toBe('');
    expect(sameApprovalStatus('PENDING', 'Pending')).toBe(true);
    expect(sameApprovalStatus('REJECTED', 'Pending')).toBe(false);
});

// ------------------------------------------------------------------ fake API for the teardown rows

interface Call { method: string; url: string; data?: unknown }
function fakeApi(handler: (c: Call) => { status: number; body?: unknown }) {
    const calls: Call[] = [];
    const reply = (c: Call) => {
        calls.push(c);
        const r = handler(c);
        return { status: () => r.status, headers: () => ({}), ok: () => r.status >= 200 && r.status < 300, json: async () => r.body, text: async () => JSON.stringify(r.body ?? '') };
    };
    const api = {
        get: async (url: string) => reply({ method: 'GET', url }),
        post: async (url: string, o?: { data?: unknown }) => reply({ method: 'POST', url, data: o?.data }),
        delete: async (url: string, o?: { data?: unknown }) => reply({ method: 'DELETE', url, data: o?.data }),
    };
    return { api, calls };
}
const ctxOf = (api: unknown, ledger: LedgerLine[], warns: string[] = []): TeardownContext =>
    ({ api: api as any, runId: RUN_ID, ledger, seen: new Set(), tier: null, warn: (m) => warns.push(m), pollMs: 1 });

const CERT = 'cccccccc-0000-4000-8000-000000000001';
// Fresh per execution: the unit ledger file persists between runs, and a uuid already in it would count as own.
const WRAPPER = randomUUID();
const ITEM = 'eeeeeeee-0000-4000-8000-000000000001';
const WRAPPER_2 = randomUUID();

test('safety net: the certKey_ key of an own certificate is recorded as a derived line by its WRAPPER uuid (search rows carry item uuids: keyWrapperUuid); an item uuid is never recorded', async () => {
    const cn = regName('net-1');
    const wanted = `certKey_${cn}`;
    const created = new Date().toISOString();
    const { api, calls } = fakeApi((c) => {
        if (c.url === '/api/v1/keys' && c.method === 'POST') return { status: 200, body: { cryptographicKeys: [{ uuid: ITEM, keyWrapperUuid: WRAPPER, name: wanted }] } };
        if (c.url === `/api/v1/certificates/${CERT}/history`) return { status: 200, body: [{ created }] };
        if (c.url === `/api/v1/keys/${WRAPPER}`) return { status: 200, body: { name: wanted, creationTime: created, associations: [{ uuid: CERT }] } };
        if (c.url === `/api/v1/keys/${ITEM}`) return { status: 404, body: {} };
        return { status: 404, body: {} };
    });
    const line = { type: 'certificates', uuid: CERT, name: cn } as LedgerLine;
    const found = await recordCertKeySafetyNet(ctxOf(api, readLedger()), line, { commonName: cn, key: { uuid: ITEM } });
    expect(found, 'the wrapper, not the item').toEqual([WRAPPER]);
    const recorded = readLedger().filter((l) => l.type === 'keys' && l.event === 'created' && l.uuid === WRAPPER);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ derived: true, name: wanted, parents: { certificate: CERT } });
    expect(recorded[0].createdAfter).toBeTruthy();
    expect(readLedger().some((l) => l.uuid === ITEM), 'the item uuid is not in the ledger').toBe(false);
    expect(calls.some((c) => c.method === 'DELETE'), 'the net only records; the keys step deletes').toBe(false);
});

test('safety net: a key in a token, a key used by another object, a foreign name and a certificate without a run-prefixed CN record nothing', async () => {
    const cn = regName('net-2');
    const created = new Date().toISOString();
    const line = { type: 'certificates', uuid: CERT, name: cn } as LedgerLine;
    const run = async (key: Json, cert: Json = { commonName: cn }): Promise<string[]> => {
        const { api } = fakeApi((c) => {
            if (c.url === '/api/v1/keys') return { status: 200, body: { cryptographicKeys: [] } };
            if (c.url.endsWith('/history')) return { status: 200, body: [{ created }] };
            if (c.url === `/api/v1/keys/${WRAPPER_2}`) return { status: 200, body: key };
            return { status: 404, body: {} };
        });
        return recordCertKeySafetyNet(ctxOf(api, readLedger()), line, { ...cert, key: { uuid: WRAPPER_2 } });
    };
    const base = { name: `certKey_${cn}`, creationTime: created, associations: [{ uuid: CERT }] };
    expect(await run({ ...base, tokenInstanceUuid: 'ffffffff-0000-4000-8000-000000000001' })).toEqual([]);
    expect(await run({ ...base, associations: [{ uuid: CERT }, { uuid: 'abababab-0000-4000-8000-000000000001' }] }), 'used by another object').toEqual([]);
    expect(await run({ ...base, name: 'certKey_somebody-elses-cn' })).toEqual([]);
    expect(await run({ ...base, creationTime: new Date(Date.now() - 3_600_000).toISOString() }), 'created long before the certificate').toEqual([]);
    expect(await run(base, { commonName: 'plain.example.test' }), 'no run prefix').toEqual([]);
    expect(readLedger().filter((l) => l.uuid === WRAPPER_2 && l.type === 'keys')).toEqual([]);
});

// ------------------------------------------------------------------ compliance profile removal

const PROFILE = 'bbbbbbbb-0000-4000-8000-000000000001';
const FOREIGN_RA = '12121212-0000-4000-8000-000000000001';

test('removeComplianceProfile: own RA associations are removed (a foreign one is not touched), then DELETE /v1; absence by GET', async () => {
    const ra = recordCreated('raProfiles', { uuid: 'abcabcab-0000-4000-8000-000000000001', name: regName('ra-comp') }, 'T');
    let gone = false;
    const { api, calls } = fakeApi((c) => {
        if (c.method === 'GET' && c.url === `/api/v2/complianceProfiles/${PROFILE}/associations`) return { status: 200, body: [{ resource: 'raProfiles', objectUuid: ra.uuid }, { resource: 'raProfiles', objectUuid: FOREIGN_RA }] };
        if (c.method === 'DELETE' && c.url.includes('/associations/')) return { status: 204 };
        if (c.method === 'DELETE' && c.url === `/api/v1/complianceProfiles/${PROFILE}`) { gone = true; return { status: 204 }; }
        if (c.method === 'GET' && c.url === `/api/v1/complianceProfiles/${PROFILE}`) return gone ? { status: 404, body: {} } : { status: 200, body: {} };
        return { status: 404, body: {} };
    });
    const ctx = ctxOf(api, readLedger());
    ctx.seen.add(PROFILE);
    await removeComplianceProfile(ctx, PROFILE);
    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(deletes).toEqual([`/api/v2/complianceProfiles/${PROFILE}/associations/raProfiles/${ra.uuid}`, `/api/v1/complianceProfiles/${PROFILE}`]);
});

test('removeComplianceProfile: a refused v1 delete falls back to DELETE /v2/complianceProfiles/force [uuid]; a non-empty BulkActionMessageDto list is a failure with its messages', async () => {
    const run = async (forceBody: unknown) => {
        let gone = false;
        const { api, calls } = fakeApi((c) => {
            if (c.url.endsWith('/associations')) return { status: 200, body: [] };
            if (c.method === 'DELETE' && c.url === `/api/v1/complianceProfiles/${PROFILE}`) return { status: 422, body: { message: 'v1 refused' } };
            if (c.method === 'DELETE' && c.url === '/api/v2/complianceProfiles/force') { if (Array.isArray(forceBody) && !forceBody.length) gone = true; return { status: 200, body: forceBody }; }
            if (c.method === 'GET') return gone ? { status: 404, body: {} } : { status: 200, body: {} };
            return { status: 404, body: {} };
        });
        const ctx = ctxOf(api, readLedger());
        ctx.seen.add(PROFILE);
        return { calls, promise: removeComplianceProfile(ctx, PROFILE) };
    };
    const ok = await run([]);
    await ok.promise;
    expect(ok.calls.find((c) => c.url === '/api/v2/complianceProfiles/force')?.data).toEqual([PROFILE]);
    const refused = await run([{ uuid: PROFILE, name: 'own-profile', message: 'Object is associated with other items' }]);
    await expect(refused.promise).rejects.toThrow(/v1 refused.*Object is associated with other items/);
});

// ------------------------------------------------------------------ the full error text stays

test('failures keep the full error text: the cleanup report prints the message under the object line, the run summary lists every failed removal with its text', () => {
    const report = formatCleanupReport([{ resource: 'complianceProfiles', uuid: PROFILE, name: 'own', message: 'Error: Failed to delete compliance profile: 422 - Object is associated with other items' }]);
    expect(report).toContain('no status');
    expect(report).toContain('Object is associated with other items');
    const summary = runSummary('qa-reg-20261015-150211-162d', { deleted: 1, kept: 0, failed: 1 }, { REG_STATE_DIR: '/nonexistent' } as NodeJS.ProcessEnv,
        [{ resource: 'complianceProfiles', uuid: PROFILE, message: 'boom  with\nnewlines' }, { resource: 'keys', uuid: WRAPPER }]);
    expect(summary).toContain(`failed complianceProfiles ${PROFILE}: boom with newlines`);
    expect(summary).toContain(`failed keys ${WRAPPER}: (no error text)`);
});

// ------------------------------------------------------------------ Fable review of the fix pass (F1-F4)

test('F1: the v2 force delete is NOT sent while a foreign association remains (force removes every association); the failure is blocked, names it, and nothing foreign is touched', async () => {
    const ra = recordCreated('raProfiles', { uuid: randomUUID(), name: regName('ra-comp-f1') }, 'T');
    const foreign = '34343434-0000-4000-8000-000000000001';
    const { api, calls } = fakeApi((c) => {
        if (c.method === 'GET' && c.url.endsWith('/associations')) return { status: 200, body: [{ resource: 'raProfiles', objectUuid: ra.uuid }, { resource: 'raProfiles', objectUuid: foreign }] };
        if (c.method === 'DELETE' && c.url.includes('/associations/')) return { status: 204 };
        if (c.method === 'DELETE' && c.url === `/api/v1/complianceProfiles/${PROFILE}`) return { status: 422, body: { message: 'has associations' } };
        if (c.method === 'GET') return { status: 200, body: {} };
        return { status: 404, body: {} };
    });
    const ctx = ctxOf(api, readLedger());
    ctx.seen.add(PROFILE);
    await expect(removeComplianceProfile(ctx, PROFILE)).rejects.toMatchObject({ message: expect.stringMatching(/foreign association left as is/), blockedBy: expect.stringContaining(PROFILE) });
    expect(calls.some((c) => c.url === '/api/v2/complianceProfiles/force'), 'no force while a foreign association remains').toBe(false);
    expect(calls.filter((c) => c.method === 'DELETE' && c.url.includes('/associations/')).map((c) => c.url)).toEqual([`/api/v2/complianceProfiles/${PROFILE}/associations/raProfiles/${ra.uuid}`]);
});

test('F1: an unreadable association list also blocks the force delete', async () => {
    const { api, calls } = fakeApi((c) => {
        if (c.method === 'GET' && c.url.endsWith('/associations')) return { status: 500, body: {} };
        if (c.method === 'DELETE' && c.url === `/api/v1/complianceProfiles/${PROFILE}`) return { status: 422, body: {} };
        return { status: 200, body: {} };
    });
    const ctx = ctxOf(api, readLedger());
    ctx.seen.add(PROFILE);
    await expect(removeComplianceProfile(ctx, PROFILE)).rejects.toThrow(/associations cannot be read/);
    expect(calls.some((c) => c.url === '/api/v2/complianceProfiles/force')).toBe(false);
});

test('F2: the safety net searches the key list with CKI_NAME and warns (not silently skips) on a non-ok answer', async () => {
    const cn = regName('net-f2');
    const bodies: Json[] = [];
    const { api } = fakeApi((c) => {
        if (c.url === '/api/v1/keys' && c.method === 'POST') { bodies.push(c.data as Json); return { status: 400, body: { message: 'unknown field' } }; }
        if (c.url.endsWith('/history')) return { status: 200, body: [{ created: new Date().toISOString() }] };
        return { status: 404, body: {} };
    });
    const warns: string[] = [];
    await recordCertKeySafetyNet(ctxOf(api, readLedger(), warns), { type: 'certificates', uuid: CERT, name: cn } as LedgerLine, { commonName: cn });
    expect(bodies[0].filters[0]).toMatchObject({ fieldIdentifier: 'CKI_NAME', condition: 'EQUALS', value: `certKey_${cn}` });
    expect(warns.some((w) => /key search by name answered 400/.test(w))).toBe(true);
});

test('F3: the CN must carry THIS run\'s prefix (a key named certKey_<unprefixed CN> is never recorded; another run family is not this run)', async () => {
    const created = new Date().toISOString();
    const keyFor = (cn: string): Json => ({ name: `certKey_${cn}`, creationTime: created, associations: [{ uuid: CERT }] });
    const w = randomUUID();
    const attempt = async (cn: string): Promise<string[]> => {
        const { api } = fakeApi((c) => (c.url === `/api/v1/keys/${w}` ? { status: 200, body: keyFor(cn) } : c.url.endsWith('/history') ? { status: 200, body: [{ created }] } : { status: 404, body: {} }));
        return recordCertKeySafetyNet(ctxOf(api, readLedger()), { type: 'certificates', uuid: CERT, name: cn } as LedgerLine, { commonName: cn, key: { uuid: w } });
    };
    expect(await attempt('plain.example.test')).toEqual([]);
    expect(await attempt('qa-reg-20200101-000000-zzzz-other-run.example.test'), 'another run id').toEqual([]);
    expect(await attempt(regName('net-f3'))).toEqual([w]);
});

test('F4: an empty history falls back to the ledger line\'s createdAfter for the time bound, not to now', async () => {
    const cn = regName('net-f4');
    const w = randomUUID();
    const lineBound = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const keyCreated = new Date(Date.now() - 2 * 3_600_000 + 5_000).toISOString(); // made right after the line's bound, hours before "now"
    const { api } = fakeApi((c) => (c.url === `/api/v1/keys/${w}` ? { status: 200, body: { name: `certKey_${cn}`, creationTime: keyCreated, associations: [{ uuid: CERT }] } } : c.url.endsWith('/history') ? { status: 200, body: [] } : { status: 404, body: {} }));
    const found = await recordCertKeySafetyNet(ctxOf(api, readLedger()), { type: 'certificates', uuid: CERT, name: cn, createdAfter: lineBound } as LedgerLine, { commonName: cn, key: { uuid: w } });
    expect(found).toEqual([w]);
    expect(readLedger().find((l) => l.uuid === w && l.type === 'keys')?.createdAfter).toBe(new Date(Date.parse(lineBound) - 60_000).toISOString());
});

// ------------------------------------------------------------------ C12: compliance profiles before RA profiles

test('dangling association: DELETE_ORDER deletes compliance profiles BEFORE RA profiles (a deleted RA profile leaves a dangling association, core suspected defect); the pair is in REFERENCED_BY; approval profiles stay valid', () => {
    expect(deletedBefore('complianceProfiles', 'raProfiles')).toBe(true);
    expect(deletedBefore('raProfiles', 'complianceProfiles')).toBe(false);
    expect(REFERENCED_BY.some((r) => r.a === 'raProfiles' && r.b === 'complianceProfiles' && /suspected defect/.test(r.core))).toBe(true);
    const step = DELETE_ORDER.find((x) => x.types.includes('complianceProfiles'))!;
    expect(step.types.indexOf('complianceProfiles')).toBeLessThan(step.types.indexOf('raProfiles'));
    // The other edges around it hold: certificates → RA profiles, RA profiles → authorities, approval profiles stay after their RA profiles (ungated by the pre-step).
    expect(deletedBefore('certificates', 'raProfiles')).toBe(true);
    expect(deletedBefore('raProfiles', 'authorities')).toBe(true);
    expect(deletedBefore('approvals', 'approvalProfiles')).toBe(true);
});

test('dangling association: a 404 on the compliance profile DELETE is NOT "gone" when the profile is still found: blocked, named, and no force is sent; a 404 confirmed by the re-read is done', async () => {
    const run = async (stillThere: boolean) => {
        const { api, calls } = fakeApi((c) => {
            if (c.method === 'GET' && c.url.endsWith('/associations')) return { status: 200, body: [] };
            if (c.method === 'DELETE' && c.url === `/api/v1/complianceProfiles/${PROFILE}`) return { status: 404, body: { message: 'RA profile not found' } };
            if (c.method === 'GET' && c.url === `/api/v1/complianceProfiles/${PROFILE}`) return stillThere ? { status: 200, body: { uuid: PROFILE } } : { status: 404, body: {} };
            return { status: 404, body: {} };
        });
        const ctx = ctxOf(api, readLedger());
        ctx.seen.add(PROFILE);
        return { calls, promise: removeComplianceProfile(ctx, PROFILE) };
    };
    const dangling = await run(true);
    await expect(dangling.promise).rejects.toMatchObject({ message: expect.stringMatching(/dangling association.*suspected product defect.*left as is/), blockedBy: expect.stringContaining(PROFILE) });
    expect(dangling.calls.some((c) => c.url === '/api/v2/complianceProfiles/force'), 'never a force path').toBe(false);
    const gone = await run(false);
    await gone.promise;
    expect(gone.calls.some((c) => c.url === '/api/v2/complianceProfiles/force')).toBe(false);
});

// ------------------------------------------------------------------ live run 3: version is a NUMBER on the wire

test('G1: requestVersion turns core\'s NUMERIC definition version (3 / 2) and the string forms into "v3" / "v2"; absent follows the fallback', () => {
    expect([3, '3', 'v3', 'V3'].map((v) => requestVersion({ version: v }))).toEqual(['v3', 'v3', 'v3', 'v3']);
    expect([2, '2', 'v2'].map((v) => requestVersion({ version: v }))).toEqual(['v2', 'v2', 'v2']);
    expect(requestVersion({})).toBe('v2');
    expect(requestVersion(undefined, 'v3')).toBe('v3');
    expect(requestVersion({ version: 7 }, 'v3')).toBe('v3');
});

test('G1: every helper that copies a definition sends the STRING version (numeric fixtures, as core sends them)', () => {
    const required = requiredAttributeItems([def({ contentType: 'string', version: 3 }), def({ contentType: 'string', version: 2, uuid: 'aaaaaaaa-0000-4000-8000-000000000002' }), def({ contentType: 'string', uuid: 'aaaaaaaa-0000-4000-8000-000000000003' })], 'users', 'v', NOW);
    expect(required.map((a) => a.version)).toEqual(['v3', 'v2', 'v3']);
    expect(toRequestAttribute({ version: 3, uuid: 'u', name: 'n', contentType: 'string', content: [] }).version).toBe('v3');
    expect(toRequestAttribute({ version: 2, uuid: 'u', name: 'n', contentType: 'string', content: [] }).version).toBe('v2');
    expect(toRequestAttributes([{ version: 3, uuid: 'u', name: 'n', contentType: 'string', content: [], type: 'data' }])[0].version).toBe('v3');
    const filled = requestAttributesFrom([{ name: 'a', uuid: 'u', contentType: 'string', type: 'data', version: 3, properties: { required: true } } as any]);
    expect(filled[0].version).toBe('v3');
    for (const a of [...required, ...filled]) expect(typeof a.version, 'never a number on the wire').toBe('string');
});

test('G3: core\'s secret body (secret polymorphic on type), and the credential provider v2 is found by either spelling', async () => {
    expect(secretContentFor('generic', 'val')).toEqual({ type: 'generic', content: 'val' });
    expect(secretContentFor('apiKey', 'val')).toEqual({ type: 'apiKey', content: 'val' });
    const generated = `qa-${randomUUID().slice(0, 8)}`;
    expect(secretContentFor('basicAuth', generated)).toEqual({ type: 'basicAuth', username: 'qa', password: generated });
    const rows = [
        { uuid: 'c1', name: 'Other-Provider', status: 'connected', functionGroups: [] },
        { uuid: 'c2', name: 'Common-Credential-Connector v2', status: 'connected', functionGroups: [{ functionGroupCode: 'credentialProvider' }] },
    ];
    const { api } = fakeApi((c) => {
        if (c.url === '/api/v1/connectors') return { status: 200, body: rows };
        if (c.url === '/api/v2/connectors/c1') return { status: 200, body: { interfaces: [{ uuid: 'i1', code: 'secret' }] } };
        if (c.url === '/api/v2/connectors/c2') return { status: 200, body: { interfaces: [{ uuid: 'i2', code: 'secret' }] } };
        return { status: 404, body: {} };
    });
    const found = await findConnectorWithInterface(api as any, /^secret/i, {} as NodeJS.ProcessEnv);
    expect(found, 'the space-spelled credential provider wins over the first connected connector').toMatchObject({ uuid: 'c2', interfaceUuid: 'i2' });
});
