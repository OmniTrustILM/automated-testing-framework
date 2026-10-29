/**
 * protocolsWire — the protocol helpers through the real guard against a stateful loopback fake core: the dedicated RA
 * profile, SCEP / CMP profile create, enable and activation, their teardown handlers, the protocol CA fixture (with the
 * fallback to a v1 provider and its named blocker) and the removal of the protocol CA key by the registry's handler.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { GuardedApi } from '../../utils/regression/guard/types';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { ensureProtocolCaCertificate, ProtocolCaBlocked } from '../../utils/regression/protocols/protocolCa';
import { protocolPost } from '../../utils/regression/protocols/protocolHttp';
import { activateCmpOnOwnRaProfile, createOwnCmpProfile, createOwnScepProfile, enableOwnCmpProfile, enableOwnScepProfile, ensureCmpActiveOnOwnRaProfile, ensureScepActiveOnOwnRaProfile, randomSecret } from '../../utils/regression/protocols/protocolProfiles';
import { ensureProtocolRaProfile } from '../../utils/regression/ownRaProfiles';
import { LedgerLine, OwnRef, readLedger, recordCreated } from '../../utils/regression/ledger/ledger';
import { readRunState, runId, updateRunState } from '../../utils/regression/ledger/runState';
import { handlerOf, contextOf, removeOwnObject } from '../../utils/regression/teardown/runTeardown';
import { Answer, Arrived, LoopbackServer } from './helpers/loopbackServer';
import { FakeCore as BaseCore } from './helpers/fakeCore';
import { registerFakeCore } from './helpers/guardRig';
import type { JsonObject } from '../../utils/regression/json';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUTHORITY = U(1);
const RUN_RA = U(2);
const PROVIDER_V2 = U(3);
const PROVIDER_V1 = U(4);
const FCA_CERT = U(5);
const FOREIGN_CERT = U(6);
const FINGERPRINT = 'ab'.repeat(32);

/** A fake core that remembers what the run created (GETs answer it) and serves the fixed tier around it. */
class ProtocolsCore extends BaseCore {
    protected seq = 100;
    /** Protocol activations per RA profile uuid. */
    readonly scepOn = new Map<string, JsonObject>();
    readonly cmpOn = new Map<string, JsonObject>();
    /** Certificate uuids whose detail answers 500 (the v2-token detail bug). */
    readonly detail500 = new Set<string>();
    /** Which providers are registered. */
    providers: Array<{ uuid: string; name: string; version: string }> = [{ uuid: PROVIDER_V2, name: 'Soft-v2', version: 'v2' }, { uuid: PROVIDER_V1, name: 'Soft-v1', version: 'v1' }];
    /** Key items: usages the fake gives new keys (a weak set exercises the usages PUT). */
    keyUsages: { priv: string[]; pub: string[] } = { priv: ['sign', 'decrypt'], pub: ['verify', 'encrypt'] };
    /** The provider a certificate's key lives on, by certificate uuid. */
    readonly certProvider = new Map<string, string>();
    /** The next protocol POST answers 302 to /elsewhere (the no-redirect check of protocolPost). */
    redirectOnce = false;

