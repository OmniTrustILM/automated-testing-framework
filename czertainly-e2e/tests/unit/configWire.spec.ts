/**
 * configWire — loopback wire check of the config helpers of the main flows.
 *
 * Covers the helpers for own RA profiles, roles, users, the inventory seed subset, ACME activation and issued records,
 * against one stateful fake core (tests/unit/helpers/loopbackServer.ts). Every request goes through the guard, the ledger is
 * written before any assertion, and a foreign object or a raw context is refused before anything is sent. The ledger lives
 * in a per-test REG_STATE_DIR.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import * as forge from 'node-forge';
import { connectorsAlive, findConnector, healthByVersion, probeAttributes, waitForHealthy } from '../../utils/regression/platform/connectorApi';
import { GuardedApi } from '../../utils/regression/guard/types';
import { buildSeedSubset, manifestProblems, planSeedSubset } from '../../utils/regression/inventory/seedMinimal';
import { derivedDeletable, OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { adcsBlocker, isCredentialLogonRefusal } from '../../utils/regression/config/authorities';
import { issueWithCsr, uploadOwnCertificate } from '../../utils/regression/ownCertificates';
import {
    recordAcmeAccount,
    recordCertificatesNamed,
    recordDerivedKeyOf,
    recordDerivedKeyOrNamed,
    recordingIssued,
    recordIssuedSettled,
} from '../../utils/regression/issuedRecords';
import { requiredCustomAttributes } from '../../utils/regression/customAttributes';
import { createOwnRole, ensureRunRole } from '../../utils/regression/ownRoles';
import { createOwnUser, setOwnUserRoles } from '../../utils/regression/ownUsers';
import { createOwnRaProfileLike, enableOwnRaProfile, ensureAcmeOnRaProfile, ensureOwnRaProfile, ensureRunRaProfile, ensureRunRaProfileOrSkip, pickHealthyAuthority, RaProfileSourceMissing } from '../../utils/regression/ownRaProfiles';
import { rowsNamed } from '../../utils/regression/listReads';
import { issueOnly, OwnRef, readLedger, recordCreated } from '../../utils/regression/ledger/ledger';
import { readRunState, runName, runId, updateRunState } from '../../utils/regression/ledger/runState';
import { selfSignedPem } from '../../utils/regression/pkiBuilders';
import { Answer, Arrived, LoopbackServer } from './helpers/loopbackServer';
import { FakeCore as BaseCore } from './helpers/fakeCore';
import { registerFakeCore, rawAsGuarded } from './helpers/guardRig';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C_ADCS = U(1);
const C_EJBCA = U(2);
const C_CRED = U(3);
const A_ADCS = U(11);
const A_EJBCA = U(12);
const R_SRC = U(21);
const R_DISABLED = U(22);
const R_ADCS = U(23);
const A_DECOY = U(13);
const R_DECOY_A = U(24);
const R_DECOY_B = U(25);
const R_FIRST = U(26);
const REQUIRED_LIST_ATTR = U(45);
const FOREIGN_ROLE = U(31);
const ATTR_DATA = U(41);
const REQUIRED_USER_ATTR = U(42);
const ACME_PROFILE = U(51);
const ACME_ACCOUNT = U(52);

type Json = Record<string, any>;

/** A fake core that remembers what the run created (GET answers it) and serves a fixed tier around it. */
class ConfigCore extends BaseCore {
    adcsHealthy = false;
    /** An enabled RA profile on the MS ADCS authority (the copy source when MS ADCS is healthy). */
    adcsHasRa = false;
    ejbcaHealthy = true;
    usersRequireAttr = true;
    /** Run-family decoys: a run-prefixed authority with an enabled RA profile, and a run-prefixed RA profile. */
    decoys = false;
    /** A second enabled, non-run RA profile that sorts BEFORE the source by name but comes AFTER it in the list. */
    twoSources = false;
    /** A required LIST custom attribute on users. */
    usersRequireList = false;
    /** The tier requires an integer custom attribute on roles. */
    rolesRequireAttr = false;
    /** The next N certificate detail reads answer 500 (the by-name fallback). */
    failDetailReads = 0;
    /** The credential connector's attribute map (an empty map is no probe). */
    credAttrs: Json = { credentialProvider: { Basic: [{ name: 'username' }] } };
    /** The status of the ADCS authority's RA-profile attribute read. */
    adcsRaAttrStatus = 200;
    /** `acmeAvailable` after the activation. */
    acmeAvailable = true;
    /**
     * Called with the 1-based number of each certificate search before it is answered: a certificate can appear or change between two
     * reads.
     */
    onCertificateSearch: ((n: number) => void) | undefined;
    private searches = 0;
    /** How many certificate searches arrived. */
    get searchCount(): number {
        return this.searches;
    }
    protected seq = 1000;
    readonly certs: Json[] = [];

    /** A certificate the platform lists (search row) and serves (detail, with its linked key): `commonName`, `state`, `key.uuid`. */
    addCert(commonName: string, state: string): Json {
        const cert = { kind: 'cert', uuid: this.next(), commonName, state, key: { uuid: this.next() } };
        this.store.set(`/api/v1/certificates/${cert.uuid}`, cert);
        this.certs.push(cert);
        return cert;
    }

    protected respond(a: Arrived): Answer | undefined {
        const path = a.url.split('?')[0];
        const body = a.body ? (JSON.parse(a.body) as Json) : undefined;
        if (a.method === 'GET') return this.get(path);
        if (a.method === 'POST') return this.post(path, body);
        return { status: 204 };
    }

