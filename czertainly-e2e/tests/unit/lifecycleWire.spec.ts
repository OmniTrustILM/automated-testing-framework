/**
 * lifecycleWire — loopback wire check of the lifecycle helpers.
 *
 * Checks that issue, renew, rekey, revoke, register and the parked-operation probes on OWN certificates are sent with
 * their bodies and record what they made before any assertion; that foreign objects and raw contexts are refused before
 * anything leaves; and that the approval gate, the override decisions and the teardown handlers of approvals and approval
 * profiles send what the rules say. These helpers act on a shared tier, so what they send and record is proven offline.
 * One stateful fake core sits behind a loopback server; each test asserts the requests that arrived and the ledger.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { GuardedApi } from '../../utils/regression/guard/types';
import { decideApproval, dissociateApprovalProfile, ensureApprovalProfile, findApproval, openApprovalGate } from '../../utils/regression/lifecycle/approvals';
import { cancelPending, confirmRevoke, finalizeIssue, issueExisting, observeStatesUntil, rekeyOwnCertificate, renewOwnCertificate, revokeOwnCertificate } from '../../utils/regression/lifecycle/certificateOperations';
import { teardownHandlers } from '../../utils/regression/lifecycle/lifecycleTeardown';
import { registerOwnCertificate } from '../../utils/regression/lifecycle/preRegistration';
import { submitOwnCertificate } from '../../utils/regression/ownCertificates';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { csrFromKey } from '../../utils/regression/pkiBuilders';
import { ensureRunRaProfile } from '../../utils/regression/ownRaProfiles';
import { OwnRef, readLedger, recordCreated } from '../../utils/regression/ledger/ledger';
import { readRunState, runName, runId } from '../../utils/regression/ledger/runState';
import type { TeardownContext } from '../../utils/regression/teardown/runTeardown';
import { Answer, Arrived, LoopbackServer } from './helpers/loopbackServer';
import { FakeCore as BaseCore } from './helpers/fakeCore';
import { registerFakeCore, rawAsGuarded } from './helpers/guardRig';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C_EJBCA = U(2);
const A_EJBCA = U(12);
const R_SRC = U(21);
const FOREIGN_CERT = U(31);
const FOREIGN_APPROVAL = U(32);
const ROLE_FOREIGN = U(33);
const CN_ATTR = '9abaeba0-973d-11ed-a8fc-0242ac120002';

type Json = Record<string, any>;

/** A fake core that remembers what the run created and serves a fixed EJBCA-NG tier around it. */
class LifecycleCore extends BaseCore {
    protected seq = 1000;
    /** approvals by certificate uuid */
    readonly approvals = new Map<string, Json>();
    approvalProfileDeleteStatus = 204;
    associations: Json[] = [];

    /** Answer without a Date header (the bound of a derived object then comes from the runner clock). */
    noDate = false;

    protected respond(a: Arrived): Answer | undefined {
        const out = this.routeRequest(a);
        return out && this.noDate ? { ...out, noDate: true } : out;
    }

    private routeRequest = (a: Arrived): Answer | undefined => {
        const path = a.url.split('?')[0];
        const body = a.body ? (JSON.parse(a.body) as Json) : undefined;
        if (a.method === 'GET') return this.get(path);
        if (a.method === 'POST') return this.post(path, body);
        if (a.method === 'PATCH') return this.patch(path);
        if (a.method === 'DELETE') return this.del(path);
        return { status: 405 };
    };

