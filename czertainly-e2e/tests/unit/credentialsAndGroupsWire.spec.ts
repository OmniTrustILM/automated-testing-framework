/**
 * Every request of the credential, group and RA-profile API specs on the wire: sent through a real request context
 * to a stateful loopback fake core (127.0.0.1), each test asserts what arrived and what the guard refused before
 * sending; an accepted create is in the ledger before the call returns. Covers credentialsApi, groupProbes and
 * raProfileValidation on one fake core.
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import * as forge from 'node-forge';
import { guardApi } from '../../utils/regression/guard/createGuard';
import { GuardedApi } from '../../utils/regression/guard/types';
import { readProbe } from '../../utils/regression/inventory/searchApi';
import { adoptByName, basicAttributes, bulkDeleteObjects, connectorWithoutCredentialGroup, createCredentialProbe, credentialBody, credentialSetup, ownCredential, putCredential, findRowByUuid, setCredentialEnabled, deleteOwnConfigObject } from '../../utils/regression/inventory/credentialsApi';
import { archiveOwnCertificate, certificateDetail, certificateHistory, changeKey, createGroupProbe, groupBody, groupChanges, ownGroup, ownGroupAttribute, patchCertificate, putGroup } from '../../utils/regression/inventory/groupProbes';
import { authorityWithRequiredAttribute, createRaProfileProbe, emptyAttributeCase, missingAttributeCase, raProfileBody, requiredAttributeNotFoundText, requiredAttributeNotSetText, validateRaAttributes, validRaAttributes } from '../../utils/regression/inventory/raProfileValidation';
import { customAttributeRequest, requiredCustomAttributes } from '../../utils/regression/customAttributes';
import { groupUuidsOf, setCertificateGroups } from '../../utils/regression/ownGroups';
import { uploadOwnSelfSigned } from '../../utils/regression/ownCertificates';
import { rowsNamed } from '../../utils/regression/listReads';
import { uniqueStamp } from '../../utils/regression/text';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { createOwnUser } from '../../utils/regression/ownUsers';
import { readLedger, recordCreated } from '../../utils/regression/ledger/ledger';
import { runName, runId } from '../../utils/regression/ledger/runState';
import { Answer, Arrived, loopbackServer, LoopbackServer } from './helpers/loopbackServer';
import { randomBytes } from 'node:crypto';
// Run-scoped generated test passwords (merge follow-up 2026-10-15): no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_2 = `qa-${randomBytes(9).toString('base64url')}`;

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C_CRED = U(1);
const C_OTHER = U(2);
const C_V2ONLY = U(3);
const DEF_USER = U(21);
const DEF_PASS = U(22);
const DEF_RA = U(23);
const A_EJBCA = U(11);
const A_NOREQ = U(12);
const A_DOWN = U(13);
const RA_SRC = U(31);
const FOREIGN_CRED = U(41);
const FOREIGN_GROUP = U(42);
const FOREIGN_CERT = U(43);
const FOREIGN_USER = U(44);
const REQUIRED_GROUP_ATTR = U(45);

type Json = Record<string, any>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = (type: string, id: string): Answer => ({ status: 404, body: { message: `Object of type '${type}' identified by ${id} is not found.` } });

/** A fake core: a small stateful model of credentials, groups, certificates, users, custom attributes and RA profiles. */
class FakeCore {
    seq = 5000;
    credentials = new Map<string, Json>();
    groups = new Map<string, Json>();
    certs = new Map<string, Json>();
    users = new Map<string, Json>();
    attrs = new Map<string, Json>();
    raProfiles = new Map<string, Json>();
    history = new Map<string, Json[]>();
    /** Required custom attribute definitions by resource code. */
    required: Record<string, Json[]> = { groups: [] };
    /** A create with a blank / null name is ACCEPTED (an accidental 2xx the ledger must still catch). */
    acceptBlank = false;
    /** An RA profile create is accepted whatever its attributes. */
    acceptRa = false;
    connectorHealthy = true;
    credentialDefs: Json[] = [
        { uuid: DEF_USER, name: 'username', type: 'data', contentType: 'string', properties: { label: 'Username', required: true } },
        { uuid: DEF_PASS, name: 'password', type: 'data', contentType: 'secret', properties: { label: 'Password', required: true } },
    ];
    raAttrStatus: Record<string, number> = {};