    private get(path: string): Answer {
        if (this.failDetailReads > 0 && /^\/api\/v1\/certificates\/[0-9a-f-]{36}$/.test(path)) {
            this.failDetailReads -= 1;
            return { status: 500, body: { message: 'transient' } };
        }
        const fixed: Record<string, unknown> = {
            '/api/v1/connectors': [
                { uuid: C_ADCS, name: 'MS-ADCS-NG-Connector', status: 'connected' },
                { uuid: C_EJBCA, name: 'EJBCA-NG-Connector', status: 'connected' },
                { uuid: C_CRED, name: 'Common-Credential-Connector', status: 'connected' },
            ],
            [`/api/v2/connectors/${C_ADCS}`]: { uuid: C_ADCS, name: 'MS-ADCS-NG-Connector', version: 'v2' },
            [`/api/v2/connectors/${C_EJBCA}`]: { uuid: C_EJBCA, name: 'EJBCA-NG-Connector', version: 'v1' },
            [`/api/v2/connectors/${C_CRED}`]: { uuid: C_CRED, name: 'Common-Credential-Connector', version: 'v1' },
            [`/api/v1/connectors/${C_CRED}/attributes`]: this.credAttrs,
            [`/api/v2/connectors/${C_ADCS}/info`]: { name: 'ms-adcs' },
            [`/api/v1/authorities/${A_ADCS}/attributes/raProfile`]: [{ name: 'data_certificateTemplate' }],
            '/api/v1/authorities': [
                ...(this.decoys ? [{ uuid: A_DECOY, name: `${runId()}-decoy-ca`, connectorUuid: C_EJBCA, connectorName: 'EJBCA-NG-Connector', status: 'connected' }] : []),
                { uuid: A_ADCS, name: 'adcs-ca', connectorUuid: C_ADCS, connectorName: 'MS-ADCS-NG-Connector', status: 'connected' },
                { uuid: A_EJBCA, name: 'ejbca-ca', connectorUuid: C_EJBCA, connectorName: 'EJBCA-NG-Connector', status: 'connected' },
            ],
            [`/api/v1/authorities/${A_EJBCA}`]: { uuid: A_EJBCA, connectorName: 'EJBCA-NG-Connector' },
            '/api/v1/raProfiles': [
                // Decoys sort before the source by name ('aa-…', 'qa-…' < 'source-ra'): only the run-family filters keep them out.
                ...(this.decoys ? [
                    { uuid: R_DECOY_A, name: 'aa-ra', authorityInstanceUuid: A_DECOY, enabled: true },
                    { uuid: R_DECOY_B, name: `qa-api-decoy-ra`, authorityInstanceUuid: A_EJBCA, enabled: true },
                ] : []),
                { uuid: R_DISABLED, name: 'disabled-ra', authorityInstanceUuid: A_EJBCA, enabled: false },
                { uuid: R_SRC, name: 'source-ra', authorityInstanceUuid: A_EJBCA, enabled: true },
                ...(this.twoSources ? [{ uuid: R_FIRST, name: 'first-ra', authorityInstanceUuid: A_EJBCA, enabled: true }] : []),
                ...(this.adcsHasRa ? [{ uuid: R_ADCS, name: 'adcs-ra', authorityInstanceUuid: A_ADCS, enabled: true }] : []),
            ],
            [`/api/v1/authorities/${A_EJBCA}/raProfiles/${R_SRC}`]: {
                uuid: R_SRC, name: 'source-ra', attributes: [
                    { version: 2, uuid: ATTR_DATA, name: 'endEntityProfile', label: 'EE', type: 'data', contentType: 'object', content: [{ reference: 'EE', data: { id: 1, name: 'EE' } }] },
                    { version: 2, uuid: U(43), name: 'note', label: 'Note', type: 'info', contentType: 'string', content: [{ data: 'read only' }] },
                ],
            },
            '/api/v1/attributes/custom/resources/raProfiles': [],
            '/api/v1/attributes/custom/resources/authorities': [],
            '/api/v1/attributes/custom/resources/acmeProfiles': [],
            '/api/v1/attributes/custom/resources/roles': this.rolesRequireAttr ? [{ uuid: U(46), name: 'costCenter', contentType: 'integer', properties: { required: true } }] : [],
            '/api/v1/attributes/custom/resources/certificates': [],
            '/api/v1/attributes/custom/resources/users': [
                ...(this.usersRequireAttr ? [{ uuid: REQUIRED_USER_ATTR, name: 'department', contentType: 'string', properties: { required: true } }, { uuid: U(44), name: 'optional', contentType: 'string', properties: { required: false } }] : []),
                ...(this.usersRequireList ? [{ uuid: REQUIRED_LIST_ATTR, name: 'site', contentType: 'string', properties: { required: true, list: true }, content: [{ reference: 'site-a', data: 'Site A', contentType: 'string' }, { reference: 'site-b', data: 'Site B', contentType: 'string' }] }] : []),
            ],
            '/api/v1/roles': [{ uuid: FOREIGN_ROLE, name: 'Administrators' }, ...[...this.store.values()].filter((o) => o.kind === 'role')],
            [`/api/v1/roles/${FOREIGN_ROLE}`]: { uuid: FOREIGN_ROLE, name: 'Administrators' },
            '/api/v1/acmeAccounts': [{ uuid: ACME_ACCOUNT, accountId: 'acc123', acmeProfileUuid: ACME_PROFILE }],
        };
        if (path === `/api/v2/connectors/${C_ADCS}/health`) return this.adcsHealthy ? { status: 200, body: { status: 'UP' } } : { status: 503, body: { status: 'DOWN' } };
        if (path === `/api/v1/connectors/${C_EJBCA}/health`) return this.ejbcaHealthy ? { status: 200, body: { status: 'ok' } } : { status: 503, body: { message: 'Error in connector communication' } };
        if (path === `/api/v1/connectors/${C_CRED}/health`) return { status: 200, body: { status: 'ok' } };
        if (path === `/api/v1/authorities/${A_ADCS}/attributes/raProfile` && this.adcsRaAttrStatus !== 200) return { status: this.adcsRaAttrStatus, body: { message: 'Error in connector communication' } };
        if (/^\/api\/v1\/authorities\/[0-9a-f-]{36}\/raProfiles\/[0-9a-f-]{36}\/protocols\/acme$/.test(path)) {
            return { status: 200, body: { acmeAvailable: this.acmeAvailable, ...(this.acmeAvailable ? { directoryUrl: 'https://acme.example.test/directory' } : {}) } };
        }
        if (Object.hasOwn(fixed, path)) return { status: 200, body: fixed[path] };
        const stored = this.store.get(path);
        return stored ? { status: 200, body: stored } : { status: 404, body: { message: 'not found' } };
    }