    private get(path: string): Answer {
        let m: RegExpExecArray | null;
        const fixed: Record<string, unknown> = {
            '/api/v1/connectors': [{ uuid: C_EJBCA, name: 'EJBCA-NG-Connector', status: 'connected' }],
            [`/api/v2/connectors/${C_EJBCA}`]: { uuid: C_EJBCA, name: 'EJBCA-NG-Connector', version: 'v1' },
            [`/api/v1/connectors/${C_EJBCA}/health`]: { status: 'ok' },
            '/api/v1/authorities': [{ uuid: A_EJBCA, name: 'ejbca-ca', connectorUuid: C_EJBCA, connectorName: 'EJBCA-NG-Connector', status: 'connected' }],
            [`/api/v1/authorities/${A_EJBCA}`]: { uuid: A_EJBCA, connectorName: 'EJBCA-NG-Connector' },
            '/api/v1/raProfiles': [{ uuid: R_SRC, name: 'source-ra', authorityInstanceUuid: A_EJBCA, enabled: true }],
            [`/api/v1/authorities/${A_EJBCA}/raProfiles/${R_SRC}`]: { uuid: R_SRC, name: 'source-ra', attributes: [{ version: 2, uuid: U(41), name: 'ee', type: 'data', contentType: 'string', content: [{ data: 'EE' }] }] },
            '/api/v1/attributes/custom/resources/raProfiles': [],
            '/api/v1/attributes/custom/resources/roles': [],
            '/api/v1/roles': [{ uuid: ROLE_FOREIGN, name: 'Administrators' }, ...[...this.store.values()].filter((o) => o.kind === 'role')],
            '/api/v1/certificates/csr/attributes': [{ version: 3, uuid: CN_ATTR, name: 'commonName', contentType: 'string' }],
            '/api/v1/settings/platform': { certificates: { registration: { defaultIssuanceWindowDays: 7, maxFailedAttempts: 5 } } },
            [`/api/v1/certificates/${FOREIGN_CERT}`]: { uuid: FOREIGN_CERT, commonName: 'someone-else.example.test', state: 'issued' },
            [`/api/v1/approvals/${FOREIGN_APPROVAL}`]: { approvalUuid: FOREIGN_APPROVAL, status: 'Pending' },
        };
        if (Object.hasOwn(fixed, path)) return { status: 200, body: fixed[path] };
        if ((m = /^\/api\/v1\/certificates\/([0-9a-f-]{36})\/approvals$/.exec(path))) {
            const ap = this.approvals.get(m[1]);
            return { status: 200, body: { approvals: ap ? [ap] : [], totalItems: ap ? 1 : 0 } };
        }
        if ((m = /^\/api\/v1\/approvals\/([0-9a-f-]{36})$/.exec(path))) {
            const ap = [...this.approvals.values()].find((x) => x.approvalUuid === m![1]);
            return ap ? { status: 200, body: { ...ap, approvalSteps: [{ approvalStepRecipients: [{ comment: ap.status === 'Pending' ? null : 'Approval flow overridden' }] }] } } : { status: 404, body: { message: 'not found' } };
        }
        if ((m = /^\/api\/v1\/approvalProfiles\/([0-9a-f-]{36})\/associations$/.exec(path))) return { status: 200, body: this.associations };
        const stored = this.store.get(path);
        return stored ? { status: 200, body: stored } : { status: 404, body: { message: 'not found' } };
    }