    protected respond(a: Arrived): Answer | undefined {
        const [path, query = ''] = a.url.split('?');
        if (path.startsWith('/api/v1/protocols/')) {
            if (this.redirectOnce) {
                this.redirectOnce = false;
                return { status: 302, headers: { location: `${path}/elsewhere` } };
            }
            return { status: 200, body: {} };
        }
        const body = a.body ? (JSON.parse(a.body) as JsonObject) : undefined;
        const m = (re: RegExp) => re.exec(path);
        let x: RegExpExecArray | null;
        if (a.method === 'GET') {
            if (path === '/api/v1/connectors') {
                // core binds `kind` through OptionalEnumConverter: every kind value answers 422
                if (/(^|&)kind=/.test(query)) return { status: 422, body: [`Unknown enum value ${new URLSearchParams(query).get('kind')}`] };
                return {
                    status: 200,
                    body: [
                        { uuid: U(90), name: 'Credentials', status: 'connected', functionGroups: [{ functionGroupCode: 'credentialProvider', kinds: ['Basic', 'SoftKeyStore'] }] },
                        ...this.providers.map((p) => ({ uuid: p.uuid, name: p.name, status: 'connected', functionGroups: [{ functionGroupCode: 'cryptographyProvider', kinds: ['SOFT'] }] })),
                    ],
                };
            }
            if ((x = m(/^\/api\/v2\/connectors\/([^/]+)$/))) return { status: 200, body: { uuid: x[1], version: this.providers.find((p) => p.uuid === x![1])?.version } };
            if (m(/^\/api\/v1\/attributes\/custom\/resources\//)) return { status: 200, body: [] };
            if (path === '/api/v1/certificates/csr/attributes') return { status: 200, body: [{ version: 3, uuid: U(59), name: 'commonName', contentType: 'string' }] };
            if (m(/^\/api\/v1\/tokens\/[^/]+\/attributes$/)) return { status: 200, body: [{ name: 'data_options', uuid: U(50) }, { name: 'data_createTokenAction', uuid: U(51) }, { name: 'data_newTokenName', uuid: U(52) }, { name: 'data_tokenCode', uuid: U(53) }] };
            if (m(/^\/api\/v1\/tokens\/[^/]+\/tokenProfiles\/[^/]+\/keys\/keyPair\/attributes$/)) return { status: 200, body: [{ name: 'data_keyAlias', uuid: U(54) }, { name: 'data_keyAlgorithm', uuid: U(55) }] };
            if (m(/\/sign\/attributes$/)) return { status: 200, body: [{ name: 'data_rsaSigScheme', uuid: U(56), contentType: 'string', content: [{ reference: 'PSS', data: 'PSS' }, { reference: 'PKCS1v15', data: 'PKCS1v15' }] }, { name: 'data_sigDigest', uuid: U(57), contentType: 'string', content: [{ reference: 'SHA-256', data: 'SHA-256' }] }] };
            if (path === `/api/v1/raProfiles/${RUN_RA}`) return { status: 200, body: { uuid: RUN_RA, name: `${runId()}-ra`, authorityInstanceUuid: AUTHORITY, enabled: true } };
            if (path === `/api/v1/authorities/${AUTHORITY}/raProfiles/${RUN_RA}`) return { status: 200, body: { uuid: RUN_RA, name: `${runId()}-ra`, attributes: [{ name: 'a', uuid: U(60), type: 'data', contentType: 'string', content: [{ data: 'x' }] }] } };
            if ((x = m(/^\/api\/v1\/authorities\/[^/]+\/raProfiles\/([^/]+)\/protocols\/(scep|cmp)$/))) {
                const on = (x[2] === 'scep' ? this.scepOn : this.cmpOn).get(x[1]);
                return { status: 200, body: on ?? (x[2] === 'scep' ? { scepAvailable: false } : { cmpAvailable: false }) };
            }
            if ((x = m(/^\/api\/v1\/certificates\/([^/]+)\/validate$/))) return { status: 200, body: {} };
            if ((x = m(/^\/api\/v1\/certificates\/([^/]+)$/))) {
                if (x[1] === FCA_CERT) return { status: 200, body: { uuid: FCA_CERT, commonName: `${runId()}-fca`, state: 'issued', validationStatus: 'valid', fingerprint: FINGERPRINT } };
                if (x[1] === FOREIGN_CERT) return { status: 200, body: { uuid: FOREIGN_CERT, commonName: 'someone-elses-cert', state: 'issued' } };
                if (this.detail500.has(x[1])) return { status: 500, body: { message: 'Internal server error.' } };
            }
            if ((x = m(/^\/api\/v1\/(raProfiles|scepProfiles|cmpProfiles|tokens|keys|certificates)\/([^/]+)$/)) || (x = m(/^\/api\/v1\/tokens\/[^/]+\/(tokenProfiles)\/([^/]+)$/))) {
                const o = this.store.get(x[2]);
                return o ? { status: 200, body: o } : { status: 404, body: { message: 'not found' } };
            }
            return { status: 404, body: { message: `fake core: no GET ${path}` } };
        }
        if (a.method === 'POST') {
            const uuid = this.next();
            if (m(/^\/api\/v1\/authorities\/[^/]+\/raProfiles$/)) return this.create(uuid, 'raProfiles', { uuid, name: body!.name, authorityInstanceUuid: AUTHORITY, enabled: false });
            if (path === '/api/v1/scepProfiles') return this.create(uuid, 'scepProfiles', { uuid, name: body!.name, enabled: false });
            if (path === '/api/v1/cmpProfiles') return this.create(uuid, 'cmpProfiles', { uuid, name: body!.name, enabled: false });
            if (path === '/api/v1/tokens') return this.create(uuid, 'tokens', { uuid, name: body!.name, connectorUuid: body!.connectorUuid });
            if ((x = m(/^\/api\/v1\/tokens\/([^/]+)\/tokenProfiles$/))) return this.create(uuid, 'tokenProfiles', { uuid, name: body!.name, tokenInstanceUuid: x[1], usage: body!.usage });
            if ((x = m(/^\/api\/v1\/tokens\/([^/]+)\/tokenProfiles\/([^/]+)\/keys\/keyPair$/))) {
                return this.create(uuid, 'keys', {
                    uuid, name: body!.name, tokenInstanceUuid: x[1], tokenProfileUuid: x[2],
                    items: [
                        { uuid: this.next(), type: 'Private', keyAlgorithm: 'RSA', state: 'active', usage: this.keyUsages.priv },
                        { uuid: this.next(), type: 'Public', keyAlgorithm: 'RSA', state: 'active', usage: this.keyUsages.pub },
                    ],
                });
            }
            if ((x = m(/^\/api\/v2\/operations\/authorities\/[^/]+\/raProfiles\/[^/]+\/certificates$/))) {
                // core (AttributeEngine validateVersionsMatch): an attribute is sent in its definition's version; the CN is v3
                const cnAttr = (body!.csrAttributes as JsonObject[]).find((c) => c.name === 'commonName');
                if (cnAttr?.version !== 'v3') return { status: 400, body: { message: 'Failed to submit certificate request: Attribute commonName is defined in version v3 and must be sent with "version": "v3"' } };
                if ((cnAttr.content as JsonObject[]).some((c) => !c.contentType)) return { status: 400, body: { message: 'Unable to read HTTP message' } };
                const key = this.store.get(String(body!.keyUuid));
                const token = key && this.store.get(String(key.tokenInstanceUuid));
                if (token) this.certProvider.set(uuid, String(token.connectorUuid));
                if (token && this.providers.find((p) => p.uuid === token.connectorUuid)?.version === 'v2' && this.detail500.has('v2')) this.detail500.add(uuid);
                const cn = ((body!.csrAttributes as JsonObject[]).find((c) => c.name === 'commonName')?.content as JsonObject[] | undefined)?.[0].data;
                return this.create(uuid, 'certificates', { uuid, commonName: cn, state: 'issued', validationStatus: 'valid', fingerprint: `cc${uuid.replace(/-/g, '').slice(0, 62)}` });
            }
            return { status: 404, body: { message: `fake core: no POST ${path}` } };
        }
        if (a.method === 'PATCH') {
            if ((x = m(/^\/api\/v1\/authorities\/[^/]+\/raProfiles\/([^/]+)\/protocols\/(scep|cmp)\/activate\/([^/]+)$/))) {
                const p = this.store.get(x[3]);
                const on = x[2] === 'scep'
                    ? { uuid: x[3], name: p?.name, scepAvailable: true, url: `http://ilm.test/api/v1/protocols/scep/raProfile/${this.store.get(x[1])?.name}/pkiclient.exe` }
                    : { uuid: x[3], name: p?.name, cmpAvailable: true, cmpUrl: `http://ilm.test/api/v1/protocols/cmp/raProfile/${this.store.get(x[1])?.name}` };
                (x[2] === 'scep' ? this.scepOn : this.cmpOn).set(x[1], on);
                return { status: 200, body: on };
            }
            if ((x = m(/^\/api\/v1\/authorities\/[^/]+\/raProfiles\/([^/]+)\/protocols\/(scep|cmp)\/deactivate$/))) {
                (x[2] === 'scep' ? this.scepOn : this.cmpOn).delete(x[1]);
                return { status: 204 };
            }
            if ((x = m(/^\/api\/v1\/(scepProfiles|cmpProfiles)\/([^/]+)\/(enable|disable)$/))) {
                const o = this.store.get(x[2]);
                if (o) o.enabled = x[3] === 'enable';
                return { status: 204 };
            }
            if (m(/^\/api\/v1\/authorities\/[^/]+\/raProfiles\/[^/]+\/enable$/)) return { status: 204 };
            if (path === '/api/v1/keys/disable' || path === '/api/v1/keys/destroy') return { status: 204 };
            return { status: 404, body: { message: `fake core: no PATCH ${path}` } };
        }
        if (a.method === 'PUT') {
            if ((x = m(/^\/api\/v1\/keys\/([^/]+)\/usages$/))) {
                const key = this.store.get(x[1]);
                if (key) for (const i of key.items as JsonObject[]) i.usage = body!.usage;
                return { status: 204 };
            }
            return { status: 404, body: { message: `fake core: no PUT ${path}` } };
        }
        if (a.method === 'DELETE') {
            if ((x = m(/^\/api\/v1\/(scepProfiles|cmpProfiles)\/([^/]+)$/))) {
                this.store.delete(x[2]);
                return { status: 204 };
            }
            if (path === '/api/v1/keys') {
                // the bulk key delete sends a bare JSON array of uuids; the stand-in's request body type is an object
                for (const u of body as unknown as string[]) this.store.delete(u);
                return { status: 204 };
            }
            return { status: 404, body: { message: `fake core: no DELETE ${path}` } };
        }
        return undefined;
    }

    private create(uuid: string, _type: string, o: JsonObject): Answer {
        this.store.set(uuid, o);
        return { status: 201, body: o };
    }
}

let server: LoopbackServer;
let core: ProtocolsCore;
let raw: APIRequestContext;
let api: GuardedApi;

registerFakeCore(() => core, (rig) => ({ server, raw, api } = rig), { env: { API_DELETE_OWN: '1' }, clear: ['REG_RA_PROFILE_NAME', 'REG_SOFT_PROVIDER'] });
test.beforeEach(() => {
    core = new ProtocolsCore();
    // The run RA profile (own, recorded) and the protocol CA certificate (own, recorded) the helpers build on.
    const ra = recordCreated('raProfiles', { uuid: RUN_RA, name: `${runId()}-ra` }, { spec: 'T', note: 'run RA profile', parents: { authority: AUTHORITY } });
    updateRunState({ raProfile: { ...ra, authorityUuid: AUTHORITY } });
});

const wire = () => server.mutations().map((a) => `${a.method} ${a.url}`);
const bodyOf = (method: string, re: RegExp): JsonObject => JSON.parse(server.arrived.find((a) => a.method === method && re.test(a.url))!.body);
const ledger = (type: string, event: LedgerLine['event'] = 'created') => readLedger().filter((l) => l.type === type && l.event === event);
const fcaCert = (): OwnRef => recordCreated('certificates', { uuid: FCA_CERT, name: `${runId()}-fca` }, { spec: 'T', note: 'protocol CA certificate' });

async function refusal(call: Promise<unknown>): Promise<string> {
    try {
        await call;
        return 'sent';
    } catch (e) {
        return e instanceof OwnObjectViolation ? e.kind : `error: ${String(e).slice(0, 200)}`;
    }
}

// ------------------------------------------------------------------ the dedicated RA profile

test('ensureProtocolRaProfile: the run RA profile is only read, the dedicated RA profile is created under the authority and enabled; a second call finds it in the ledger and sends nothing', async () => {
    const ra = await ensureProtocolRaProfile(api, 'T', 'scep');
    expect(ra.name).toBe(`${runId()}-ra-scep`);
    expect(ra.authorityUuid).toBe(AUTHORITY);
    expect(wire()).toEqual([`POST /api/v1/authorities/${AUTHORITY}/raProfiles`, `PATCH /api/v1/authorities/${AUTHORITY}/raProfiles/${ra.uuid}/enable`]);
    expect(bodyOf('POST', /raProfiles$/).attributes).toEqual([expect.objectContaining({ name: 'a' })]);
    expect(ledger('raProfiles').map((l) => l.name)).toContain(`${runId()}-ra-scep`);
    server.reset();
    const again = await ensureProtocolRaProfile(api, 'T', 'scep');
    expect(again.uuid).toBe(ra.uuid);
    expect(wire()).toEqual([]);
    await expect(ensureProtocolRaProfile(api, 'T', 'Bad Label')).rejects.toThrow(/\[a-z0-9-\]/);
});

// ------------------------------------------------------------------ SCEP profile

test('SCEP profile: create names the own CA certificate and the password; enable; activate on the own RA profile with the DTO body; ensureScepActive is idempotent', async () => {
    const cert = fcaCert();
    const ra = await ensureProtocolRaProfile(api, 'T', 'scep');
    server.reset();
    const password = randomSecret();
    const scep = await createOwnScepProfile(api, 'T', 'scep', { name: `${runId()}-scep`, caCertificateUuid: cert.uuid, challengePassword: password, includeCaCertificateChain: true });
    expect(wire()).toEqual(['POST /api/v1/scepProfiles']);
    const body = bodyOf('POST', /scepProfiles$/);
    expect(body).toMatchObject({ name: `${runId()}-scep`, caCertificateUuid: cert.uuid, challengePassword: password, enableChallengePassword: true, includeCaCertificate: false, includeCaCertificateChain: true, issueCertificateAttributes: [] });
    expect(body.raProfileUuid).toBeUndefined();
    expect(ledger('scepProfiles')[0]).toMatchObject({ uuid: scep.uuid, parents: { caCertificate: cert.uuid } });

    await enableOwnScepProfile(api, scep);
    const url = await ensureScepActiveOnOwnRaProfile(api, ra, scep);
    expect(url).toContain(`/protocols/scep/raProfile/${ra.name}/pkiclient.exe`);
    expect(wire()).toEqual([
        'POST /api/v1/scepProfiles',
        `PATCH /api/v1/scepProfiles/${scep.uuid}/enable`,
        `PATCH /api/v1/authorities/${AUTHORITY}/raProfiles/${ra.uuid}/protocols/scep/activate/${scep.uuid}`,
    ]);
    expect(bodyOf('PATCH', /scep\/activate/)).toEqual({ issueCertificateAttributes: [] });
    server.reset();
    expect(await ensureScepActiveOnOwnRaProfile(api, ra, scep)).toBe(url);
    expect(wire()).toEqual([]);
});

test('SCEP profile: a CA certificate the run did not create is refused before anything leaves; a raw context is refused too', async () => {
    recordCreated('certificates', { uuid: U(7), name: `${runId()}-other` }, { spec: 'T' });
    expect(await refusal(createOwnScepProfile(api, 'T', 'scep-x', { caCertificateUuid: FOREIGN_CERT }))).toBe('ownership');
    expect(await refusal(createOwnScepProfile(raw as GuardedApi, 'T', 'scep-y', { caCertificateUuid: FCA_CERT }))).toBe('not-guarded');
    expect(wire()).toEqual([]);
});

// ------------------------------------------------------------------ CMP profile

test('CMP profile: create carries variant, both protection methods, the secret and the own RA profile; enable; activate sends both attribute lists; no secret → nothing sent', async () => {
    const ra = await ensureProtocolRaProfile(api, 'T', 'cmp');
    server.reset();
    const secret = randomSecret();
    const cmp = await createOwnCmpProfile(api, 'T', 'cmp', { name: `${runId()}-cmp`, sharedSecret: secret, raProfileUuid: ra.uuid });
    expect(bodyOf('POST', /cmpProfiles$/)).toMatchObject({ name: `${runId()}-cmp`, variant: 'v2', requestProtectionMethod: 'sharedSecret', responseProtectionMethod: 'sharedSecret', sharedSecret: secret, raProfileUuid: ra.uuid, issueCertificateAttributes: [], revokeCertificateAttributes: [] });
    expect(ledger('cmpProfiles')[0]).toMatchObject({ uuid: cmp.uuid, parents: { raProfile: ra.uuid } });
    await enableOwnCmpProfile(api, cmp);
    const activation = await activateCmpOnOwnRaProfile(api, ra, cmp);
    expect(activation.cmpAvailable).toBe(true);
    expect(bodyOf('PATCH', /cmp\/activate/)).toEqual({ issueCertificateAttributes: [], revokeCertificateAttributes: [] });
    server.reset();
    expect(await ensureCmpActiveOnOwnRaProfile(api, ra, cmp)).toContain(`/protocols/cmp/raProfile/${ra.name}`);
    expect(wire()).toEqual([]);
    await expect(createOwnCmpProfile(api, 'T', 'cmp-2')).rejects.toThrow(/needs a secret/);
    expect(wire()).toEqual([]);
});

// ------------------------------------------------------------------ teardown handlers (registry → protocolProfiles)

for (const kind of ['scep', 'cmp'] as const) {
    test(`teardown ${kind}Profiles: live read, deactivate on the own RA profile it is active on, DELETE, absence proven, deleted ledger line`, async () => {
        const cert = fcaCert();
        const ra = await ensureProtocolRaProfile(api, 'T', kind);
        const profile = kind === 'scep'
            ? await createOwnScepProfile(api, 'T', 'scep', { name: `${runId()}-${kind}`, caCertificateUuid: cert.uuid })
            : await createOwnCmpProfile(api, 'T', 'cmp', { name: `${runId()}-${kind}`, sharedSecret: 'x' });
        if (kind === 'scep') await ensureScepActiveOnOwnRaProfile(api, ra, profile);
        else await ensureCmpActiveOnOwnRaProfile(api, ra, profile);
        server.reset();
        const line = ledger(`${kind}Profiles`).find((l) => l.uuid === profile.uuid)!;
        const result = await removeOwnObject(contextOf(raw, runId(), readLedger(), null, () => undefined), line, 'T');
        expect(result).not.toBe('kept');
        expect(wire()).toEqual([
            `PATCH /api/v1/authorities/${AUTHORITY}/raProfiles/${ra.uuid}/protocols/${kind}/deactivate`,
            `DELETE /api/v1/${kind}Profiles/${profile.uuid}`,
        ]);
        expect(server.arrived.map((a) => `${a.method} ${a.url}`)).toContain(`GET /api/v1/raProfiles/${ra.uuid}`);
        expect(server.arrived.filter((a) => a.method === 'GET' && a.url === `/api/v1/${kind}Profiles/${profile.uuid}`).length).toBeGreaterThanOrEqual(2);
        expect(ledger(`${kind}Profiles`, 'deleted').map((l) => l.uuid)).toContain(profile.uuid);
        expect(core.store.has(profile.uuid)).toBe(false);
    });
}

// ------------------------------------------------------------------ protocol CA

test('protocol CA: token, token profile, key pair and the v2 issue for the key are the only mutations, each recorded; the run state keeps them; a second call sends nothing', async () => {
    const ca = await ensureProtocolCaCertificate(api, 'T');
    expect(wire()).toEqual([
        'POST /api/v1/tokens',
        `POST /api/v1/tokens/${ca.token.uuid}/tokenProfiles`,
        `POST /api/v1/tokens/${ca.token.uuid}/tokenProfiles/${ca.tokenProfile.uuid}/keys/keyPair`,
        `POST /api/v2/operations/authorities/${AUTHORITY}/raProfiles/${RUN_RA}/certificates`,
    ]);
    const token = bodyOf('POST', /\/api\/v1\/tokens$/);
    expect(token.name).toMatch(new RegExp(`^${runId()}-fca-token-`));
    expect(token.connectorUuid).toBe(PROVIDER_V2);
    // the provider is chosen from the plain list (core answers 422 to any `kind` query); its declared kind is sent back
    expect(server.arrived.filter((a) => a.method === 'GET' && a.url.startsWith('/api/v1/connectors')).map((a) => a.url)).toEqual(['/api/v1/connectors']);
    expect(server.arrived.some((a) => a.method === 'GET' && a.url === `/api/v1/tokens/${PROVIDER_V2}/attributes?kind=SOFT`)).toBe(true);
    expect(token.kind).toBe('SOFT');
    expect((token.attributes as JsonObject[]).map((a) => a.name)).toEqual(['data_options', 'data_createTokenAction', 'data_newTokenName', 'data_tokenCode']);
    expect(((token.attributes as JsonObject[])[2].content as JsonObject[])[0].data).toMatch(/^[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)*$/);
    expect(bodyOf('POST', /tokenProfiles$/).usage).toEqual(['sign', 'verify', 'encrypt', 'decrypt']);
    const key = bodyOf('POST', /keys\/keyPair$/);
    expect(key.enabled).toBe(true);
    expect(key.attributes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'data_keyAlgorithm', uuid: U(55), content: [{ data: 'RSA', reference: 'RSA' }] }),
        expect.objectContaining({ name: 'data_rsaKeySize', contentType: 'integer', content: [{ reference: 'RSA_2048', data: 2048 }] }),
    ]));
    const issue = bodyOf('POST', /certificates$/);
    expect(issue).toMatchObject({ format: 'pkcs10', tokenProfileUuid: ca.tokenProfile.uuid, keyUuid: ca.key.uuid, attributes: [] });
    expect((issue.csrAttributes as JsonObject[])[0]).toEqual({ version: 'v3', uuid: U(59), name: 'commonName', contentType: 'string', content: [{ data: ca.certificate.commonName, contentType: 'string' }] });
    expect((issue.signatureAttributes as JsonObject[]).map((a) => (a.content as JsonObject[])[0].data)).toEqual(['PKCS1v15', 'SHA-256']);
    expect(ca.certificate.commonName).toMatch(new RegExp(`^${runId()}-fca-`));
    expect(ca.certificate.fingerprint).toMatch(/^cc/);
    expect(ca.providerVersion).toBe(2);
    for (const type of ['tokens', 'tokenProfiles', 'keys', 'certificates']) expect(ledger(type).length, type).toBeGreaterThanOrEqual(1);
    expect(ledger('certificates').find((l) => l.uuid === ca.certificate.uuid)?.parents).toEqual({ raProfile: RUN_RA, authority: AUTHORITY, key: ca.key.uuid });
    expect(readRunState()).toMatchObject({ protocolCaToken: { uuid: ca.token.uuid }, protocolCaTokenProfile: { uuid: ca.tokenProfile.uuid }, protocolCaKey: { uuid: ca.key.uuid }, caCertificate: { uuid: ca.certificate.uuid } });
    expect(readRunState(), 'the key specs\' own chain is left alone').not.toHaveProperty('token');
    server.reset();
    const again = await ensureProtocolCaCertificate(api, 'T');
    expect(again.certificate.uuid).toBe(ca.certificate.uuid);
    expect(wire()).toEqual([]);
});