    private post(path: string, body: Json | undefined): Answer {
        let m: RegExpExecArray | null;
        const uuid = this.next();
        if ((m = /^\/api\/v1\/authorities\/([0-9a-f-]{36})\/raProfiles$/.exec(path))) {
            const ra = { kind: 'ra', uuid, name: body?.name, authorityInstanceUuid: m[1], enabled: false };
            this.store.set(`/api/v1/raProfiles/${uuid}`, ra);
            this.store.set(`/api/v1/authorities/${m[1]}/raProfiles/${uuid}`, { ...ra, attributes: (body?.attributes ?? []).map((x: Json) => ({ ...x, type: 'data' })) });
            return { status: 200, body: { uuid, name: body?.name } };
        }
        if (path === '/api/v1/roles') {
            this.store.set(`/api/v1/roles/${uuid}`, { kind: 'role', uuid, name: body?.name });
            return { status: 200, body: { uuid } };
        }
        if (path === '/api/v1/acmeProfiles') {
            this.store.set(`/api/v1/acmeProfiles/${uuid}`, { kind: 'acme', uuid, name: body?.name });
            return { status: 200, body: { uuid } };
        }
        if (path === '/api/v1/users') {
            this.store.set(`/api/v1/users/${uuid}`, { kind: 'user', uuid, username: body?.username, enabled: body?.enabled });
            return { status: 200, body: { uuid } };
        }
        if (path === '/api/v1/attributes/custom') {
            this.store.set(`/api/v1/attributes/custom/${uuid}`, { kind: 'attr', uuid, name: body?.name });
            return { status: 200, body: { uuid, name: body?.name } };
        }
        if (path === '/api/v1/certificates/upload') {
            const pem = Buffer.from(String(body?.certificate), 'base64').toString('utf8');
            const cn = forge.pki.certificateFromPem(pem).subject.getField('CN').value as string;
            const cert = { kind: 'cert', uuid, commonName: cn, key: { uuid: this.next() } };
            this.store.set(`/api/v1/certificates/${uuid}`, cert);
            this.certs.push(cert);
            return { status: 200, body: { uuid } };
        }
        if (/^\/api\/v2\/operations\/authorities\/[0-9a-f-]{36}\/raProfiles\/[0-9a-f-]{36}\/certificates$/.test(path)) {
            return { status: 200, body: { certificateData: '', uuid, requestAttributeWarnings: [] } };
        }
        if (path === '/api/v1/certificates') {
            this.searches += 1;
            this.onCertificateSearch?.(this.searches);
            const f = (body?.filters ?? [])[0] as Json | undefined;
            const rows = this.certs.filter((c) => !f || (f.condition === 'EQUALS' && c.commonName === f.value) || (f.condition === 'STARTS_WITH' && String(c.commonName).startsWith(f.value)));
            return { status: 200, body: { certificates: rows } };
        }
        return { status: 404, body: { message: `no fake route POST ${path}` } };
    }
}

let server: LoopbackServer;
let core: ConfigCore;
let raw: APIRequestContext;
let api: GuardedApi;