    private post(path: string, body: Json | undefined): Answer {
        let m: RegExpExecArray | null;
        const uuid = this.next();
        if ((m = /^\/api\/v1\/authorities\/([0-9a-f-]{36})\/raProfiles$/.exec(path))) {
            const ra = { kind: 'ra', uuid, name: body?.name, authorityInstanceUuid: m[1], enabled: false };
            this.store.set(`/api/v1/raProfiles/${uuid}`, ra);
            this.store.set(`/api/v1/authorities/${m[1]}/raProfiles/${uuid}`, { ...ra, attributes: body?.attributes ?? [] });
            return { status: 200, body: { uuid, name: body?.name } };
        }
        if (path === '/api/v1/roles') {
            this.store.set(`/api/v1/roles/${uuid}`, { kind: 'role', uuid, name: body?.name });
            return { status: 200, body: { uuid } };
        }
        if (path === '/api/v1/approvalProfiles') {
            this.store.set(`/api/v1/approvalProfiles/${uuid}`, { kind: 'ap', uuid, name: body?.name, steps: body?.approvalSteps });
            return { status: 200, body: { uuid } };
        }
        const ops = /^\/api\/v2\/operations\/authorities\/([0-9a-f-]{36})\/raProfiles\/([0-9a-f-]{36})\/certificates(?:\/([0-9a-f-]{36}))?(?:\/([a-z/]+))?$/.exec(path);
        if (ops) {
            const [, , raUuid, certUuid, op] = ops;
            const gate = this.associations.find((x) => x.objectUuid === raUuid);
            const gated = !!gate;
            const create = (cn: string, state: string) => {
                const cert = { uuid, commonName: cn, state, raProfile: { uuid: raUuid } };
                this.store.set(`/api/v1/certificates/${uuid}`, cert);
                // ApprovalDto (core Approval.java:91-106): resource, objectUuid and the approval profile of the gate.
                if (gated) this.approvals.set(uuid, { approvalUuid: this.next(), status: 'Pending', resource: 'certificates', objectUuid: uuid, resourceAction: 'issue', approvalProfileUuid: gate!.approvalProfileUuid });
                return { status: 200, body: { certificateData: '', uuid, requestAttributeWarnings: [] } };
            };
            if (!certUuid && !op) return create(cnOf(body), gated ? 'pending_approval' : 'issued');
            // core reads a v3 content item by its own contentType (BaseAttributeContentV3, no default subtype): without it the body is
            // unreadable
            if (!certUuid && op === 'register' && (body?.csrAttributes ?? []).some((a: any) => a?.version === 'v3' && (a.content ?? []).some((c: any) => !c?.contentType))) return { status: 400, body: { message: 'Unable to read HTTP message' } };
            if (!certUuid && op === 'register') return create(String(body?.csrAttributes?.[0]?.content?.[0]?.data ?? ''), 'registered');
            const cert = this.store.get(`/api/v1/certificates/${certUuid}`);
            if (!cert) return { status: 404, body: { message: `Object of type 'Certificate' identified by ${certUuid} is not found.` } };
            if (op === 'renew' || op === 'rekey') return cert.state === 'issued' ? create(cert.commonName, 'issued') : { status: 422, body: [`Cannot perform operation ${op} on certificate in state Revoked. Certificate: x`] };
            if (op === 'revoke') {
                if (cert.state === 'revoked') return { status: 422, body: ['Certificate is already revoked. Certificate: x'] };
                cert.state = 'revoked';
                return { status: 204 };
            }
            if (op === 'issue') return cert.state === 'registered' && body?.request ? ((cert.state = 'issued'), { status: 200, body: { uuid: certUuid, certificateData: '' } }) : { status: 422, body: ['Cannot issue certificate with state Issued. Certificate: x'] };
            if (op === 'issue/finalize') return { status: 422, body: ['Cannot finalize issuance: certificate is not in PENDING_ISSUE. Current state: Issued. Certificate: x'] };
            if (op === 'revoke/confirm') return { status: 422, body: ['Cannot confirm revocation: certificate is not in PENDING_REVOKE. Current state: Issued. Certificate: x'] };
            if (op === 'cancel') return { status: 422, body: ['Cannot cancel: certificate is not in a pending state. Current state: Issued. Certificate: x'] };
        }
        return { status: 404, body: { message: `no fake route POST ${path}` } };
    }

    private patch(path: string): Answer {
        let m: RegExpExecArray | null;
        if ((m = /^\/api\/v1\/approvalProfiles\/([0-9a-f-]{36})\/associations\/raProfiles\/([0-9a-f-]{36})$/.exec(path))) {
            this.associations.push({ resource: 'raProfiles', objectUuid: m[2], name: 'ra', approvalProfileUuid: m[1] });
            return { status: 204 };
        }
        if ((m = /^\/api\/v1\/approvals\/([0-9a-f-]{36})\/(approve|reject)$/.exec(path))) {
            const ap = [...this.approvals.values()].find((x) => x.approvalUuid === m![1]);
            if (!ap) return { status: 404, body: { message: 'not found' } };
            ap.status = m[2] === 'approve' ? 'Approved' : 'Rejected';
            const cert = this.store.get(`/api/v1/certificates/${ap.objectUuid}`);
            if (cert) cert.state = m[2] === 'approve' ? 'issued' : 'rejected';
            return { status: 204 };
        }
        if (/\/enable$/.test(path)) return { status: 204 };
        return { status: 404, body: { message: `no fake route PATCH ${path}` } };
    }

    private del(path: string): Answer {
        let m: RegExpExecArray | null;
        if ((m = /^\/api\/v1\/approvalProfiles\/([0-9a-f-]{36})\/associations\/raProfiles\/([0-9a-f-]{36})$/.exec(path))) {
            const before = this.associations.length;
            this.associations = this.associations.filter((x) => x.objectUuid !== m![2]);
            return { status: before === this.associations.length ? 404 : 204 };
        }
        if ((m = /^\/api\/v1\/approvalProfiles\/([0-9a-f-]{36})$/.exec(path))) {
            if (this.approvalProfileDeleteStatus !== 204) return { status: this.approvalProfileDeleteStatus, body: ['Unable to delete approval profile with existing approvals.'] };
            this.store.delete(`/api/v1/approvalProfiles/${m[1]}`);
            return { status: 204 };
        }
        return { status: 404, body: { message: `no fake route DELETE ${path}` } };
    }
}