test('protocol CA: key items without the profile usages get them set on the own key (PUT usages), then the issue goes on', async () => {
    core.keyUsages = { priv: ['sign'], pub: ['verify'] };
    const ca = await ensureProtocolCaCertificate(api, 'T');
    expect(wire()).toContain(`PUT /api/v1/keys/${ca.key.uuid}/usages`);
    expect(bodyOf('PUT', /usages$/)).toEqual({ usage: ['sign', 'verify', 'encrypt', 'decrypt'] });
});

test('protocol CA: a 500 certificate detail on the v2 provider rebuilds on the v1 provider; without one the blocker is named', async () => {
    core.detail500.add('v2');
    const ca = await ensureProtocolCaCertificate(api, 'T');
    expect(ca.providerVersion).toBe(1);
    const tokens = server.arrived.filter((a) => a.method === 'POST' && a.url === '/api/v1/tokens').map((a) => JSON.parse(a.body).connectorUuid);
    expect(tokens).toEqual([PROVIDER_V2, PROVIDER_V1]);
    expect(ledger('certificates').length, 'both certificates are recorded (the first stays for the teardown)').toBe(2);

    const only = new ProtocolsCore();
    only.providers = [{ uuid: PROVIDER_V2, name: 'Soft-v2', version: 'v2' }];
    only.detail500.add('v2');
    core = only;
    process.env.REG_STATE_DIR = `${process.env.REG_STATE_DIR}-b`;
    recordCreated('raProfiles', { uuid: RUN_RA, name: `${runId()}-ra` }, { spec: 'T', note: 'run RA profile', parents: { authority: AUTHORITY } });
    updateRunState({ raProfile: { uuid: RUN_RA, name: `${runId()}-ra`, kind: 'own', authorityUuid: AUTHORITY } });
    await expect(ensureProtocolCaCertificate(api, 'T')).rejects.toThrow(ProtocolCaBlocked);
    await expect(ensureProtocolCaCertificate(api, 'T')).rejects.toThrow(/\[blocked: core#2508\]/);
});

test('protocol CA: no software provider → a named blocker, nothing sent', async () => {
    core.providers = [];
    await expect(ensureProtocolCaCertificate(api, 'T')).rejects.toThrow(/no connected Software Cryptography Provider/);
    expect(wire()).toEqual([]);
});

test('protocolPost sends the body under the given Content-Type and never follows a redirect', async () => {
    const url = `${server.origin}/api/v1/protocols/cmp/raProfile/${runId()}-ra`;
    core.redirectOnce = true;
    const res = await protocolPost(url, { contentType: 'application/pkixcmp', body: Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]) });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/elsewhere');
    expect(server.arrived.map((a) => `${a.method} ${a.url}`)).toEqual([`POST /api/v1/protocols/cmp/raProfile/${runId()}-ra`]);
    expect(server.arrived[0].headers['content-type']).toBe('application/pkixcmp');
    expect(server.arrived[0].headers.authorization).toBeUndefined();
    expect(Buffer.from(server.arrived[0].body, 'utf8').subarray(0, 2)).toEqual(Buffer.from([0x30, 0x03]));
    server.reset();
    const text = await protocolPost(url, { contentType: 'application/x-www-form-urlencoded', body: 'operation=PKIOperation' });
    expect(text.status).toBe(200);
    expect(server.arrived[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(server.arrived[0].body).toBe('operation=PKIOperation');
});

test('the protocol CA key is removed by the registry\'s one keys handler: one bulk delete, absence proven', async () => {
    const ca = await ensureProtocolCaCertificate(api, 'T');
    server.reset();
    const handler = handlerOf('keys')!;
    const line = ledger('keys').find((l) => l.uuid === ca.key.uuid)!;
    await handler.remove(contextOf(raw, runId(), readLedger(), null, () => undefined), line);
    expect(wire()).toEqual(['DELETE /api/v1/keys']);
    expect(bodyOf('DELETE', /keys$/)).toEqual([ca.key.uuid]);
    expect(core.store.has(ca.key.uuid)).toBe(false);
});