registerFakeCore(() => core, (rig) => ({ server, raw, api } = rig), { clear: ['REG_RA_PROFILE_NAME', 'REG_CA_CONNECTORS', 'REG_ADCS_CONNECTOR'] });
test.beforeEach(() => {
    core = new ConfigCore();
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

// ------------------------------------------------------------------ the CA-agnostic run RA profile

test('ensureRunRaProfile: MS ADCS unhealthy (v2 health 503) → an own RA profile copied from the EJBCA-NG source, created under its authority and enabled', async () => {
    const ra = await ensureRunRaProfile(api, 'T');
    const created = wire();
    expect(created).toEqual([`POST /api/v1/authorities/${A_EJBCA}/raProfiles`, `PATCH /api/v1/authorities/${A_EJBCA}/raProfiles/${ra.uuid}/enable`]);
    const sent = bodyOf('POST', `/api/v1/authorities/${A_EJBCA}/raProfiles`);
    expect(sent.name).toBe(runName('ra'));
    expect(sent.attributes, 'only the DATA attributes of the source, as request attributes').toEqual([
        { version: 'v2', uuid: ATTR_DATA, name: 'endEntityProfile', contentType: 'object', content: [{ reference: 'EE', data: { id: 1, name: 'EE' } }] },
    ]);
    // Health was read live and BY VERSION for both CA connectors; the source RA profile was only read.
    const reads = server.arrived.filter((a) => a.method === 'GET').map((a) => a.url);
    expect(reads).toEqual(expect.arrayContaining([`/api/v2/connectors/${C_ADCS}/health`, `/api/v1/connectors/${C_EJBCA}/health`, `/api/v1/authorities/${A_EJBCA}/raProfiles/${R_SRC}`]));
    expect(created.some((w) => w.includes(R_SRC) || w.includes(R_DISABLED)), 'nothing was sent to the source RA profiles').toBe(false);
    expect(ra).toMatchObject({ kind: 'own', name: runName('ra'), authorityUuid: A_EJBCA });
    const line = readLedger().find((l) => l.uuid === ra.uuid)!;
    expect(line).toMatchObject({ type: 'raProfiles', event: 'created', parents: { authority: A_EJBCA } });
    expect(readRunState().raProfile?.uuid).toBe(ra.uuid);
    // The run state answers the next call: nothing more is sent.
    server.reset();
    expect((await ensureRunRaProfile(api, 'T')).uuid).toBe(ra.uuid);
    expect(wire()).toEqual([]);
});

test('pickHealthyAuthority: a healthy MS ADCS with an enabled RA profile wins (MS ADCS comes first in the CA order); with no healthy CA the caller gets the named deploy gate and nothing is sent', async () => {
    core.adcsHealthy = true;
    // MS ADCS healthy but without an enabled RA profile to copy: the next CA (EJBCA-NG) is the source.
    expect(await pickHealthyAuthority(api)).toEqual({ uuid: R_SRC, authorityUuid: A_EJBCA, connectorName: 'EJBCA-NG-Connector' });
    core.adcsHasRa = true;
    expect(await pickHealthyAuthority(api)).toEqual({ uuid: R_ADCS, authorityUuid: A_ADCS, connectorName: 'MS-ADCS-NG-Connector' });
    expect(await adcsBlocker(api)).toBeUndefined();
    core.adcsHealthy = false;
    core.ejbcaHealthy = false;
    const none = await pickHealthyAuthority(api);
    expect(none).toEqual({ skip: expect.stringContaining('deploy gate') });
    expect((none as { skip: string }).skip).toMatch(/MS-ADCS-NG-Connector: live health 503; EJBCA-NG-Connector: live health 503; PyADCS-Connector: not registered/);
    const reasons: string[] = [];
    await expect(ensureRunRaProfileOrSkip(api, 'T', (r) => reasons.push(r))).rejects.toBeInstanceOf(RaProfileSourceMissing);
    expect(reasons).toEqual([(none as { skip: string }).skip]);
    expect(wire(), 'no mutation without a CA').toEqual([]);
    expect(await adcsBlocker(api)).toMatch(/connector MS-ADCS-NG-Connector: stored connected, live health 503 — environment blocker/);
});

test('ensureOwnRaProfile: an issue-only parent (REG_RA_PROFILE_NAME, local) is never changed; an own clone is made once and found again in the ledger', async () => {
    updateRunState({ raProfile: { ...issueOnly({ uuid: R_SRC, name: 'source-ra' }), authorityUuid: A_EJBCA } });
    const own = await ensureOwnRaProfile(api, 'T');
    expect(own.name).toBe(runName('ra-own'));
    expect(wire()).toEqual([`POST /api/v1/authorities/${A_EJBCA}/raProfiles`, `PATCH /api/v1/authorities/${A_EJBCA}/raProfiles/${own.uuid}/enable`]);
    server.reset();
    expect((await ensureOwnRaProfile(api, 'T')).uuid).toBe(own.uuid);
    expect(wire()).toEqual([]);
    // The guard and the helper refuse the issue-only parent itself.
    const forged = { uuid: R_SRC, name: 'source-ra', kind: 'own' } as OwnRef;
    expect(await refusal(enableOwnRaProfile(api, A_EJBCA, forged))).toBe('ownership');
    expect(await refusal(api.patch(`/api/v1/authorities/${A_EJBCA}/raProfiles/${R_SRC}/protocols/acme/activate/${ACME_PROFILE}`, { data: {} }))).toBe('ownership');
    expect(wire()).toEqual([]);
});

test('createOwnRaProfileLike with a raw context is refused (not-guarded); nothing is sent', async () => {
    expect(await refusal(createOwnRaProfileLike(rawAsGuarded(raw), 'T', 'x', { source: { uuid: R_SRC, authorityUuid: A_EJBCA }, note: 'x' }))).toBe('not-guarded');
    expect(wire()).toEqual([]);
});

// ------------------------------------------------------------------ roles and users

test('createOwnRole / createOwnUser / setOwnUserRoles: creates and own-to-own assignment are sent; required custom attributes are filled; a foreign role is refused', async () => {
    const role = await createOwnRole(api, 'T', 'role-edit');
    const user = await createOwnUser(api, 'T', 'user-delete');
    await setOwnUserRoles(api, user, [role]);
    expect(wire()).toEqual(['POST /api/v1/roles', 'POST /api/v1/users', `PATCH /api/v1/users/${user.uuid}/roles`]);
    const userBody = bodyOf('POST', '/api/v1/users');
    expect(userBody.username).toBe(user.name);
    expect(userBody.enabled, 'a suite user is created disabled').toBe(false);
    expect(userBody.customAttributes).toEqual([{ version: 'v3', uuid: REQUIRED_USER_ATTR, name: 'department', contentType: 'string', content: [{ data: runName('ca'), contentType: 'string' }] }]);
    expect(bodyOf('PATCH', `/api/v1/users/${user.uuid}/roles`)).toEqual([role.uuid]);
    expect(readLedger().filter((l) => l.event === 'created').map((l) => l.type)).toEqual(['roles', 'users']);
    server.reset();
    const foreign = { uuid: FOREIGN_ROLE, name: 'Administrators', kind: 'own' } as OwnRef;
    expect(await refusal(setOwnUserRoles(api, user, [foreign]))).toBe('ownership');
    expect(await refusal(api.patch(`/api/v1/users/${user.uuid}/roles`, { data: [FOREIGN_ROLE] }))).toBe('ownership');
    expect(await refusal(api.delete(`/api/v1/roles/${FOREIGN_ROLE}`))).toBe('ownership');
    expect(wire()).toEqual([]);
});

// ------------------------------------------------------------------ the inventory seed subset

test('buildSeedSubset: own attribute, own disabled user, three uploads, owner PATCHes on own certificates; ledger first; idempotent', async () => {
    core.usersRequireAttr = false;
    const plan = planSeedSubset(runName, 'wire');
    const m = await buildSeedSubset(api, 'T', plan);
    expect(manifestProblems(m)).toEqual([]);
    const [a, b, c] = m.certificates;
    expect(wire()).toEqual([
        'POST /api/v1/attributes/custom', 'POST /api/v1/users',
        'POST /api/v1/certificates/upload', 'POST /api/v1/certificates/upload', 'POST /api/v1/certificates/upload',
        `PATCH /api/v1/certificates/${a.uuid}`, `PATCH /api/v1/certificates/${b.uuid}`,
    ]);
    const attr = bodyOf('POST', '/api/v1/attributes/custom');
    expect(attr).toMatchObject({ name: plan.attribute.name, contentType: 'integer', required: false, resources: ['certificates'] });
    const uploads = server.arrived.filter((x) => x.url === '/api/v1/certificates/upload').map((x) => JSON.parse(x.body).customAttributes);
    expect(uploads).toEqual([
        [{ uuid: m.attributeUuid, name: plan.attribute.name, contentType: 'integer', content: [{ data: 2 }] }],
        [],
        [{ uuid: m.attributeUuid, name: plan.attribute.name, contentType: 'integer', content: [{ data: 1 }] }],
    ]);
    expect(bodyOf('PATCH', `/api/v1/certificates/${a.uuid}`)).toEqual({ ownerUuid: m.ownerUuid });
    expect(c.owner).toBe(false);
    const lines = readLedger().filter((l) => l.event === 'created');
    expect(lines.map((l) => l.type)).toEqual(['customAttributes', 'users', 'certificates', 'keys', 'certificates', 'keys', 'certificates', 'keys']);
    expect(lines.filter((l) => l.type === 'keys').every((l) => l.derived && !!l.createdAfter)).toBe(true);
    server.reset();
    expect((await buildSeedSubset(api, 'T')).certificates.map((x) => x.uuid)).toEqual(m.certificates.map((x) => x.uuid));
    expect(wire(), 'the second call reuses the run\'s subset').toEqual([]);
});

test('buildSeedSubset with a raw context is refused (not-guarded); nothing is sent', async () => {
    expect(await refusal(buildSeedSubset(rawAsGuarded(raw), 'T', planSeedSubset(runName, 'raw')))).toBe('not-guarded');
    expect(wire()).toEqual([]);
});

// ------------------------------------------------------------------ issuance and protocol-made objects

test('issueWithCsr goes through the guard (create path); recordCertificatesNamed and recordAcmeAccount only read', async () => {
    const ra = await ensureRunRaProfile(api, 'T');
    server.reset();
    const issued = await issueWithCsr(api, ra.authorityUuid, ra.uuid, 'TUlJQw==');
    expect(wire()).toEqual([`POST /api/v2/operations/authorities/${A_EJBCA}/raProfiles/${ra.uuid}/certificates`]);
    expect(issued.createdAfter, 'createdAfter from the server Date header').toBeTruthy();
    expect(await refusal(issueWithCsr(rawAsGuarded(raw), ra.authorityUuid, ra.uuid, 'TUlJQw=='))).toBe('not-guarded');

    // A protocol-made certificate of a run-prefixed name is adopted; reads only.
    const cn = `${runId()}.example.test`;
    const pemOf = (name: string): string => {
        const keys = forge.pki.rsa.generateKeyPair(1024);
        const cert = forge.pki.createCertificate();
        cert.publicKey = keys.publicKey;
        cert.serialNumber = '01';
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date(Date.now() + 86_400_000);
        cert.setSubject([{ name: 'commonName', value: name }]);
        cert.setIssuer([{ name: 'commonName', value: name }]);
        cert.sign(keys.privateKey, forge.md.sha256.create());
        return forge.pki.certificateToPem(cert);
    };
    await api.post('/api/v1/certificates/upload', { data: { certificate: Buffer.from(pemOf(cn)).toString('base64'), customAttributes: [] } });
    server.reset();
    const uuids = await recordCertificatesNamed(api, cn, 'T', 'issued via ACME');
    expect(uuids).toHaveLength(1);
    expect(readLedger().some((l) => l.uuid === uuids[0] && l.type === 'certificates')).toBe(true);
    await expect(recordCertificatesNamed(api, 'prod.example.test', 'T', 'x')).rejects.toThrow(/carries no run prefix/);
    const account = await recordAcmeAccount(api, 'https://acme.example.test/acct/acc123', { uuid: ACME_PROFILE, name: runName('acme'), kind: 'own' }, 'T');
    expect(account.name).toBe(runName('acme-account-acc123'));
    expect(readLedger().find((l) => l.uuid === ACME_ACCOUNT)).toMatchObject({ type: 'acmeAccounts', parents: { acmeProfile: ACME_PROFILE } });
    expect(wire(), 'reads and read-only POSTs only').toEqual(['POST /api/v1/certificates']);
});

// ------------------------------------------------------------------ connectorApi

test('connectorApi: version from the detail, health by version, attribute probes, connectorsAlive — GETs only', async () => {
    const adcs = (await findConnector(api, 'MS-ADCS-NG-Connector'))!;
    const ejbca = (await findConnector(api, 'EJBCA-NG-Connector'))!;
    const cred = (await findConnector(api, 'Common-Credential-Connector'))!;
    const h1 = await healthByVersion(api, adcs);
    expect(h1).toMatchObject({ version: 2, healthy: false, httpStatus: 503, status: 'DOWN', why: 'live health 503' });
    const h2 = await healthByVersion(api, ejbca);
    expect(h2).toMatchObject({ version: 1, healthy: true, httpStatus: 200, status: 'ok' });
    expect(await probeAttributes(api, cred, 1)).toMatchObject({ ok: true, httpStatus: 200 });
    core.adcsHealthy = true;
    expect(await probeAttributes(api, adcs, 2)).toMatchObject({ ok: true, why: 'info and RA-profile attribute definitions answered' });
    const alive = await connectorsAlive(api, ['EJBCA-NG-Connector', 'Nope-Connector']);
    expect(alive).toEqual([expect.objectContaining({ name: 'EJBCA-NG-Connector', healthy: true }), { name: 'Nope-Connector', missing: true }]);
    await expect(waitForHealthy(api, { uuid: U(99), name: 'Ghost-Connector', status: 'connected' }, 1_000, 10)).rejects.toThrow(/version unknown \(connector detail answered 404\): not retried/);
    expect(server.arrived.filter((a) => a.method === 'GET' && a.url.startsWith(`/api/v1/connectors/${C_ADCS}/health`)), 'the v1 path of a v2 connector is never used').toEqual([]);
    expect(wire()).toEqual([]);
});

test('ledger before assertion: recordCreated writes the line the guard accepts for the next change', async () => {
    const r = await createOwnRole(api, 'T', 'role');
    const line = readLedger().find((l) => l.uuid === r.uuid)!;
    expect(line.name.startsWith(`${runId()}-`)).toBe(true);
    server.reset();
    expect(await refusal(api.put(`/api/v1/roles/${r.uuid}`, { data: { name: r.name, description: 'x' } }))).toBe('sent');
    const unrecorded = recordCreated('roles', { uuid: U(77), name: 'Production role' }, { spec: 'T' });
    expect(await refusal(api.delete(`/api/v1/roles/${unrecorded.uuid}`)), 'a ledger line without the run prefix proves nothing').toBe('ownership');
    expect(wire()).toEqual([`PUT /api/v1/roles/${r.uuid}`]);
});

// ------------------------------------------------------------------ mutants the earlier tests did not kill

test('pickHealthyAuthority never copies from a run object: a run-family authority or RA profile is skipped even when it sorts first', async () => {
    core.decoys = true;
    expect(await pickHealthyAuthority(api)).toEqual({ uuid: R_SRC, authorityUuid: A_EJBCA, connectorName: 'EJBCA-NG-Connector' });
    expect(wire()).toEqual([]);
});

test('pickHealthyAuthority copies from the first enabled RA profile BY NAME, whatever the list order', async () => {
    core.twoSources = true;
    expect(await pickHealthyAuthority(api)).toEqual({ uuid: R_FIRST, authorityUuid: A_EJBCA, connectorName: 'EJBCA-NG-Connector' });
    core.twoSources = false;
    expect(await pickHealthyAuthority(api)).toEqual({ uuid: R_SRC, authorityUuid: A_EJBCA, connectorName: 'EJBCA-NG-Connector' });
    expect(wire()).toEqual([]);
});

test('setOwnUserRoles refuses a foreign role in the helper itself, before the guard sees a request', async () => {
    const user = await createOwnUser(api, 'T', 'user');
    server.reset();
    const foreign = { uuid: FOREIGN_ROLE, name: 'Administrators', kind: 'own' } as OwnRef;
    const e = await setOwnUserRoles(api, user, [foreign]).then(() => undefined, (x) => x);
    expect(e).toBeInstanceOf(OwnObjectViolation);
    expect((e as OwnObjectViolation).helper).toBe('setOwnUserRoles (role)');
    expect(wire()).toEqual([]);
});

test('probeAttributes: an empty v1 attribute map and a failing v2 RA-profile attribute read are failed probes', async () => {
    const cred = (await findConnector(api, 'Common-Credential-Connector'))!;
    core.credAttrs = { credentialProvider: { Basic: [] } };
    expect(await probeAttributes(api, cred, 1)).toMatchObject({ ok: false, why: 'attribute probe answered no attribute definition' });
    core.credAttrs = {};
    expect((await probeAttributes(api, cred, 1)).ok).toBe(false);
    const adcs = (await findConnector(api, 'MS-ADCS-NG-Connector'))!;
    core.adcsRaAttrStatus = 503;
    expect(await probeAttributes(api, adcs, 2)).toMatchObject({ ok: false, httpStatus: 503, why: 'RA-profile attribute probe 503' });
    expect(wire()).toEqual([]);
});

test('requiredCustomAttributes fills a required LIST attribute with its first predefined item copied as is: reference, data and contentType (REG-CFG-09)', async () => {
    core.usersRequireAttr = false;
    core.usersRequireList = true;
    // Core compares reference + data + contentType of the item with the predefined list: a bare `{ data }` is a 422.
    expect(await requiredCustomAttributes(api, 'users', 'v')).toEqual([{ version: 'v3', uuid: REQUIRED_LIST_ATTR, name: 'site', contentType: 'string', content: [{ reference: 'site-a', data: 'Site A', contentType: 'string' }] }]);
    const user = await createOwnUser(api, 'T', 'user-list');
    expect(bodyOf('POST', '/api/v1/users').customAttributes[0].content[0], `user ${user.name}`).toEqual({ reference: 'site-a', data: 'Site A', contentType: 'string' });
});

test('uploadOwnCertificate records the certificate AND the certKey_ key core linked to it as a derived object (incident fix, REG-USE-02)', async () => {
    const cn = runName('upload');
    const ref = await uploadOwnCertificate(api, selfSignedPem(cn).pem, cn, 'T', 'uploaded (self-signed)');
    expect(wire()).toEqual(['POST /api/v1/certificates/upload']);
    const cert = core.certs.find((c) => c.uuid === ref.uuid)!;
    expect(cert.commonName).toBe(cn);
    const lines = readLedger().filter((l) => l.event === 'created');
    expect(lines.map((l) => `${l.type}:${l.uuid}:${l.derived ? 'derived' : 'own'}`)).toEqual([`certificates:${ref.uuid}:own`, `keys:${cert.key.uuid}:derived`]);
    const key = lines.find((l) => l.type === 'keys')!;
    expect(key.createdAfter, 'the derived key has a server-clock createdAfter (the upload answer\'s Date header)').toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(key.parents).toEqual({ certificate: ref.uuid });
});

test('rowsNamed answers only the rows of that name, from the full list', async () => {
    const role = await createOwnRole(api, 'T', 'role');
    expect((await rowsNamed(api, '/api/v1/roles', 'Administrators')).map((r) => r.uuid)).toEqual([FOREIGN_ROLE]);
    expect((await rowsNamed(api, '/api/v1/roles', role.name)).map((r) => r.uuid)).toEqual([role.uuid]);
    expect(await rowsNamed(api, '/api/v1/roles', 'no such role')).toEqual([]);
});

test('ensureAcmeOnRaProfile: activation on the own RA profile, and a profile that does not report ACME available fails with nothing mutating sent', async () => {
    const ok = await ensureAcmeOnRaProfile(api, 'T');
    expect(ok.directoryUrl).toBe('https://acme.example.test/directory');
    expect(wire()).toEqual(expect.arrayContaining([`PATCH /api/v1/authorities/${A_EJBCA}/raProfiles/${ok.raProfile.uuid}/protocols/acme/activate/${ok.acmeProfile.uuid}`]));
    // Activated per the run state, but the platform reports ACME as not available: the check fails, and since there is
    // nothing left to activate, NOTHING that mutates reaches the server — only the read that was judged.
    core.acmeAvailable = false;
    server.reset();
    await expect(ensureAcmeOnRaProfile(api, 'T')).rejects.toThrow(/ACME should be available on the run RA profile/);
    expect(wire(), 'no mutating request arrived').toEqual([]);
    expect(server.arrived.map((a) => `${a.method} ${a.url}`)).toContain(`GET /api/v1/authorities/${A_EJBCA}/raProfiles/${ok.raProfile.uuid}/protocols/acme`);
});

// ------------------------------------------------------------------ an issuance recorded even when the step throws

const certSpec = 'T';
const ISSUED_AFTER = '2026-10-14T10:00:00.000Z';

test('recordingIssued: a step that throws AFTER the server issued still records the certificate and its key; the step\'s own error surfaces', async () => {
    const cn = `${runId()}.example.test`;
    const cert = core.addCert(cn, 'issued');
    const boom = new Error('finalize failed after the server issued');
    await expect(recordingIssued(api, cn, ISSUED_AFTER, certSpec, 'issued via ACME', async () => { throw boom; })).rejects.toBe(boom);
    const lines = readLedger();
    expect(lines.find((l) => l.uuid === cert.uuid)).toMatchObject({ type: 'certificates', event: 'created' });
    expect(lines.find((l) => l.uuid === cert.key.uuid)).toMatchObject({ type: 'keys', derived: true, createdAfter: ISSUED_AFTER });
    expect(wire(), 'the only mutating-method request is the read-only search').toEqual(['POST /api/v1/certificates']);

    // A recording that fails on that path (a name without the run prefix) never masks the step's error.
    await expect(recordingIssued(api, 'prod.example.test', ISSUED_AFTER, certSpec, 'x', async () => { throw boom; })).rejects.toBe(boom);

    // A step that returns: its result and the recorded uuids come back (idempotent: the ledger is not doubled).
    const done = await recordingIssued(api, cn, ISSUED_AFTER, certSpec, 'issued via ACME', async () => 42);
    expect(done).toEqual({ result: 42, uuids: [cert.uuid] });
    expect(readLedger().filter((l) => l.uuid === cert.uuid && l.event === 'created')).toHaveLength(1);
});

test('recordIssuedSettled: records, polls the API state until two reads agree and nothing is pending, then records what appeared meanwhile', async () => {
    const cn = `${runId()}.example.test`;
    const first = core.addCert(cn, 'pending_issue');
    let second: Json | undefined;
    // Search 1 = the first recording, 2 = poll read (pending), 3 = the issuance lands and a successor appears, 4 = stable.
    core.onCertificateSearch = (n) => {
        if (n === 3) {
            first.state = 'issued';
            second = core.addCert(cn, 'issued');
        }
    };
    const uuids = await recordIssuedSettled(api, cn, ISSUED_AFTER, certSpec, 'safety net');
    expect(second, 'the successor appeared during the poll').toBeTruthy();
    expect([...uuids].sort()).toEqual([first.uuid, second!.uuid].sort());
    const lines = readLedger();
    for (const c of [first, second!]) {
        expect(lines.find((l) => l.uuid === c.uuid)).toMatchObject({ type: 'certificates', event: 'created' });
        expect(lines.find((l) => l.uuid === c.key.uuid)).toMatchObject({ type: 'keys', derived: true });
    }
    expect(wire().every((w) => w === 'POST /api/v1/certificates'), 'searches only, no mutation').toBe(true);
});

test('recordIssuedSettled: a certificate that stays pending does not hang the hook — the poll gives up and the final recording still runs', async () => {
    const cn = `${runId()}.example.test`;
    const stuck = core.addCert(cn, 'requested');
    const uuids = await recordIssuedSettled(api, cn, ISSUED_AFTER, certSpec, 'safety net', { timeoutMs: 3_000 });
    // 1 recording + the polled reads + 1 final recording: a certificate that is still requested is never "settled", so the poll
    // reads at least three times (two equal reads alone would end it at two).
    expect(core.searchCount, 'the poll kept reading while the certificate was requested').toBeGreaterThanOrEqual(5);
    expect(uuids).toEqual([stuck.uuid]);
    expect(readLedger().find((l) => l.uuid === stuck.uuid)).toMatchObject({ type: 'certificates' });
});

// ------------------------------------------------------------------ follow-ups from the live-run incidents

test('every own-object create fills the required custom attributes of its resource: a role with a required integer; ACME profile, RA profile, authority and upload definitions are read', async () => {
    core.rolesRequireAttr = true;
    const want = [{ version: 'v3', uuid: U(46), name: 'costCenter', contentType: 'integer', content: [{ data: 1, contentType: 'integer' }] }];
    const role = await createOwnRole(api, 'T', 'role-attr');
    expect(bodyOf('POST', '/api/v1/roles').customAttributes, `role ${role.name}`).toEqual(want);
    // The run's shared role goes through ensureRunRole (a planned name), a separate path from createOwnRole.
    const shared = await ensureRunRole(api, 'T');
    const sharedBody = server.arrived.filter((a) => a.method === 'POST' && a.url === '/api/v1/roles').map((a) => JSON.parse(a.body) as Json).find((b) => b.name === shared.name)!;
    expect(sharedBody.customAttributes, `shared role ${shared.name}`).toEqual(want);
    const acme = await ensureAcmeOnRaProfile(api, 'T');
    expect(bodyOf('POST', '/api/v1/acmeProfiles').customAttributes, 'no required attribute: an empty list').toEqual([]);
    const read = server.arrived.filter((a) => a.method === 'GET' && a.url.startsWith('/api/v1/attributes/custom/resources/')).map((a) => a.url.split('/').pop());
    expect(read, `definitions read for the ACME profile ${acme.acmeProfile.uuid} and its RA profile`).toEqual(expect.arrayContaining(['roles', 'acmeProfiles', 'raProfiles']));
});

test('recordDerivedKeyOf without a createdAfter still records the key, with a bound ahead of now that the teardown keeps — never a silent no-op', async () => {
    const cert = core.addCert(runName('f9.example.test'), 'issued');
    const t0 = Date.now();
    await recordDerivedKeyOf(api, cert.uuid, undefined, 'T');
    const line = readLedger().find((l) => l.type === 'keys' && l.uuid === cert.key.uuid)!;
    expect(line).toMatchObject({ derived: true, parents: { certificate: cert.uuid } });
    expect(Date.parse(line.createdAfter!), 'the bound lies ahead of the runner clock').toBeGreaterThan(t0 + 3_600_000);
    expect(derivedDeletable(line, new Date(Date.now() + 3_600_000).toISOString()), 'a key made now, even on a server clock an hour ahead, is kept').toBe(false);
});

test('recordDerivedKeyOrNamed: a failed detail read falls back to the by-name recording; a failure of that too surfaces', async () => {
    const cn = runName('f2.example.test');
    const cert = core.addCert(cn, 'issued');
    recordCreated('certificates', { uuid: cert.uuid, name: cn }, { spec: 'T', note: 'x' });
    core.failDetailReads = 1;
    await recordDerivedKeyOrNamed(api, cert.uuid, cn, '2026-10-14T00:00:00.000Z', 'T', 'x');
    expect(readLedger().filter((l) => l.type === 'keys').map((l) => l.uuid), 'the key is recorded by the second read').toEqual([cert.key.uuid]);
    const other = core.addCert(runName('f2b.example.test'), 'issued');
    core.failDetailReads = 2;
    await expect(recordDerivedKeyOrNamed(api, other.uuid, runName('f2b.example.test'), '2026-10-14T00:00:00.000Z', 'T', 'x')).rejects.toThrow(/500/);
});

test('uploadOwnCertificate: the derived key is recorded by name when its first detail read fails', async () => {
    const cn = runName('upload-f2');
    core.failDetailReads = 1;
    const ref = await uploadOwnCertificate(api, selfSignedPem(cn).pem, cn, 'T', 'uploaded');
    const cert = core.certs.find((c) => c.uuid === ref.uuid)!;
    expect(readLedger().filter((l) => l.event === 'created').map((l) => `${l.type}:${l.uuid}`)).toEqual([`certificates:${ref.uuid}`, `keys:${cert.key.uuid}`]);
});

test('isCredentialLogonRefusal names only the connector\'s logon refusal of the credential', () => {
    expect(isCredentialLogonRefusal('{"message":"STATUS_LOGON_FAILURE 0xc000006d from the connector"}')).toBe(true);
    expect(isCredentialLogonRefusal('Login failed for the account')).toBe(true);
    expect(isCredentialLogonRefusal('connector unreachable (timeout)')).toBe(false);
    expect(isCredentialLogonRefusal('attribute "template" is required')).toBe(false);
    expect(isCredentialLogonRefusal('')).toBe(false);
});