/** The CN of a v2 issue body: the fake reads it from the CSR (the helper's CN is run-prefixed). */
function cnOf(body: Json | undefined): string {
    const csr = require('node-forge').pki.certificationRequestFromPem(`-----BEGIN CERTIFICATE REQUEST-----\n${String(body?.request ?? '')}\n-----END CERTIFICATE REQUEST-----`);
    return csr.subject.getField('CN').value as string;
}

let server: LoopbackServer;
let core: LifecycleCore;
let raw: APIRequestContext;
let api: GuardedApi;

registerFakeCore(() => core, (rig) => ({ server, raw, api } = rig), { env: { REG_CA_CONNECTORS: 'EJBCA-NG-Connector' }, clear: ['REG_RA_PROFILE_NAME', 'REG_ADCS_CONNECTOR'] });
test.beforeEach(() => {
    core = new LifecycleCore();
});

const wire = () => server.mutations().map((a) => `${a.method} ${a.url}`);
const bodyOf = (method: string, url: string): Json => JSON.parse(server.arrived.find((a) => a.method === method && a.url === url)!.body);

async function refusal(call: Promise<unknown>): Promise<string> {
    try {
        await call;
        return 'sent';
    } catch (e) {
        return e instanceof OwnObjectViolation ? e.kind : `error: ${String(e).slice(0, 160)}`;
    }
}

test('issue, renew, rekey, revoke, issue-existing and the parked-operation probes go through the guard on an OWN certificate with the rule bodies; the successor is recorded with its predecessor', async () => {
    const ra = await ensureRunRaProfile(api, 'T');
    server.reset();
    const cert = await submitOwnCertificate(api, ra, 'T', { suffix: 'wire' });
    expect(cert.answer.status).toBe(200);
    expect(cert.createdAfter, 'the bound of the derived key, from the Date header').toBeTruthy();
    expect(cert.cn.startsWith(`${runId()}-wire-`)).toBe(true);
    const issueBody = bodyOf('POST', `/api/v2/operations/authorities/${A_EJBCA}/raProfiles/${ra.uuid}/certificates`);
    expect(issueBody).toMatchObject({ format: 'pkcs10', attributes: [], customAttributes: [] });
    expect(readLedger().find((l) => l.uuid === cert.uuid)).toMatchObject({ type: 'certificates', name: cert.cn, parents: { raProfile: ra.uuid, authority: A_EJBCA } });
    // An answer without a Date header: the bound is one the teardown keeps, a day ahead of the runner clock (never undefined).
    core.noDate = true;
    const startedAt = Date.now();
    const noDate = await submitOwnCertificate(api, ra, 'T', { suffix: 'nodate' });
    core.noDate = false;
    expect(noDate.answer.serverAt).toBeUndefined();
    expect(Date.parse(noDate.createdAfter!)).toBeGreaterThan(startedAt + 3_600_000);
    expect(Date.parse(noDate.createdAfter!)).toBeLessThanOrEqual(Date.now() + 25 * 3_600_000);
    server.reset();

    const csr = csrFromKey(cert.keys, cert.cn, cert.sans);
    const renew = await renewOwnCertificate(api, cert, ra, 'T', { csrDerBase64: csr.derBase64 });
    expect(renew.status).toBe(200);
    expect(renew.successor).toBeTruthy();
    expect(bodyOf('POST', `/api/v2/operations/authorities/${A_EJBCA}/raProfiles/${ra.uuid}/certificates/${cert.uuid}/renew`)).toEqual({ format: 'pkcs10', attributes: [], request: csr.derBase64 });
    // Mutant: a challenge given to renewOwnCertificate travels in the body, an omitted one sends no field.
    server.reset();
    await renewOwnCertificate(api, cert, ra, 'T', { authorizationSecret: 'qa-wire-secret-0002' });
    expect(bodyOf('POST', `/api/v2/operations/authorities/${A_EJBCA}/raProfiles/${ra.uuid}/certificates/${cert.uuid}/renew`)).toEqual({ format: 'pkcs10', attributes: [], authorizationSecret: 'qa-wire-secret-0002' });
    await renewOwnCertificate(api, cert, ra, 'T', {});
    expect(server.mutations().filter((m) => m.url.endsWith('/renew')).map((m) => JSON.parse(m.body))[1]).toEqual({ format: 'pkcs10', attributes: [] });
    server.reset();
    expect(readLedger().find((l) => l.uuid === renew.successor!.uuid)).toMatchObject({ type: 'certificates', name: cert.cn, parents: { predecessor: cert.uuid, raProfile: ra.uuid } });
    const rekey = await rekeyOwnCertificate(api, cert, ra, 'T', { csrDerBase64: csr.derBase64 });
    expect(rekey.status).toBe(200);
    expect(bodyOf('POST', `/api/v2/operations/authorities/${A_EJBCA}/raProfiles/${ra.uuid}/certificates/${cert.uuid}/rekey`)).toEqual({ request: csr.derBase64, format: 'pkcs10', attributes: [] });
    for (const probe of [finalizeIssue, confirmRevoke, cancelPending]) expect((await probe(api, cert, ra)).status).toBe(422);
    expect((await issueExisting(api, cert, ra, {})).status).toBe(422);
    const revoke = await revokeOwnCertificate(api, cert, ra, { reason: 'keyCompromise' });
    expect(revoke.status).toBe(204);
    expect(revoke.text).toBe('');
    expect(bodyOf('POST', `/api/v2/operations/authorities/${A_EJBCA}/raProfiles/${ra.uuid}/certificates/${cert.uuid}/revoke`)).toEqual({ attributes: [], destroyKey: false, reason: 'keyCompromise' });
    expect((await revokeOwnCertificate(api, cert, ra)).status, 'the second revoke is refused by the fake like core').toBe(422);
    const sent = wire();
    // rekey, the three parked-operation probes, issue-existing and the two revokes (the renews were reset above).
    expect(sent.filter((w) => w.includes(cert.uuid))).toHaveLength(7);
});