    next(): string {
        this.seq += 1;
        return `aaaaaaaa-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
    }

    answer = (a: Arrived): Answer | undefined => {
        const path = a.url.split('?')[0];
        const body = a.body ? (JSON.parse(a.body) as Json) : undefined;
        switch (a.method) {
            case 'GET': return this.get(path);
            case 'POST': return this.post(path, body);
            case 'PUT': return this.put(path, body);
            case 'PATCH': return this.patch(path, body);
            case 'DELETE': return this.del(path, body);
            default: return { status: 405, body: { message: 'no' } };
        }
    };

    private credentialDto(c: Json): Json {
        return {
            uuid: c.uuid, name: c.name, kind: c.kind, enabled: c.enabled, connectorUuid: c.connectorUuid, connectorName: 'Common-Credential-Connector',
            // The secret is masked: a content item without `data`.
            attributes: (c.attributes as Json[]).map((x) => ({ name: x.name, contentType: x.contentType, content: x.contentType === 'secret' ? (x.content ?? []).map(() => ({})) : x.content })),
            customAttributes: [],
        };
    }

    private get(path: string): Answer {
        let m: RegExpExecArray | null;
        const fixed: Record<string, unknown> = {
            '/api/v1/connectors': [
                { uuid: C_CRED, name: 'Common-Credential-Connector', status: 'connected', functionGroups: [{ functionGroupCode: 'credentialProvider', kinds: ['Basic'] }] },
                { uuid: C_V2ONLY, name: 'A-V2-Only-Connector', status: 'connected', functionGroups: [] },
                { uuid: C_OTHER, name: 'Other-Connector', status: 'connected', functionGroups: [{ functionGroupCode: 'authorityProvider', kinds: ['X'] }] },
                { uuid: U(4), name: `${runId()}-run-connector`, status: 'connected', functionGroups: [{ functionGroupCode: 'authorityProvider', kinds: ['X'] }] },
            ],
            [`/api/v2/connectors/${C_CRED}`]: { uuid: C_CRED, name: 'Common-Credential-Connector', version: 'v1' },
            '/api/v1/attributes/custom/resources/credentials': [],
            '/api/v1/attributes/custom/resources/groups': this.required.groups,
            '/api/v1/attributes/custom/resources/certificates': [],
            '/api/v1/attributes/custom/resources/raProfiles': [],
            '/api/v1/attributes/custom/resources/users': [],
            '/api/v1/authorities': [
                { uuid: A_NOREQ, name: 'a-no-required', status: 'connected', connectorName: 'PyADCS-Connector' },
                { uuid: A_DOWN, name: 'b-offline', status: 'offline', connectorName: 'MS-ADCS-NG-Connector' },
                { uuid: A_EJBCA, name: 'c-ejbca', status: 'connected', connectorName: 'EJBCA-NG-Connector' },
                { uuid: U(14), name: `${runId()}-own-authority`, status: 'connected', connectorName: 'EJBCA-NG-Connector' },
            ],
            [`/api/v1/authorities/${A_NOREQ}/attributes/raProfile`]: [{ uuid: U(24), name: 'note', type: 'data', contentType: 'string', properties: { label: 'Note', required: false } }],
            [`/api/v1/authorities/${A_EJBCA}/attributes/raProfile`]: [
                { uuid: U(25), name: 'info', type: 'info', contentType: 'string', properties: { label: 'Info', required: true } },
                { uuid: DEF_RA, name: 'endEntityProfile', type: 'data', contentType: 'object', version: 2, properties: { label: 'End Entity Profile', required: true } },
            ],
            [`/api/v1/authorities/${A_EJBCA}/raProfiles/${RA_SRC}`]: {
                uuid: RA_SRC, name: 'source-ra', attributes: [
                    { version: 2, uuid: DEF_RA, name: 'endEntityProfile', type: 'data', contentType: 'object', content: [{ reference: 'EE', data: { id: 1, name: 'EE' } }] },
                    { version: 2, uuid: U(26), name: 'note', type: 'info', contentType: 'string', content: [{ data: 'read only' }] },
                ],
            },
        };
        if (path === `/api/v1/connectors/${C_CRED}/health`) return this.connectorHealthy ? { status: 200, body: { status: 'ok' } } : { status: 503, body: { message: 'Error in connector communication' } };
        if (path === `/api/v1/connectors/${C_CRED}/attributes/credentialProvider/Basic`) return { status: 200, body: this.credentialDefs };
        if ((m = /^\/api\/v1\/authorities\/([0-9a-f-]{36})\/attributes\/raProfile$/.exec(path)) && this.raAttrStatus[m[1]]) return { status: this.raAttrStatus[m[1]], body: { message: 'Error in connector communication' } };
        if (Object.hasOwn(fixed, path)) return { status: 200, body: fixed[path] };
        if (path === '/api/v1/raProfiles') return { status: 200, body: [{ uuid: RA_SRC, name: 'source-ra', authorityInstanceUuid: A_EJBCA, enabled: true }, ...[...this.raProfiles.values()]] };
        if ((m = /^\/api\/v1\/raProfiles\/([0-9a-f-]{36})$/.exec(path))) {
            const r = this.raProfiles.get(m[1]);
            return r ? { status: 200, body: r } : notFound('RaProfile', m[1]);
        }
        if (path === '/api/v1/credentials') return { status: 200, body: [...this.credentials.values()].map((c) => ({ ...this.credentialDto(c), attributes: [] })) };
        if ((m = /^\/api\/v1\/credentials\/([0-9a-f-]{36})$/.exec(path))) {
            const c = this.credentials.get(m[1]);
            return c ? { status: 200, body: this.credentialDto(c) } : notFound('Credential', m[1]);
        }
        if (path === '/api/v1/groups') return { status: 200, body: [...this.groups.values()].map((g) => ({ uuid: g.uuid, name: g.name, description: g.description, email: g.email, customAttributes: null })) };
        if ((m = /^\/api\/v1\/groups\/([^/]+)\/users$/.exec(path))) return UUID_RE.test(m[1]) && this.groups.has(m[1]) ? { status: 200, body: [] } : notFound('Group', m[1]);
        if ((m = /^\/api\/v1\/groups\/([^/]+)$/.exec(path))) {
            if (!UUID_RE.test(m[1])) return { status: 422, body: [`Invalid UUID ${m[1]} in the request`] };
            const g = this.groups.get(m[1]);
            return g ? { status: 200, body: { uuid: g.uuid, name: g.name, description: g.description, email: g.email, customAttributes: g.customAttributes } } : notFound('Group', m[1]);
        }
        if ((m = /^\/api\/v1\/certificates\/([0-9a-f-]{36})\/history$/.exec(path))) return this.certs.has(m[1]) ? { status: 200, body: this.history.get(m[1]) ?? [] } : notFound('Certificate', m[1]);
        if ((m = /^\/api\/v1\/certificates\/([0-9a-f-]{36})$/.exec(path))) {
            const c = this.certs.get(m[1]);
            return c ? { status: 200, body: { ...c, groups: c.groups.map((u: string) => ({ uuid: u, name: this.groups.get(u)?.name })) } } : notFound('Certificate', m[1]);
        }
        if ((m = /^\/api\/v1\/users\/([0-9a-f-]{36})$/.exec(path))) {
            const u = this.users.get(m[1]);
            return u ? { status: 200, body: u } : notFound('User', m[1]);
        }
        if ((m = /^\/api\/v1\/attributes\/custom\/([0-9a-f-]{36})$/.exec(path))) {
            const x = this.attrs.get(m[1]);
            return x ? { status: 200, body: x } : notFound('CustomAttribute', m[1]);
        }
        return { status: 404, body: { message: `no fake route GET ${path}` } };
    }

    /** Attribute validation of a Basic credential or an RA profile: the connector's texts. */
    private missingTexts(attributes: Json[] | undefined, defs: Json[]): string[] {
        const out: string[] = [];
        for (const d of defs) {
            const a = (attributes ?? []).find((x) => x.name === d.name);
            if (!a) out.push(`Required attribute ${d.properties.label} not found.`);
            else if (a.content === undefined || a.content === null) out.push(`Value of required attribute ${d.properties.label} not set.`);
        }
        return out;
    }

    private raDefs = (authority: string): Json[] => (authority === A_EJBCA ? [{ name: 'endEntityProfile', properties: { label: 'End Entity Profile' } }] : []);

    private post(path: string, body: Json | undefined): Answer {
        let m: RegExpExecArray | null;
        if (path === '/api/v1/credentials') {
            const b = body ?? {};
            const blank = typeof b.name !== 'string' || !b.name.trim();
            if (blank && !this.acceptBlank) return { status: 422, body: ['Name must not be empty'] };
            if ([...this.credentials.values()].some((c) => c.name === b.name)) return { status: 409, body: { message: `Object of type 'Credential' identified by ${b.name} already exists.` } };
            if (b.connectorUuid === undefined) return { status: 500, body: { message: 'Internal server error.' } };
            if (!UUID_RE.test(String(b.connectorUuid))) return { status: 422, body: [`Invalid UUID ${b.connectorUuid} in the request`] };
            if (b.connectorUuid !== C_CRED) return notFound('Connector', b.connectorUuid);
            if (b.kind !== 'Basic') return { status: 422, body: [`Unsupported credential kind ${b.kind}`] };
            const missing = this.missingTexts(b.attributes, this.credentialDefs);
            const uuid = this.next();
            const byName = (b.attributes ?? []).some((x: Json) => !x.uuid);
            if (byName) {
                // core#2512: the credential row is saved before the attribute lookup fails.
                this.credentials.set(uuid, { uuid, name: b.name, kind: b.kind, enabled: true, connectorUuid: b.connectorUuid, attributes: [] });
                return { status: 404, body: { message: "Object of type 'AttributeDefinition' identified by username is not found." } };
            }
            if (missing.length && !(blank && this.acceptBlank)) return { status: 422, body: missing };
            this.credentials.set(uuid, { uuid, name: b.name, kind: b.kind, enabled: true, connectorUuid: b.connectorUuid, attributes: b.attributes ?? [] });
            return { status: 201, body: { uuid } };
        }
        if (path === '/api/v1/groups') {
            const b = body ?? {};
            const blank = typeof b.name !== 'string' || !b.name.trim();
            if (blank && !this.acceptBlank) return { status: 422, body: ['Name must not be empty'] };
            if ([...this.groups.values()].some((g) => g.name === b.name)) return { status: 409, body: { message: `Object of type 'Group' identified by ${b.name} already exists.` } };
            const uuid = this.next();
            this.groups.set(uuid, { uuid, name: b.name, description: b.description, email: b.email, customAttributes: b.customAttributes ?? [] });
            return { status: 201, body: { uuid } };
        }
        if (path === '/api/v1/attributes/custom') {
            const uuid = this.next();
            this.attrs.set(uuid, { uuid, name: body?.name });
            return { status: 200, body: { uuid, name: body?.name } };
        }
        if (path === '/api/v1/users') {
            const uuid = this.next();
            this.users.set(uuid, { uuid, username: body?.username });
            return { status: 200, body: { uuid } };
        }
        if (path === '/api/v1/certificates/upload') {
            const pem = Buffer.from(String(body?.certificate), 'base64').toString('utf8');
            const cn = forge.pki.certificateFromPem(pem).subject.getField('CN').value as string;
            const uuid = this.next();
            this.certs.set(uuid, { uuid, commonName: cn, groups: [], archived: false, ownerUuid: null, key: { uuid: this.next() } });
            this.history.set(uuid, [{ event: 'Upload Certificate', status: 'SUCCESS', message: 'Certificate uploaded' }]);
            return { status: 200, body: { uuid } };
        }
        if ((m = /^\/api\/v1\/authorities\/([0-9a-f-]{36})\/attributes\/raProfile\/validate$/.exec(path))) {
            const problems = this.missingTexts(body as unknown as Json[], this.raDefs(m[1]));
            return problems.length ? { status: 422, body: problems } : { status: 200 };
        }
        if ((m = /^\/api\/v1\/authorities\/([0-9a-f-]{36})\/raProfiles$/.exec(path))) {
            const problems = this.missingTexts(body?.attributes, this.raDefs(m[1]));
            if (problems.length && !this.acceptRa) return { status: 422, body: problems };
            const uuid = this.next();
            this.raProfiles.set(uuid, { uuid, name: body?.name, authorityInstanceUuid: m[1], enabled: false });
            return { status: 200, body: { uuid, name: body?.name } };
        }
        return { status: 404, body: { message: `no fake route POST ${path}` } };
    }

    private put(path: string, body: Json | undefined): Answer {
        let m: RegExpExecArray | null;
        if ((m = /^\/api\/v1\/credentials\/([0-9a-f-]{36})$/.exec(path))) {
            const c = this.credentials.get(m[1]);
            if (!c) return notFound('Credential', m[1]);
            const missing = this.missingTexts(body?.attributes, this.credentialDefs);
            if (missing.length) return { status: 422, body: missing };
            c.attributes = body?.attributes ?? [];
            return { status: 200, body: this.credentialDto(c) };
        }
        if ((m = /^\/api\/v1\/groups\/([0-9a-f-]{36})$/.exec(path))) {
            const g = this.groups.get(m[1]);
            if (!g) return notFound('Group', m[1]);
            Object.assign(g, { description: body?.description, email: body?.email, customAttributes: body?.customAttributes ?? [] });
            return { status: 200, body: g };
        }
        return { status: 404, body: { message: `no fake route PUT ${path}` } };
    }

    private patch(path: string, body: Json | undefined): Answer {
        let m: RegExpExecArray | null;
        if ((m = /^\/api\/v1\/credentials\/([0-9a-f-]{36})\/(enable|disable)$/.exec(path))) {
            const c = this.credentials.get(m[1]);
            if (!c) return notFound('Credential', m[1]);
            c.enabled = m[2] === 'enable';
            return { status: 204 };
        }
        if ((m = /^\/api\/v1\/certificates\/([0-9a-f-]{36})\/archive$/.exec(path))) {
            const c = this.certs.get(m[1]);
            if (!c) return notFound('Certificate', m[1]);
            c.archived = true;
            return { status: 204 };
        }
        if ((m = /^\/api\/v1\/certificates\/([0-9a-f-]{36})$/.exec(path))) {
            const c = this.certs.get(m[1]);
            if (!c) return notFound('Certificate', m[1]);
            const requested = body?.groupUuids as string[] | null | undefined;
            if (requested) {
                if (requested.some((u) => !UUID_RE.test(u))) return { status: 400, body: { message: 'The request could not be processed.' } };
                if (c.archived) return { status: 422, body: [`Certificate with UUID ${m[1]} is archived and its groups cannot be updated.`] };
                const bad = requested.find((u) => !this.groups.has(u));
                if (bad) return notFound('Group', bad);
                const next = [...new Set(requested)];
                if (JSON.stringify([...next].sort()) !== JSON.stringify([...c.groups].sort())) {
                    const names = (l: string[]) => (l.length ? l.map((u) => this.groups.get(u)?.name).join(', ') : 'undefined');
                    this.history.get(m[1])!.push({ event: 'Update Group', status: 'SUCCESS', message: `${names(c.groups)} -> ${names(next)}` });
                    c.groups = next;
                }
            }
            if (body?.ownerUuid) c.ownerUuid = body.ownerUuid;
            return { status: 204 };
        }
        return { status: 404, body: { message: `no fake route PATCH ${path}` } };
    }

    private del(path: string, body: unknown): Answer {
        let m: RegExpExecArray | null;
        if ((m = /^\/api\/v1\/(credentials|groups)\/([0-9a-f-]{36})$/.exec(path))) {
            const store = m[1] === 'credentials' ? this.credentials : this.groups;
            if (!store.has(m[2])) return notFound(m[1] === 'credentials' ? 'Credential' : 'Group', m[2]);
            store.delete(m[2]);
            if (m[1] === 'groups') for (const c of this.certs.values()) c.groups = c.groups.filter((u: string) => u !== m![2]);
            return { status: 204 };
        }
        if ((m = /^\/api\/v1\/(credentials|groups)$/.exec(path))) {
            const store = m[1] === 'credentials' ? this.credentials : this.groups;
            for (const u of body as string[]) store.delete(u);
            return { status: 204 };
        }
        return { status: 404, body: { message: `no fake route DELETE ${path}` } };
    }
}

let server: LoopbackServer;
let core: FakeCore;
let raw: APIRequestContext;
let api: GuardedApi;

const ENV_KEYS = ['REG_STATE_DIR', 'BASE_URL', 'TIER_KIND', 'REG_RUN_ID', 'REG_CREDENTIAL_CONNECTOR', 'REG_REQUIRED_CONNECTORS', 'API_TEARDOWN_DRY_RUN'];
let saved: Record<string, string | undefined> = {};

test.beforeAll(async () => {
    server = await loopbackServer((a) => core.answer(a));
});

test.afterAll(async () => {
    await server.close();
});

test.beforeEach(async ({}, testInfo) => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.REG_STATE_DIR = testInfo.outputPath('state');
    process.env.BASE_URL = `${server.origin}/administrator/`;
    process.env.TIER_KIND = 'shared';
    process.env.REG_RUN_ID = runId();
    core = new FakeCore();
    server.reset();
    raw = await request.newContext({ baseURL: process.env.BASE_URL, extraHTTPHeaders: { Authorization: 'Bearer SECRET-TOKEN' } });
    api = guardApi(raw);
});

test.afterEach(async () => {
    await api.dispose();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

const wire = () => server.mutations().map((a) => `${a.method} ${a.url}`);
const lastBody = (method: string, url: string): Json => JSON.parse([...server.arrived].reverse().find((a) => a.method === method && a.url === url)!.body);

/** `sent` when the request left, else the refusal kind (a guard refusal) or the error. */
async function outcome(call: Promise<unknown>): Promise<string> {
    try {
        await call;
        return 'sent';
    } catch (e) {
        return e instanceof OwnObjectViolation ? e.kind : `error: ${String(e).slice(0, 160)}`;
    }
}

const connector = async () => {
    const s = await credentialSetup(api);
    if (!s.ok) throw new Error(s.skip);
    return s.ok;
};

// ------------------------------------------------------------------ the credential connector

test('credentialSetup: the connector, live health and the Basic definitions are read (GETs only); every other state is a named skip reason', async () => {
    const s = await credentialSetup(api);
    expect(s.ok).toMatchObject({ uuid: C_CRED, name: 'Common-Credential-Connector' });
    expect(s.ok!.usernameDef.uuid).toBe(DEF_USER);
    expect(wire(), 'reads only').toEqual([]);

    process.env.REG_CREDENTIAL_CONNECTOR = 'Ghost-Credential-Connector';
    expect((await credentialSetup(api)).skip).toBe('connector Ghost-Credential-Connector is not registered on this tier (REG_CREDENTIAL_CONNECTOR names another one)');
    delete process.env.REG_CREDENTIAL_CONNECTOR;

    core.connectorHealthy = false;
    expect((await credentialSetup(api)).skip).toMatch(/Common-Credential-Connector: stored connected, live health 503 — environment blocker/);
    core.connectorHealthy = true;

    core.credentialDefs = [core.credentialDefs[0]];
    expect((await credentialSetup(api)).skip).toBe('Common-Credential-Connector: the Basic kind has no username / password data attributes');
    core.credentialDefs = [core.credentialDefs[0], { ...core.credentialDefs[0], name: 'password', contentType: 'string' }];
    expect((await credentialSetup(api)).skip).toMatch(/not secret/);
    expect(wire()).toEqual([]);
});

test('connectorWithoutCredentialGroup: the first pre-existing connector with function groups but no credentialProvider (a run-family connector and an empty v2 record are skipped)', async () => {
    expect(await connectorWithoutCredentialGroup(api)).toEqual({ uuid: C_OTHER, name: 'Other-Connector' });
    expect(wire()).toEqual([]);
});

// ------------------------------------------------------------------ API-GEN-17: credentials as the spec sends them

test('credentials: an own Basic credential is created, changed, toggled and deleted through the guard; the connector is a waived reference; the secret is in no body the helpers read', async () => {
    const c = await connector();
    const own = await ownCredential(api, c, 'T', { suffix: 'mask' });
    expect(wire()).toEqual(['POST /api/v1/credentials']);
    const sent = lastBody('POST', '/api/v1/credentials');
    expect(sent).toMatchObject({ name: own.ref.name, connectorUuid: C_CRED, kind: 'Basic', customAttributes: [] });
    expect(sent.name.startsWith(`${runId()}-`)).toBe(true);
    expect(sent.attributes).toEqual([
        { version: 'v2', uuid: DEF_USER, name: 'username', contentType: 'string', content: [{ data: own.username }] },
        { version: 'v2', uuid: DEF_PASS, name: 'password', contentType: 'secret', content: [{ data: { secret: own.password } }] },
    ]);
    expect(readLedger().find((l) => l.uuid === own.ref.uuid)).toMatchObject({ type: 'credentials', name: own.ref.name, event: 'created' });

    // Reads (GET detail, list) are plain reads; the helpers parse the masked answer.
    const detail = await readProbe(api, `/api/v1/credentials/${own.ref.uuid}`);
    expect(detail.text.includes(own.password), 'the fake masks the secret like core').toBe(false);
    expect((await findRowByUuid(api, '/api/v1/credentials', own.ref.uuid))?.name).toBe(own.ref.name);

    server.reset();
    expect((await putCredential(api, own.ref.uuid, basicAttributes(c, { username: 'u2', password: GEN_PW_1 }), [], { name: 'ignored' })).status).toBe(200);
    expect((await setCredentialEnabled(api, own.ref.uuid, false)).status).toBe(204);
    expect((await setCredentialEnabled(api, own.ref.uuid, true)).status).toBe(204);
    expect(wire()).toEqual([`PUT /api/v1/credentials/${own.ref.uuid}`, `PATCH /api/v1/credentials/${own.ref.uuid}/disable`, `PATCH /api/v1/credentials/${own.ref.uuid}/enable`]);
    expect(lastBody('PUT', `/api/v1/credentials/${own.ref.uuid}`).name, 'the ignored name is sent as the test sends it').toBe('ignored');
    // PUT without the password: the connector's 422, nothing changed.
    expect((await putCredential(api, own.ref.uuid, basicAttributes(c, { username: 'u3' }), [])).status).toBe(422);
});

test('credentials: delete own, bulk delete [own, probe] and unknown-uuid arms are sent; a foreign credential, a foreign bulk list and an empty list are refused', async () => {
    const c = await connector();
    const a = await ownCredential(api, c, 'T', { suffix: 'del' });
    const b = await ownCredential(api, c, 'T', { suffix: 'bulk' });
    server.reset();
    const probe = api.probeUuid();

    expect((await deleteOwnConfigObject(api, 'credentials', a.ref.uuid)).status).toBe(204);
    expect((await bulkDeleteObjects(api, 'credentials', [b.ref.uuid, probe])).status).toBe(204);
    expect(wire()).toEqual([`DELETE /api/v1/credentials/${a.ref.uuid}`, 'DELETE /api/v1/credentials']);
    expect(lastBody('DELETE', '/api/v1/credentials')).toEqual([b.ref.uuid, probe]);
    expect((await readProbe(api, `/api/v1/credentials/${a.ref.uuid}`)).status).toBe(404);

    server.reset();
    expect(await outcome(deleteOwnConfigObject(api, 'credentials', FOREIGN_CRED))).toBe('ownership');
    expect(await outcome(putCredential(api, FOREIGN_CRED, [], []))).toBe('ownership');
    expect(await outcome(setCredentialEnabled(api, FOREIGN_CRED, false))).toBe('ownership');
    expect(await outcome(bulkDeleteObjects(api, 'credentials', [FOREIGN_CRED, probe]))).toBe('ownership');
    expect(await outcome(bulkDeleteObjects(api, 'credentials', []))).toBe('request');
    expect(wire(), 'nothing was sent').toEqual([]);
});

test('credentials: a probe uuid is a legal target of PUT / PATCH / DELETE (the unknown-uuid arms)', async () => {
    const probe = api.probeUuid();
    expect(await outcome(putCredential(api, probe, [], []))).toBe('sent');
    expect(await outcome(setCredentialEnabled(api, probe, true))).toBe('sent');
    expect(await outcome(deleteOwnConfigObject(api, 'credentials', probe))).toBe('sent');
    expect(wire()).toEqual([`PUT /api/v1/credentials/${probe}`, `PATCH /api/v1/credentials/${probe}/enable`, `DELETE /api/v1/credentials/${probe}`]);
});

// ------------------------------------------------------------------ API-GEN-18: the validation matrix

test('credential matrix: every probe body is sent (blank / null / whitespace name, malformed / unknown / missing connector, other kind, empty or by-name attributes) and refused by the fake core; nothing refused is in the ledger', async () => {
    const c = await connector();
    const attrs = basicAttributes(c, { username: 'u', password: GEN_PW_2 });
    const base = (name: unknown, over: Json = {}) => credentialBody(c, name, attrs, [], over);
    const rows: Array<[string, Json, number]> = [
        ['blank', base(''), 422], ['null', base(null), 422], ['whitespace', base('   '), 422],
        ['connector not a uuid', base(runName('a'), { connectorUuid: 'not-a-uuid' }), 422],
        ['connector unknown', base(runName('b'), { connectorUuid: api.probeUuid() }), 404],
        ['connector missing', base(runName('c'), { connectorUuid: undefined }), 500],
        ['connector of another function group', base(runName('d'), { connectorUuid: C_OTHER }), 404],
        ['kind', base(runName('e'), { kind: 'QaNoSuchKind' }), 422],
        ['attributes empty', base(runName('f'), { attributes: [] }), 422],
        ['password without content', credentialBody(c, runName('g'), basicAttributes(c, { username: 'u', password: null }), []), 422],
        ['no username', credentialBody(c, runName('h'), basicAttributes(c, { password: GEN_PW_2 }), []), 422],
    ];
    for (const [what, body, status] of rows) {
        const { probe, own } = await createCredentialProbe(api, body, 'T', what);
        expect(probe.status, what).toBe(status);
        expect(own, `${what}: nothing created`).toBeUndefined();
    }
    expect(wire()).toHaveLength(rows.length);
    expect(readLedger().filter((l) => l.event === 'created'), 'a refused create writes no ledger line').toEqual([]);
    // A foreign connector uuid is a REFERENCE field of an own create: waived (the connector is only referenced).
    expect(JSON.parse(server.arrived.find((a) => a.url === '/api/v1/credentials' && JSON.parse(a.body).connectorUuid === C_OTHER)!.body).connectorUuid).toBe(C_OTHER);
});

test('credential matrix: a duplicate name answers 409 with the one credential in the list; the second create is never a ledger line', async () => {
    const c = await connector();
    const first = await ownCredential(api, c, 'T', { suffix: 'dup' });
    const { probe, own } = await createCredentialProbe(api, credentialBody(c, first.ref.name, basicAttributes(c, { username: 'u', password: GEN_PW_2 }), []), 'T', 'duplicate');
    expect(probe.status).toBe(409);
    expect(own).toBeUndefined();
    expect((await rowsNamed(api, '/api/v1/credentials', first.ref.name)).map((r) => r.uuid)).toEqual([first.ref.uuid]);
    expect(readLedger().filter((l) => l.event === 'created')).toHaveLength(1);
});

test('credential matrix: an ACCIDENTAL 2xx is in the ledger before the helper returns (blank, null and whitespace names, the empty-string password pin)', async () => {
    const c = await connector();
    core.acceptBlank = true;
    const attrs = basicAttributes(c, { username: 'u', password: GEN_PW_2 });
    const blank = await createCredentialProbe(api, credentialBody(c, '', attrs, []), 'T', 'blank');
    const nulled = await createCredentialProbe(api, credentialBody(c, null, attrs, []), 'T', 'null');
    expect(blank.probe.status).toBe(201);
    expect(nulled.probe.status).toBe(201);
    const lines = readLedger().filter((l) => l.event === 'created' && l.type === 'credentials');
    expect(lines.map((l) => l.uuid).sort()).toEqual([blank.own!.uuid, nulled.own!.uuid].sort());
    expect(lines.map((l) => l.name).sort(), 'no run prefix: the teardown reports such a line instead of deleting it').toEqual(['', '(no name)']);

    const pin = await createCredentialProbe(api, credentialBody(c, runName(`pin-${uniqueStamp()}`), basicAttributes(c, { username: 'u', password: '' }), []), 'T', 'empty password');
    expect(pin.probe.status).toBe(201);
    expect(readLedger().some((l) => l.uuid === pin.own!.uuid && l.type === 'credentials')).toBe(true);
    expect(lastBody('POST', '/api/v1/credentials').attributes[1].content).toEqual([{ data: { secret: '' } }]);
});

test('credential matrix: the by-name shape is sent without uuids; the orphan the refused create left is adopted by its unique name (once)', async () => {
    const c = await connector();
    const name = runName(`byname-${uniqueStamp()}`);
    const { probe, own } = await createCredentialProbe(api, credentialBody(c, name, basicAttributes(c, { username: 'u', password: GEN_PW_2 }, { withUuid: false }), []), 'T', 'by name');
    expect(probe.status).toBe(404);
    expect(own, 'the refused answer carries no uuid').toBeUndefined();
    expect(lastBody('POST', '/api/v1/credentials').attributes.every((x: Json) => !('uuid' in x))).toBe(true);
    const orphans = await adoptByName(api, '/api/v1/credentials', 'credentials', name, 'T', 'orphan (core#2512)');
    expect(orphans).toHaveLength(1);
    expect(readLedger().filter((l) => l.uuid === orphans[0].uuid)).toMatchObject([{ type: 'credentials', name, event: 'created', note: 'orphan (core#2512)' }]);
    await adoptByName(api, '/api/v1/credentials', 'credentials', name, 'T', 'orphan (core#2512)');
    expect(readLedger().filter((l) => l.uuid === orphans[0].uuid), 'adopting twice records once').toHaveLength(1);
    // The adopted orphan is an own credential: the guard accepts a delete of it.
    expect(await outcome(deleteOwnConfigObject(api, 'credentials', orphans[0].uuid))).toBe('sent');
});

// ------------------------------------------------------------------ API-GEN-19: groups

test('groups: own groups are created (required custom attributes filled), put, deleted and bulk-deleted through the guard; probe uuids are legal targets', async () => {
    core.required.groups = [{ uuid: REQUIRED_GROUP_ATTR, name: 'team', contentType: 'string', properties: { required: true } }];
    const g = await ownGroup(api, 'T', { description: 'd', email: 'e@example.test' }, { suffix: 'grp' });
    const sent = lastBody('POST', '/api/v1/groups');
    expect(sent).toMatchObject({ name: g.name, description: 'd', email: 'e@example.test' });
    expect(sent.customAttributes, 'the tier\'s required custom attribute is filled').toEqual([{ version: 'v3', uuid: REQUIRED_GROUP_ATTR, name: 'team', contentType: 'string', content: [{ data: runName('ca'), contentType: 'string' }] }]);
    expect(readLedger().find((l) => l.uuid === g.uuid)).toMatchObject({ type: 'groups', event: 'created' });

    server.reset();
    const other = await ownGroup(api, 'T', {}, { suffix: 'grp2' });
    const probe = api.probeUuid();
    expect((await putGroup(api, g.uuid, { name: 'ignored', description: 'x' })).status).toBe(200);
    expect(await outcome(putGroup(api, probe, { description: 'x' }))).toBe('sent');
    expect(await outcome(deleteOwnConfigObject(api, 'groups', probe))).toBe('sent');
    expect((await bulkDeleteObjects(api, 'groups', [other.uuid, probe])).status).toBe(204);
    expect((await deleteOwnConfigObject(api, 'groups', g.uuid)).status).toBe(204);
    expect(lastBody('DELETE', '/api/v1/groups')).toEqual([other.uuid, probe]);

    expect(await outcome(putGroup(api, FOREIGN_GROUP, {}))).toBe('ownership');
    expect(await outcome(deleteOwnConfigObject(api, 'groups', FOREIGN_GROUP))).toBe('ownership');
    expect(await outcome(bulkDeleteObjects(api, 'groups', [FOREIGN_GROUP]))).toBe('ownership');
});

test('groups: blank / null / whitespace names and a duplicate are sent and refused; an accepted trailing-space name, a 301-character description and a bad e-mail are own groups', async () => {
    for (const name of ['', null, '   ']) {
        const { probe, own } = await createGroupProbe(api, groupBody(name, { description: 'x' }), 'T', 'blank');
        expect(probe.status).toBe(422);
        expect(own).toBeUndefined();
    }
    const first = await ownGroup(api, 'T', {}, { suffix: 'dup' });
    const second = await createGroupProbe(api, groupBody(first.name, {}), 'T', 'dup');
    expect(second.probe.status).toBe(409);
    expect((await rowsNamed(api, '/api/v1/groups', first.name)).map((r) => r.uuid)).toEqual([first.uuid]);

    const trailing = `${runName(`space-${uniqueStamp()}`)} `;
    const t = await createGroupProbe(api, groupBody(trailing, { description: 'd'.repeat(301), email: 'notanemail' }), 'T', 'Q8');
    expect(t.probe.status).toBe(201);
    expect(readLedger().find((l) => l.uuid === t.own!.uuid)).toMatchObject({ type: 'groups', name: trailing });
    expect(await outcome(deleteOwnConfigObject(api, 'groups', t.own!.uuid)), 'a trailing-space name still carries the run prefix: own').toBe('sent');
});

test('PUT / DELETE /v1/groups/not-a-uuid are the two exact malformed-uuid probes the guard sends (rule 6a skipped, body rules stay); any other literal or a body with a foreign uuid is still refused; the GET is a plain read', async () => {
    // Before the guard pass these were refused as a name-keyed path (kind request): the old pin of this test.
    expect(await outcome(putGroup(api, 'not-a-uuid', { description: 'x' }))).toBe('sent');
    expect(await outcome(deleteOwnConfigObject(api, 'groups', 'not-a-uuid'))).toBe('sent');
    expect(wire()).toEqual(['PUT /api/v1/groups/not-a-uuid', 'DELETE /api/v1/groups/not-a-uuid']);
    server.reset();
    // Not an exact probe literal: refused as before, nothing sent.
    expect(await outcome(putGroup(api, 'some-name', { description: 'x' }))).toBe('request');
    expect(await outcome(deleteOwnConfigObject(api, 'groups', 'some-name'))).toBe('request');
    expect(wire()).toEqual([]);
    const read = await readProbe(api, '/api/v1/groups/not-a-uuid');
    expect(read.status).toBe(422);
    expect(read.json).toEqual(['Invalid UUID not-a-uuid in the request']);
});

test('groups: the own custom attribute on groups is a create the ledger records; its value request attribute is {uuid, name, contentType, content}', async () => {
    const attribute = await ownGroupAttribute(api, 'T');
    expect(lastBody('POST', '/api/v1/attributes/custom')).toMatchObject({ name: attribute.name, contentType: 'string', required: false, resources: ['groups'] });
    expect(readLedger().find((l) => l.uuid === attribute.uuid)).toMatchObject({ type: 'customAttributes', event: 'created' });
    expect(customAttributeRequest(attribute, 'v1')).toEqual({ uuid: attribute.uuid, name: attribute.name, contentType: 'string', content: [{ data: 'v1' }] });
    // The attribute subtree of a group create is not scanned for uuids: the own attribute travels in customAttributes.
    const g = await ownGroup(api, 'T', { customAttributes: [customAttributeRequest(attribute, 'v1')] });
    expect(lastBody('POST', '/api/v1/groups').customAttributes).toEqual([customAttributeRequest(attribute, 'v1')]);
    expect(g.uuid).toMatch(UUID_RE);
});

// ------------------------------------------------------------------ API-GEN-20: certificates and groups

test('uploadOwnSelfSigned: the self-signed upload is a create; the certificate and its derived key are in the ledger right after the call', async () => {
    const cert = await uploadOwnSelfSigned(api, 'T');
    expect(wire()).toEqual(['POST /api/v1/certificates/upload']);
    expect(cert.cn.startsWith(`${runId()}-`)).toBe(true);
    const lines = readLedger().filter((l) => l.event === 'created');
    expect(lines.map((l) => l.type)).toEqual(['certificates', 'keys']);
    expect(lines[0]).toMatchObject({ uuid: cert.uuid, name: cert.cn });
    expect(lines[1]).toMatchObject({ derived: true });
    expect(lines[1].createdAfter).toBeTruthy();
    expect(groupUuidsOf(await certificateDetail(api, cert.uuid))).toEqual([]);
});

test('group assignment: PATCH with groupUuids -> own groups (duplicates, [], null, key omitted, a malformed string, a probe) and ownerUuid -> an own user is sent; the history and the sets read back', async () => {
    const cert = await uploadOwnSelfSigned(api, 'T');
    const [g1, g2, g3] = [await ownGroup(api, 'T'), await ownGroup(api, 'T'), await ownGroup(api, 'T')];
    const owner = await createOwnUser(api, 'T', 'cfg-owner');
    server.reset();

    await setCertificateGroups(api, cert.uuid, [g1.uuid, g2.uuid]);
    expect(groupUuidsOf(await certificateDetail(api, cert.uuid))).toEqual([g1.uuid, g2.uuid].sort());
    expect((await patchCertificate(api, cert.uuid, {})).status).toBe(204);
    expect((await patchCertificate(api, cert.uuid, { groupUuids: null })).status).toBe(204);
    expect(groupUuidsOf(await certificateDetail(api, cert.uuid)), 'omitted and null leave the set').toEqual([g1.uuid, g2.uuid].sort());
    expect((await patchCertificate(api, cert.uuid, { groupUuids: [g3.uuid, g3.uuid] })).status).toBe(204);
    expect(groupUuidsOf(await certificateDetail(api, cert.uuid))).toEqual([g3.uuid]);
    expect((await patchCertificate(api, cert.uuid, { groupUuids: [g3.uuid] })).status, 'the identical set').toBe(204);
    expect((await patchCertificate(api, cert.uuid, { groupUuids: [] })).status).toBe(204);
    expect(groupUuidsOf(await certificateDetail(api, cert.uuid))).toEqual([]);
    expect((await patchCertificate(api, cert.uuid, { groupUuids: ['not-a-uuid'] })).status).toBe(400);
    const unknown = api.probeUuid();
    expect((await patchCertificate(api, cert.uuid, { groupUuids: [unknown] })).status).toBe(404);
    expect((await patchCertificate(api, cert.uuid, { ownerUuid: owner.uuid })).status).toBe(204);
    expect((await certificateDetail(api, cert.uuid)).ownerUuid).toBe(owner.uuid);
    expect(wire().every((w) => w === `PATCH /api/v1/certificates/${cert.uuid}`)).toBe(true);
    expect(wire()).toHaveLength(9);

    const changes = groupChanges(await certificateHistory(api, cert.uuid)).map(changeKey);
    expect(changes, 'three real changes; the identical set, null and omitted wrote nothing').toEqual([
        `undefined -> ${[g1.name, g2.name].sort().join(', ')}`,
        `${[g1.name, g2.name].sort().join(', ')} -> ${g3.name}`,
        `${g3.name} -> undefined`,
    ].map((k) => k));
});

test('group assignment: a foreign group, a foreign owner, a group uuid in ownerUuid and a foreign certificate are refused by the guard; nothing is sent', async () => {
    const cert = await uploadOwnSelfSigned(api, 'T');
    const g = await ownGroup(api, 'T');
    const owner = await createOwnUser(api, 'T', 'cfg-owner');
    server.reset();
    expect(await outcome(patchCertificate(api, cert.uuid, { groupUuids: [g.uuid, FOREIGN_GROUP] }))).toBe('ownership');
    expect(await outcome(patchCertificate(api, cert.uuid, { ownerUuid: FOREIGN_USER }))).toBe('ownership');
    expect(await outcome(patchCertificate(api, cert.uuid, { ownerUuid: g.uuid })), 'an own GROUP is not an own USER').toBe('ownership');
    expect(await outcome(patchCertificate(api, cert.uuid, { groupUuids: [owner.uuid] })), 'an own USER is not an own GROUP').toBe('ownership');
    expect(await outcome(patchCertificate(api, FOREIGN_CERT, { groupUuids: [g.uuid] }))).toBe('ownership');
    expect(await outcome(archiveOwnCertificate(api, FOREIGN_CERT))).toBe('ownership');
    expect(wire()).toEqual([]);
});

test('archiveOwnCertificate: an own certificate is archived (204); the group change of the archived certificate is a plain own-certificate PATCH the core refuses with 422', async () => {
    const cert = await uploadOwnSelfSigned(api, 'T');
    const [g1, g2] = [await ownGroup(api, 'T'), await ownGroup(api, 'T')];
    await setCertificateGroups(api, cert.uuid, [g1.uuid]);
    server.reset();
    await archiveOwnCertificate(api, cert.uuid);
    expect(wire()).toEqual([`PATCH /api/v1/certificates/${cert.uuid}/archive`]);
    const refused = await patchCertificate(api, cert.uuid, { groupUuids: [g2.uuid] });
    expect(refused.status).toBe(422);
    expect(refused.json).toEqual([`Certificate with UUID ${cert.uuid} is archived and its groups cannot be updated.`]);
    expect(groupUuidsOf(await certificateDetail(api, cert.uuid))).toEqual([g1.uuid]);
});

// ------------------------------------------------------------------ API-GEN-28: RA profile with a required attribute

test('authorityWithRequiredAttribute: the first connected pre-existing authority by name whose RA-profile schema has a required DATA attribute; reads only; every other state is a named reason', async () => {
    const pick = await authorityWithRequiredAttribute(api);
    expect(pick.ok).toMatchObject({ uuid: A_EJBCA, connectorName: 'EJBCA-NG-Connector' });
    expect(pick.ok!.required.map((d) => d.name), 'an info attribute and a run-family authority never count').toEqual(['endEntityProfile']);
    expect(wire()).toEqual([]);

    core.raAttrStatus[A_EJBCA] = 503;
    const none = await authorityWithRequiredAttribute(api);
    expect(none.skip).toMatch(/no connected pre-existing authority whose RA-profile schema holds a required attribute \(PyADCS-Connector: no required RA-profile attribute; EJBCA-NG-Connector: the RA-profile attribute read answered 503\); the suite never creates an authority/);
    expect(wire()).toEqual([]);
});

test('validRaAttributes copies the data attributes of an enabled pre-existing RA profile as request attributes; the arms and the validate POST (a read) are sent through the guard', async () => {
    const base = (await validRaAttributes(api, A_EJBCA))!;
    expect(base).toEqual([{ version: 'v2', uuid: DEF_RA, name: 'endEntityProfile', contentType: 'object', content: [{ reference: 'EE', data: { id: 1, name: 'EE' } }] }]);
    expect(await validRaAttributes(api, A_NOREQ), 'no RA profile on the authority').toBeUndefined();
    const def = (await authorityWithRequiredAttribute(api)).ok!.required[0];
    server.reset();

    const valid = await validateRaAttributes(api, A_EJBCA, base);
    expect(valid.status).toBe(200);
    const missing = await validateRaAttributes(api, A_EJBCA, missingAttributeCase(base, def));
    expect([missing.status, missing.json]).toEqual([422, [requiredAttributeNotFoundText('End Entity Profile')]]);
    const empty = await validateRaAttributes(api, A_EJBCA, emptyAttributeCase(base, def));
    expect([empty.status, empty.json]).toEqual([422, [requiredAttributeNotSetText('End Entity Profile')]]);
    expect(wire()).toEqual(Array(3).fill(`POST /api/v1/authorities/${A_EJBCA}/attributes/raProfile/validate`));
    expect(lastBody('POST', `/api/v1/authorities/${A_EJBCA}/attributes/raProfile/validate`)).toEqual([{ version: 'v2', uuid: DEF_RA, name: 'endEntityProfile', contentType: 'object' }]);
});

test('RA profile create probe: a pre-existing authority is only a scope parent; a refused create writes no ledger line, an accidental 2xx is recorded with its authority before any assertion', async () => {
    const base = (await validRaAttributes(api, A_EJBCA))!;
    const def = (await authorityWithRequiredAttribute(api)).ok!.required[0];
    const name = runName(`ra-neg-${uniqueStamp()}`);
    server.reset();

    const refused = await createRaProfileProbe(api, A_EJBCA, await raProfileBody(api, name, missingAttributeCase(base, def)), 'T', 'missing');
    expect([refused.probe.status, refused.probe.json]).toEqual([422, [requiredAttributeNotFoundText('End Entity Profile')]]);
    expect(refused.own).toBeUndefined();
    expect(wire()).toEqual([`POST /api/v1/authorities/${A_EJBCA}/raProfiles`]);
    expect(lastBody('POST', `/api/v1/authorities/${A_EJBCA}/raProfiles`)).toMatchObject({ name, customAttributes: [] });
    expect(readLedger().filter((l) => l.event === 'created')).toEqual([]);
    expect(await rowsNamed(api, '/api/v1/raProfiles', name)).toEqual([]);

    core.acceptRa = true;
    const leaked = await createRaProfileProbe(api, A_EJBCA, await raProfileBody(api, name, missingAttributeCase(base, def)), 'T', 'leak');
    expect(leaked.probe.status).toBe(200);
    expect(readLedger().find((l) => l.uuid === leaked.own!.uuid)).toMatchObject({ type: 'raProfiles', name, parents: { authority: A_EJBCA } });
    const rows = await adoptByName(api, '/api/v1/raProfiles', 'raProfiles', name, 'T', 'adopt', { authority: A_EJBCA });
    expect(rows.map((r) => r.uuid), 'found by name; already in the ledger').toEqual([leaked.own!.uuid]);
    expect(readLedger().filter((l) => l.uuid === leaked.own!.uuid)).toHaveLength(1);
});

test('the required custom attributes of credentials and groups are read from the tier and filled with the same rules as regressionApi', async () => {
    core.required.groups = [
        { uuid: U(60), name: 's', contentType: 'string', properties: { required: true } },
        { uuid: U(61), name: 'n', contentType: 'integer', properties: { required: true } },
        { uuid: U(62), name: 'b', contentType: 'boolean', properties: { required: true } },
        { uuid: U(63), name: 'l', contentType: 'string', properties: { required: true, list: true }, content: [{ data: 'first' }, { data: 'second' }] },
        { uuid: U(64), name: 'o', contentType: 'string', properties: { required: false } },
    ];
    const filled = await requiredCustomAttributes(api, 'groups', 'value');
    expect(filled.map((a) => [a.name, a.content[0].data])).toEqual([['s', 'value'], ['n', 1], ['b', true], ['l', 'first']]);
    expect(await requiredCustomAttributes(api, 'credentials', 'value')).toEqual([]);
    core.required.groups = [{ uuid: U(65), name: 'x', contentType: 'file', properties: { required: true } }];
    await expect(requiredCustomAttributes(api, 'groups', 'v')).rejects.toThrow(/which the suite cannot fill/);
});

// ------------------------------------------------------------------ a raw context

test('a raw context handed to a mutating helper is refused (not-guarded); nothing is sent', async () => {
    const c = await connector();
    const rawApi = raw as unknown as GuardedApi;
    const some = U(70);
    // Thunks, awaited one by one: a promise created up front and rejected before it is awaited would be an unhandled rejection.
    const calls: Array<() => Promise<unknown>> = [
        () => createCredentialProbe(rawApi, { name: runName('x') }, 'T'), () => createGroupProbe(rawApi, { name: runName('x') }, 'T'),
        () => createRaProfileProbe(rawApi, A_EJBCA, { name: runName('x') }, 'T'), () => ownCredential(rawApi, c, 'T'), () => ownGroup(rawApi, 'T'),
        () => uploadOwnSelfSigned(rawApi, 'T'), () => ownGroupAttribute(rawApi, 'T'), () => putCredential(rawApi, some, [], []),
        () => setCredentialEnabled(rawApi, some, true), () => putGroup(rawApi, some, {}), () => patchCertificate(rawApi, some, {}), () => setCertificateGroups(rawApi, some, []),
        () => archiveOwnCertificate(rawApi, some), () => deleteOwnConfigObject(rawApi, 'groups', some), () => bulkDeleteObjects(rawApi, 'credentials', [some]),
        () => validateRaAttributes(rawApi, A_EJBCA, []),
    ];
    for (const call of calls) expect(await outcome(call()), call.toString().slice(6, 60)).toBe('not-guarded');
    expect(wire()).toEqual([]);
});

test('ledger before assertion: a foreign object that is not recorded stays untouchable (the helpers never record what they did not create)', async () => {
    const c = await connector();
    await ownCredential(api, c, 'T');
    const unrecorded = recordCreated('credentials', { uuid: U(77), name: 'Production credential' }, 'T');
    server.reset();
    expect(await outcome(deleteOwnConfigObject(api, 'credentials', unrecorded.uuid)), 'a ledger line without the run prefix proves nothing').toBe('ownership');
    expect(wire()).toEqual([]);
});