test('observeStatesUntil records the distinct states in order and fails fast on failed / rejected', async () => {
    const ra = await ensureRunRaProfile(api, 'T');
    const cert = await submitOwnCertificate(api, ra, 'T', { suffix: 'obs' });
    const live = core.store.get(`/api/v1/certificates/${cert.uuid}`)!;
    live.state = 'issued';
    expect((await observeStatesUntil(api, cert.uuid, 'issued', 5_000)).states).toEqual(['issued']);
    live.state = 'failed';
    await expect(observeStatesUntil(api, cert.uuid, 'issued', 5_000)).rejects.toThrow(/reached failed instead of issued/);
    live.state = 'rejected';
    await expect(observeStatesUntil(api, cert.uuid, 'issued', 5_000)).rejects.toThrow(/reached rejected/);
    live.state = 'requested';
    await expect(observeStatesUntil(api, cert.uuid, 'issued', 1_500)).rejects.toThrow(/did not reach issued within 1500 ms \(observed requested\)/);
});

test('the same calls on a FOREIGN certificate are refused by the helper (ownership) and by the guard; nothing is sent', async () => {
    const ra = await ensureRunRaProfile(api, 'T');
    server.reset();
    const foreign = { uuid: FOREIGN_CERT, name: 'someone-else.example.test', kind: 'own' } as OwnRef;
    expect(await refusal(renewOwnCertificate(api, foreign, ra, 'T', {}))).toBe('ownership');
    expect(await refusal(revokeOwnCertificate(api, foreign, ra))).toBe('ownership');
    expect(await refusal(issueExisting(api, foreign, ra, {}))).toBe('ownership');
    expect(await refusal(api.post(`/api/v2/operations/authorities/${A_EJBCA}/raProfiles/${ra.uuid}/certificates/${FOREIGN_CERT}/renew`, { data: { attributes: [] } }))).toBe('ownership');
    expect(await refusal(decideApproval(api, { uuid: FOREIGN_APPROVAL, name: 'x', kind: 'own' }, 'approve'))).toBe('ownership');
    expect(await refusal(renewOwnCertificate(rawAsGuarded(raw), foreign, ra, 'T', {}))).toBe('ownership');
    expect(wire()).toEqual([]);
});

test('register (guard request applied: POST_CREATE) is sent with the CN request attribute and the challenge; the placeholder is recorded', async () => {
    const ra = await ensureRunRaProfile(api, 'T');
    server.reset();
    const reg = await registerOwnCertificate(api, ra, 'T', { suffix: 'reg', secret: 'qa-wire-secret-0001' });
    expect(reg.answer.status).toBe(200);
    expect(reg.cert).toBeTruthy();
    const body = bodyOf('POST', `/api/v2/operations/authorities/${A_EJBCA}/raProfiles/${ra.uuid}/certificates/register`);
    expect(body.csrAttributes).toEqual([{ version: 'v3', uuid: CN_ATTR, name: 'commonName', contentType: 'string', content: [{ data: reg.cn, contentType: 'string' }] }]);
    expect(body.authorizationSecret).toBe('qa-wire-secret-0001');
    expect(readLedger().find((l) => l.uuid === reg.cert!.uuid)).toMatchObject({ type: 'certificates', name: reg.cn });
    expect((await issueExisting(api, reg.cert!, ra, { request: 'YQ==', authorizationSecret: 'qa-wire-secret-0001' })).status).toBe(200);
});

test('the approval gate: the approval profile names the OWN role; the RA+ clone is created under the run authority and enabled; associate / release; a gated issue is found, recorded and decided through the override PATCH', async () => {
    await ensureRunRaProfile(api, 'T');
    server.reset();
    const gate = await openApprovalGate(api, 'T', 'wire');
    const apBody = bodyOf('POST', '/api/v1/approvalProfiles');
    const role = readRunState().role!;
    expect(apBody).toMatchObject({ name: runName('ap'), enabled: true, expiry: 24, approvalSteps: [{ roleUuid: role.uuid, order: 1, requiredApprovals: 1 }] });
    expect(apBody.approvalSteps[0].roleUuid).not.toBe(ROLE_FOREIGN);
    expect(gate.ra.name.startsWith(`${runId()}-ra-wire-`)).toBe(true);
    expect(wire()).toEqual([
        `POST /api/v1/authorities/${A_EJBCA}/raProfiles`, `PATCH /api/v1/authorities/${A_EJBCA}/raProfiles/${gate.ra.uuid}/enable`,
        'POST /api/v1/roles', 'POST /api/v1/approvalProfiles',
        `PATCH /api/v1/approvalProfiles/${gate.approvalProfile.uuid}/associations/raProfiles/${gate.ra.uuid}`,
    ]);
    expect(readLedger().filter((l) => l.event === 'created').map((l) => l.type)).toEqual(expect.arrayContaining(['roles', 'approvalProfiles', 'raProfiles']));
    expect(readRunState().approvalProfile?.uuid).toBe(gate.approvalProfile.uuid);

    server.reset();
    const cert = await submitOwnCertificate(api, gate.ra, 'T', { suffix: 'gated' });
    const approval = await findApproval(api, cert, 'T', { status: 'Pending' });
    // The own approval profile is recorded as a parent too (the guard decides only with both own).
    expect(readLedger().find((l) => l.uuid === approval.uuid)).toMatchObject({ type: 'approvals', name: runName(`approval-${approval.uuid.slice(0, 8)}`), parents: { certificate: cert.uuid, approvalProfile: gate.approvalProfile.uuid } });
    expect((await findApproval(api, cert, 'T')).uuid, 'found again without a second ledger line').toBe(approval.uuid);
    expect(readLedger().filter((l) => l.uuid === approval.uuid)).toHaveLength(1);
    // Mutant: the status filter holds — a closed approval never stands in for a Pending one.
    core.approvals.get(cert.uuid)!.status = 'Rejected';
    await expect(findApproval(api, cert, 'T', { status: 'Pending', timeoutMs: 1_500 })).rejects.toThrow(/no approval listed within 1500 ms/);
    expect((await findApproval(api, cert, 'T', { status: 'Rejected' })).uuid).toBe(approval.uuid);
    // A listed row without its uuid is reported as such, not as "nothing listed".
    const listed = core.approvals.get(cert.uuid)!;
    const savedUuid = listed.approvalUuid;
    delete listed.approvalUuid;
    await expect(findApproval(api, cert, 'T', { timeoutMs: 1_200 })).rejects.toThrow(/an approval is listed \(status Rejected\) but carries no approvalUuid within 1200 ms/);
    listed.approvalUuid = savedUuid;
    core.approvals.get(cert.uuid)!.status = 'Pending';
    expect((await decideApproval(api, approval, 'approve')).status).toBe(204);
    expect(wire()).toEqual([`POST /api/v2/operations/authorities/${A_EJBCA}/raProfiles/${gate.ra.uuid}/certificates`, `PATCH /api/v1/approvals/${approval.uuid}/approve`]);

    server.reset();
    await gate.release();
    await gate.release();
    expect(wire(), 'release once, idempotent').toEqual([`DELETE /api/v1/approvalProfiles/${gate.approvalProfile.uuid}/associations/raProfiles/${gate.ra.uuid}`]);
    // Idempotent again at the API: the second association is also removed by the plain helper (404 tolerated).
    await dissociateApprovalProfile(api, gate.approvalProfile, gate.ra);
});

test('findApproval names the approval profile as a parent only when it is an own approvalProfiles line', async () => {
    await ensureRunRaProfile(api, 'T');
    const gate = await openApprovalGate(api, 'T', 'aptype');
    const cert = await submitOwnCertificate(api, gate.ra, 'T', { suffix: 'aptype' });
    // The listed approval names an own object of ANOTHER type as its approval profile (the RA+ clone): no profile parent.
    core.approvals.get(cert.uuid)!.approvalProfileUuid = gate.ra.uuid;
    const approval = await findApproval(api, cert, 'T');
    expect(readLedger().find((l) => l.uuid === approval.uuid)?.parents).toEqual({ certificate: cert.uuid });
    // So the guard refuses the decision (no own approval profile parent).
    await expect(decideApproval(api, approval, 'approve')).rejects.toThrow(/names no own approval profile/);
});

test('teardown handlers: a Pending approval is rejected through the override path and kept; the approval profile is dissociated and deleted, or kept when the platform refuses', async () => {
    await ensureRunRaProfile(api, 'T');
    const gate = await openApprovalGate(api, 'T', 'td');
    const cert = await submitOwnCertificate(api, gate.ra, 'T', { suffix: 'td' });
    const approval = await findApproval(api, cert, 'T');
    const warnings: string[] = [];
    const ctx: TeardownContext = { api: raw, runId: runId(), ledger: readLedger(), seen: new Set(), tier: null, warn: (m) => warnings.push(m), pollMs: 1 };
    const approvalLine = readLedger().find((l) => l.uuid === approval.uuid)!;
    server.reset();
    expect(await teardownHandlers.approvals.remove(ctx, approvalLine)).toBe('kept');
    expect(wire()).toEqual([`PATCH /api/v1/approvals/${approval.uuid}/reject`]);
    expect(warnings[0]).toMatch(/was Pending, rejected/);
    server.reset();
    expect(await teardownHandlers.approvals.remove(ctx, approvalLine), 'already closed: kept, no call').toBe('kept');
    expect(wire()).toEqual([]);

    const apLine = readLedger().find((l) => l.uuid === gate.approvalProfile.uuid)!;
    server.reset();
    core.approvalProfileDeleteStatus = 422;
    expect(await teardownHandlers.approvalProfiles.remove(ctx, apLine)).toBe('kept');
    expect(wire()).toEqual([
        `DELETE /api/v1/approvalProfiles/${gate.approvalProfile.uuid}/associations/raProfiles/${gate.ra.uuid}`,
        `DELETE /api/v1/approvalProfiles/${gate.approvalProfile.uuid}`,
    ]);
    expect(warnings.at(-1)).toMatch(/existing approvals/);
    server.reset();
    core.approvalProfileDeleteStatus = 204;
    expect(await teardownHandlers.approvalProfiles.remove(ctx, apLine)).toBeUndefined();
    expect(wire()).toEqual([`DELETE /api/v1/approvalProfiles/${gate.approvalProfile.uuid}`]);
    // A line of another run is refused by the handler's guard (ledger), nothing sent.
    server.reset();
    const foreignLine = { ...apLine, uuid: ROLE_FOREIGN };
    expect(await refusal(teardownHandlers.approvalProfiles.remove(ctx, foreignLine))).not.toBe('sent');
    expect(wire()).toEqual([]);
});

test('a raw context handed to a mutating lifecycle helper is refused (not-guarded); nothing is sent', async () => {
    const ra = await ensureRunRaProfile(api, 'T');
    server.reset();
    expect(await refusal(submitOwnCertificate(rawAsGuarded(raw), ra, 'T'))).toBe('not-guarded');
    expect(await refusal(ensureApprovalProfile(rawAsGuarded(raw), 'T'))).toBe('not-guarded');
    recordCreated('certificates', { uuid: U(77), name: runName('x') }, { spec: 'T' });
    expect(await refusal(revokeOwnCertificate(rawAsGuarded(raw), { uuid: U(77), name: runName('x'), kind: 'own' }, ra))).not.toBe('sent');
    expect(wire()).toEqual([]);
});
