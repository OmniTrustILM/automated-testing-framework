/**
 * regressionApi — API helpers for the REG-* suite: reads, plus create / change / delete of the run's OWN objects.
 *
 * Rules this module keeps (decisions Q1 and D1; every REG spec relies on them):
 * - objects that existed before the run are only read: never changed, disabled, revoked or deleted (the MS ADCS source
 *   authority and its RA profile template are copied, never changed);
 * - the run may change the objects it created (enable, activate, edit, revoke, delete), and only those: every helper
 *   that changes something takes an `OwnRef` (what `recordCreated` returns) and calls `assertOwnLive` first, which needs
 *   the object's ledger "created" line of this run AND a live object whose name carries the run prefix (review R6);
 * - every helper that sends anything but a GET or a search takes a `GuardedApi` (the `api` fixture; review Q2), and
 *   `apiJson` itself refuses a raw context for any method but GET and a read-only / protocol POST (`requireGuarded`;
 *   a create needs the guard since fix pass 3, which checks its body), so a raw context cast past the types still
 *   cannot mutate; specGuards lints this module like the specs;
 * - everything the run created is deleted at the end of the run by `runTeardown` (API_DELETE_OWN=0 keeps it);
 * - REG_RA_PROFILE_NAME (an existing RA profile of a local stack) is honoured only with TIER_KIND=local and only as an
 *   issue-only parent (`IssueOnlyRef`): certificates may be issued through it, but nothing on it is activated or changed.
 *
 * The MS ADCS source is the first connected authority on the MS-ADCS-NG connector (override with
 * REG_ADCS_SOURCE_AUTHORITY / REG_ADCS_CONNECTOR). Its CA host and name are read at runtime and never stored here.
 *
 * B1 — the run RA profile is CA-agnostic (`ensureRaProfile`): MS ADCS when its connector answers its LIVE health, else
 * EJBCA-NG, else PyADCS (REG_CA_CONNECTORS). The run never needs its own authority for it: it creates its OWN RA
 * profile under the chosen pre-existing authority, with the connector attributes copied read-only from an enabled RA
 * profile there (`createRaProfileLike`); no source → the caller skips with the named reason (deploy gate). The ADCS
 * checklist chain (REG-CFG-02 / -03, `ensureAuthority`) stays MS ADCS and skips on `adcsBlocker` (live health).
 */
import { requestVersion } from './attributeVersion';
import { APIRequestContext, APIResponse, expect } from '@playwright/test';
import { Logger } from '../Logger';
import { allowListedPost, apiPathOf, assertSameOrigin, GuardedApi, isGuardedApi, isRawPostAllowed, requireGuarded } from './guardedApi';
import { describeHealth, healthByVersion, listConnectors } from './connectorApi';
import { assertOwnLive, ownership } from './ownObjects';
import {
    createdAfterFrom, IssueOnlyRef, isIssueOnly, issueOnly, OwnRef, readLedger, readState, recordCreated, recordDerived, Ref, regName, RUN_ID, serverDateOf,
    updateState,
} from './regressionRun';
import { hasRunFamilyPrefix } from './runId';
import { isLocalTier } from './tier';

const logger = new Logger('RegressionApi');

type Json = Record<string, any>;

type JsonMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function apiJson<T = any>(api: APIRequestContext, method: JsonMethod, url: string, data?: unknown): Promise<T> {
    return (await requestJson<T>(api, method, url, data)).body;
}

/**
 * apiJson plus the server's clock: the response's Date header and the request's duration, so a create can give its
 * derived objects (`certKey_<CN>`, onboarded certificates) a `createdAfter` from the server, never the runner (R17).
 */
export async function apiJsonWithDate<T = any>(api: APIRequestContext, method: JsonMethod, url: string, data?: unknown): Promise<TimedAnswer<T>> {
    return requestJson<T>(api, method, url, data);
}

export interface TimedAnswer<T> {
    body: T;
    /** The server's Date header (absent when the proxy strips it). */
    serverAt?: Date;
    /** The runner's clock just before the request was sent (the fallback bound, Sonnet F9). */
    startedAt: Date;
    elapsedMs: number;
}

/**
 * The `createdAfter` of what a request made: the server clock (R17) when the answer carried a Date, else the runner's
 * clock just before the request (logged; never undefined, Sonnet F9: a derived object must always get a bound).
 */
export function createdAfterOf(answer: Pick<TimedAnswer<unknown>, 'serverAt' | 'startedAt' | 'elapsedMs'>, what = 'request'): string {
    if (answer.serverAt) return createdAfterFrom(answer.serverAt, answer.elapsedMs);
    logger.warn(`${what}: no Date header on the answer; createdAfter falls back to the runner clock at the request start`);
    return createdAfterFrom(answer.startedAt, 0);
}

/** The one implementation behind apiJson / apiJsonWithDate (module-private: the runtime half of the deny-by-default lint). */
async function requestJson<T>(api: APIRequestContext, method: JsonMethod, url: string, data?: unknown): Promise<TimedAnswer<T>> {
    const started = Date.now();
    const payload = data === undefined ? {} : { data };
    let res: APIResponse;
    // Deny by default (Q2): a raw context may read and send a read-only / protocol POST; anything else (a create
    // included, fix pass 3: the guard checks a create's body) needs the guard. A raw context carries the run's
    // credentials too: its GET goes to BASE_URL's origin only (fix pass 4; the guarded context checks this itself).
    if (method === 'GET') res = await api.get(isGuardedApi(api) ? url : assertSameOrigin(url, 'apiJson GET'));
    else if (method === 'POST' && isRawPostAllowed(apiPathOf(url) ?? '')) res = await api.post(allowListedPost(url), payload);
    else res = await requireGuarded(api, `apiJson ${method}`).fetch(url, { method, ...payload });
    const text = await res.text();
    if (!res.ok()) throw new Error(`${method} ${url} → ${res.status()} ${text.slice(0, 600)}`);
    return { body: (text ? JSON.parse(text) : undefined) as T, serverAt: serverDateOf(res.headers()), startedAt: new Date(started), elapsedMs: Date.now() - started };
}

// ---------------------------------------------------------------- reads

export interface AdcsSource {
    uuid: string;
    name: string;
    connectorUuid: string;
    connectorName: string;
    interfaceUuid?: string;
    caHost: string;
    caName: string;
    attributes: Json[];
}

/** The existing MS ADCS NG authority whose CA the suite reuses. Read-only. */
export async function findAdcsSource(api: APIRequestContext): Promise<AdcsSource> {
    const wantedName = process.env.REG_ADCS_SOURCE_AUTHORITY;
    const connectorName = process.env.REG_ADCS_CONNECTOR ?? 'MS-ADCS-NG-Connector';
    const all = await apiJson<Json[]>(api, 'GET', '/api/v1/authorities');
    const candidates = all.filter((a) =>
        wantedName ? a.name === wantedName : a.connectorName === connectorName && a.status === 'connected' && !hasRunFamilyPrefix(String(a.name)),
    );
    expect(candidates.length, `no MS ADCS source authority (connector ${connectorName}${wantedName ? `, name ${wantedName}` : ''})`).toBeGreaterThan(0);
    const detail = await apiJson<Json>(api, 'GET', `/api/v1/authorities/${candidates[0].uuid}`);
    const attrs: Json[] = detail.attributes ?? [];
    const valueOf = (name: string) => attrs.find((a) => a.name === name)?.content?.[0];
    const ca = valueOf('data_ca')?.data as Json | undefined;
    const caHost = (ca?.caHost ?? valueOf('data_caHost')?.data) as string | undefined;
    const caName = (ca?.caName ?? valueOf('data_caName')?.data) as string | undefined;
    // Messages name foreign objects by uuid only (R20): reports may be shared.
    expect(caHost && caName, `source authority ${detail.uuid} exposes no CA host / name`).toBeTruthy();
    return {
        uuid: detail.uuid,
        name: detail.name,
        connectorUuid: detail.connectorUuid,
        connectorName: detail.connectorName,
        interfaceUuid: detail.connectorInterface?.uuid,
        caHost: caHost!,
        caName: caName!,
        attributes: attrs,
    };
}

/** Certificate template to use: REG_ADCS_TEMPLATE (template id, e.g. WebServer), else the one of an enabled RA profile on the source. */
export async function findAdcsTemplate(api: APIRequestContext, source: AdcsSource): Promise<{ reference: string; data: string }> {
    const ras = await apiJson<Json[]>(api, 'GET', '/api/v1/raProfiles');
    const onSource = ras.filter((r) => r.authorityInstanceUuid === source.uuid && r.enabled);
    for (const r of onSource) {
        const d = await apiJson<Json>(api, 'GET', `/api/v1/authorities/${source.uuid}/raProfiles/${r.uuid}`);
        const t = (d.attributes ?? []).find((a: Json) => a.name === 'data_certificateTemplate')?.content?.[0];
        if (t && (!process.env.REG_ADCS_TEMPLATE || t.data === process.env.REG_ADCS_TEMPLATE)) return { reference: t.reference, data: t.data };
    }
    if (process.env.REG_ADCS_TEMPLATE) return { reference: process.env.REG_ADCS_TEMPLATE, data: process.env.REG_ADCS_TEMPLATE };
    throw new Error(`no certificate template found on the RA profiles of authority ${source.uuid}; set REG_ADCS_TEMPLATE`);
}

export async function getCertificate(api: APIRequestContext, uuid: string): Promise<Json> {
    return apiJson(api, 'GET', `/api/v1/certificates/${uuid}`);
}

export async function searchCertificates(api: APIRequestContext, filters: Json[], itemsPerPage = 50): Promise<Json[]> {
    const body = await apiJson<Json>(api, 'POST', '/api/v1/certificates', { itemsPerPage, pageNumber: 1, filters });
    return body.certificates ?? [];
}

/** First item of a list endpoint whose `key` equals `value` (lists like /v1/credentials, /v1/groups, /v1/roles, /v1/users). */
export async function findByName(api: APIRequestContext, listUrl: string, value: string, key = 'name'): Promise<Json | undefined> {
    const list = await apiJson<Json[]>(api, 'GET', listUrl);
    return list.find((x) => x[key] === value);
}

// ------------------------------------------------- create and change (the run's own objects)

const v3 = (a: Json): Json => ({ version: 'v3', uuid: a.uuid, name: a.name, contentType: a.contentType, content: a.content });

/** New authority on the source's connector, pointing at the same CA (manual host + name). */
export async function createAdcsAuthority(api: GuardedApi, name: string, source: AdcsSource): Promise<Ref> {
    const schema = await apiJson<Json[]>(api, 'GET', `/api/v1/authorities/${source.connectorUuid}/attributes`).catch(() => [] as Json[]);
    const byName = (n: string) => schema.find((a) => a.name === n) ?? source.attributes.find((a) => a.name === n);
    const method = byName('data_caSelectMethod');
    const host = byName('data_caHost');
    const caName = byName('data_caName');
    const attributes =
        method && host && caName
            ? [
                  v3({ ...method, contentType: 'string', content: [{ reference: 'Enter CA host and name manually', data: 'manual', contentType: 'string' }] }),
                  v3({ ...host, contentType: 'string', content: [{ data: source.caHost, contentType: 'string' }] }),
                  v3({ ...caName, contentType: 'string', content: [{ data: source.caName, contentType: 'string' }] }),
              ]
            : source.attributes.map(v3); // the connector exposes no manual fields: copy the source's selection as-is
    const created = await apiJson<Json>(api, 'POST', '/api/v1/authorities', {
        name,
        connectorUuid: source.connectorUuid,
        interfaceUuid: source.interfaceUuid,
        attributes,
        customAttributes: await requiredCustomAttributes(api, 'authorities', regName('ca')),
    });
    return { uuid: created.uuid, name };
}

export async function createAdcsRaProfile(api: GuardedApi, authorityUuid: string, name: string, template: { reference: string; data: string }): Promise<Ref> {
    const schema = await apiJson<Json[]>(api, 'GET', `/api/v1/authorities/${authorityUuid}/attributes/raProfile`);
    const tpl = schema.find((a) => a.name === 'data_certificateTemplate');
    expect(tpl, 'RA profile schema has no data_certificateTemplate').toBeTruthy();
    const created = await apiJson<Json>(api, 'POST', `/api/v1/authorities/${authorityUuid}/raProfiles`, {
        name,
        description: `REG run ${RUN_ID}`,
        attributes: [v3({ ...tpl, contentType: 'string', content: [{ reference: template.reference, data: template.data, contentType: 'string' }] })],
        customAttributes: await requiredCustomAttributes(api, 'raProfiles', regName('ca')),
    });
    return { uuid: created.uuid, name };
}

/** Enable an RA profile this run created (RA profiles are created disabled). */
export async function enableOwnRaProfile(api: GuardedApi, authorityUuid: string, raProfile: OwnRef): Promise<void> {
    await assertOwnLive(api, 'raProfiles', raProfile, 'enableOwnRaProfile');
    await apiJson(api, 'PATCH', `/api/v1/authorities/${authorityUuid}/raProfiles/${raProfile.uuid}/enable`);
}

/** ACME profile with one exact, pre-authorized DNS identifier: orders for it need no challenge. */
export async function createAcmeProfile(api: GuardedApi, name: string, identifier: string): Promise<Ref> {
    const created = await apiJson<Json>(api, 'POST', '/api/v1/acmeProfiles', {
        name,
        description: `REG run ${RUN_ID}`,
        retryInterval: 30,
        validity: 36000,
        requireContact: false,
        requireTermsOfService: false,
        issueCertificateAttributes: [],
        revokeCertificateAttributes: [],
        customAttributes: await requiredCustomAttributes(api, 'acmeProfiles', regName('ca')),
        preauthorizedIdentifiers: [{ type: 'dns', value: identifier, matchType: 'exact', allowWildcard: false }],
        identifierAuthorizationMode: 'preauthorizedOrChallenge',
    });
    return { uuid: created.uuid, name };
}

export async function enableOwnAcmeProfile(api: GuardedApi, acmeProfile: OwnRef): Promise<void> {
    await assertOwnLive(api, 'acmeProfiles', acmeProfile, 'enableOwnAcmeProfile');
    await apiJson(api, 'PATCH', `/api/v1/acmeProfiles/${acmeProfile.uuid}/enable`);
}

export async function activateAcmeOnOwnRaProfile(api: GuardedApi, authorityUuid: string, raProfile: OwnRef, acmeProfile: OwnRef): Promise<void> {
    // M4: never on an issue-only parent (REG_RA_PROFILE_NAME) or any other RA profile the run did not create.
    await assertOwnLive(api, 'raProfiles', raProfile, 'activateAcmeOnOwnRaProfile (RA profile)');
    await assertOwnLive(api, 'acmeProfiles', acmeProfile, 'activateAcmeOnOwnRaProfile (ACME profile)');
    await apiJson(api, 'PATCH', `/api/v1/authorities/${authorityUuid}/raProfiles/${raProfile.uuid}/protocols/acme/activate/${acmeProfile.uuid}`, {
        issueCertificateAttributes: [],
        revokeCertificateAttributes: [],
    });
}

/**
 * v2 issue with an external CSR; returns the new certificate's uuid (issuance continues asynchronously) and, when the
 * server sent a Date header, the `createdAfter` for the certificate's derived `certKey_<CN>` key (server clock, R17).
 */
export async function issueWithCsr(api: GuardedApi, authorityUuid: string, raProfileUuid: string, csrDerBase64: string): Promise<{ uuid: string; body: Json; createdAfter: string }> {
    const answer = await apiJsonWithDate<Json>(api, 'POST', `/api/v2/operations/authorities/${authorityUuid}/raProfiles/${raProfileUuid}/certificates`, {
        request: csrDerBase64,
        format: 'pkcs10',
        attributes: [],
        customAttributes: await requiredCustomAttributes(api, 'certificates', regName('ca')),
    });
    return { uuid: answer.body.uuid, body: answer.body, createdAfter: createdAfterOf(answer, 'v2 issue') };
}

export async function createRole(api: GuardedApi, name: string): Promise<Ref> {
    const created = await apiJson<Json>(api, 'POST', '/api/v1/roles', { name, description: `REG run ${RUN_ID}`, customAttributes: await requiredCustomAttributes(api, 'roles', regName('ca')) });
    return { uuid: created.uuid, name };
}

/**
 * Upload a certificate synchronously (`POST /v1/certificates/upload` answers its uuid) and record it in the ledger
 * before any assertion (review Q14: an upload whose uuid is only found by a later poll leaves an unrecorded object
 * when the poll fails). `name` is the certificate's common name, which carries the run prefix. Core links a
 * `certKey_<CN>` key to every uploaded certificate (CertificateServiceImpl.uploadCertificateKey): it is recorded as a
 * derived object right after the certificate (incident fix, B1 live run 1: the key of REG-USE-02's upload was left behind).
 */
export async function uploadOwnCertificate(api: GuardedApi, pem: string, name: string, spec: string, note = 'uploaded'): Promise<OwnRef> {
    const answer = await apiJsonWithDate<Json>(api, 'POST', '/api/v1/certificates/upload', {
        certificate: Buffer.from(pem).toString('base64'),
        customAttributes: await requiredCustomAttributes(api, 'certificates', regName('ca')),
    });
    const ref = recordCreated('certificates', { uuid: answer.body.uuid, name }, spec, note);
    await recordDerivedKeyOrNamed(api, answer.body.uuid, name, createdAfterOf(answer, 'upload'), spec, note);
    return ref;
}

// ---------------------------------------------------------------- ensure: run state first, API create second

export async function ensureRole(api: GuardedApi, spec: string): Promise<OwnRef> {
    const state = readState();
    if (state.role) return state.role;
    const ref = recordCreated('roles', await createRole(api, regName('role')), spec, 'API prerequisite');
    updateState({ role: ref });
    return ref;
}

/** The run's ACME profile (created + enabled through the API when the run has none). */
export async function ensureAcmeProfile(api: GuardedApi, spec: string): Promise<OwnRef & { identifier: string }> {
    const state = readState();
    if (state.acmeProfile) return state.acmeProfile;
    const identifier = `${RUN_ID}.example.test`;
    const ref = recordCreated('acmeProfiles', await createAcmeProfile(api, regName('acme'), identifier), spec, `API prerequisite; pre-authorized ${identifier}`);
    await enableOwnAcmeProfile(api, ref);
    const acme = { ...ref, identifier };
    updateState({ acmeProfile: acme });
    return acme;
}

// ---------------------------------------------------------------- the CA choice (B1: CA-agnostic run RA profile)

/**
 * Why the MS ADCS chain cannot run on this tier, or undefined when it can: a connected MS ADCS NG authority exists
 * (REG_ADCS_CONNECTOR) AND its connector answers its live health (B1, Phase 2 §B consequence 1: the stored `connected`
 * status alone gave a false pass while the connector answered 503). The ADCS checklist specs (REG-CFG-02 / -03) skip
 * with this reason — an environment blocker, never a pass.
 */
export async function adcsBlocker(api: APIRequestContext): Promise<string | undefined> {
    const connectorName = process.env.REG_ADCS_CONNECTOR ?? 'MS-ADCS-NG-Connector';
    const all = await apiJson<Json[]>(api, 'GET', '/api/v1/authorities');
    const authority = all.find((a) => a.connectorName === connectorName && a.status === 'connected');
    if (!authority) return `no connected authority on the ${connectorName} connector on this tier (e.g. a local stack with EJBCA)`;
    const connector = (await listConnectors(api)).find((c) => c.uuid === authority.connectorUuid);
    if (!connector) return `${connectorName}: the authority's connector is not listed`;
    const health = await healthByVersion(api, connector);
    return health.healthy ? undefined : `${describeHealth(health)} — environment blocker (deploy gate, Phase 2 §B)`;
}

/** True when the MS ADCS chain can run: a connected MS ADCS NG authority whose connector is live (see adcsBlocker). */
export async function hasAdcs(api: APIRequestContext): Promise<boolean> {
    return (await adcsBlocker(api)) === undefined;
}

/**
 * The connectors whose authorities may issue the run's certificates, in the Phase 2 order (MS ADCS, EJBCA-NG, PyADCS):
 * REG_CA_CONNECTORS (comma list of connector registration names) overrides it.
 */
export function caConnectorOrder(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = env.REG_CA_CONNECTORS ?? `${env.REG_ADCS_CONNECTOR ?? 'MS-ADCS-NG-Connector'},EJBCA-NG-Connector,PyADCS-Connector`;
    return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

/** Thrown when no healthy authority with an enabled RA profile exists to copy from: the caller skips with `reason`. */
export class RaProfileSourceMissing extends Error {
    constructor(readonly reason: string) {
        super(reason);
        this.name = 'RaProfileSourceMissing';
    }
}

export interface RaProfileSource {
    /** The RA profile whose attributes are copied (read-only; it existed before the run, or is this run's own). */
    uuid: string;
    authorityUuid: string;
    connectorName: string;
}

/**
 * The first healthy CA in `caConnectorOrder()` that has a connected authority (not a run object) with an ENABLED RA
 * profile (not a run object) to copy — the first such RA profile by name (deterministic) —: health is read live and by
 * version (connectorApi). Read-only. Returns the source or `{ skip }` with one reason per connector ("deploy gate": a
 * skip, never a pass).
 */
export async function pickHealthyAuthority(api: APIRequestContext, env: NodeJS.ProcessEnv = process.env): Promise<RaProfileSource | { skip: string }> {
    const connectors = await listConnectors(api);
    const authorities = await apiJson<Json[]>(api, 'GET', '/api/v1/authorities');
    const raProfiles = await apiJson<Json[]>(api, 'GET', '/api/v1/raProfiles');
    const reasons: string[] = [];
    for (const name of caConnectorOrder(env)) {
        const connector = connectors.find((c) => c.name === name);
        if (!connector) {
            reasons.push(`${name}: not registered`);
            continue;
        }
        if (connector.status !== 'connected') {
            reasons.push(`${name}: stored status ${connector.status}`);
            continue;
        }
        const health = await healthByVersion(api, connector);
        if (!health.healthy) {
            reasons.push(`${name}: ${health.why}`);
            continue;
        }
        const onConnector = new Set(
            authorities.filter((a) => a.connectorUuid === connector.uuid && a.status === 'connected' && !hasRunFamilyPrefix(String(a.name))).map((a) => String(a.uuid)),
        );
        if (!onConnector.size) {
            reasons.push(`${name}: no connected authority`);
            continue;
        }
        // Fable F5: the candidates sorted by name (code points), so the copy source does not depend on the list order.
        const byName = (a: Json, b: Json): number => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0);
        const source = raProfiles
            .filter((r) => onConnector.has(String(r.authorityInstanceUuid)) && r.enabled === true && !hasRunFamilyPrefix(String(r.name)))
            .sort(byName)[0];
        if (!source) {
            reasons.push(`${name}: no enabled RA profile to copy the attributes from`);
            continue;
        }
        return { uuid: String(source.uuid), authorityUuid: String(source.authorityInstanceUuid), connectorName: name };
    }
    return { skip: `deploy gate: no healthy CA with an enabled RA profile to copy (${reasons.join('; ')}); DevOps: RA-profile attributes per tier` };
}

/** A response attribute (`ResponseAttribute` v2 / v3) as the request attribute that sets the same content. */
export function toRequestAttribute(a: Json): Json {
    return { version: requestVersion(a), uuid: a.uuid, name: a.name, contentType: a.contentType, content: a.content };
}

/**
 * Values for the REQUIRED custom attributes a tier defines on a resource (`GET /v1/attributes/custom/resources/{r}`):
 * a create without them answers 422 on such a tier. Optional attributes are left out. EVERY request attribute carries the
 * definition's `version` normalised by `requestVersion` (core sends a NUMBER, 3 / 2; v3 when the definition omits it: custom attributes are v3 in core) and EVERY content item its
 * `contentType`: `RequestAttribute` is polymorphic on `version` with a v2 default whose content items have no content type,
 * and `AttributeEngine.validateExtensibleList` compares reference, data AND contentType of a list item, so a v2-shaped item
 * never matches ("not part of predefined list", 422 — live run 2, 37 tests; the UI works because it sends v3). A list gets its
 * first predefined content item COPIED AS IS (completed with the contentType when the definition's item lacks it); string-like
 * types get `value`, numbers 1, booleans true, `date` today (UTC, yyyy-MM-dd), `time` HH:mm:ss, `datetime` ISO local without a
 * zone; any other required type throws (a setup the suite cannot fill). Nothing is ever created on the tier here: definitions
 * are only read. ONE helper: protocolProfiles and eventsDrivers call it too.
 */
export type CustomAttributeResource = string;

/** The pure part of `requiredCustomAttributes` (unit-tested per content type): definitions in, request attributes out. */
export function requiredAttributeItems(defs: Json[] | undefined, resource: string, value: string, now: Date = new Date()): Json[] {
    const out: Json[] = [];
    const iso = now.toISOString();
    for (const d of defs ?? []) {
        if (!d?.properties?.required) continue;
        const type = String(d.contentType);
        let item: Json;
        if (d.properties.list && Array.isArray(d.content) && d.content.length) item = { ...d.content[0], contentType: d.content[0].contentType ?? type };
        else if (['string', 'text', 'codeblock'].includes(type)) item = { data: value, contentType: type };
        else if (['integer', 'float'].includes(type)) item = { data: 1, contentType: type };
        else if (type === 'boolean') item = { data: true, contentType: type };
        else if (type === 'date') item = { data: iso.slice(0, 10), contentType: type };
        else if (type === 'time') item = { data: iso.slice(11, 19), contentType: type };
        else if (type === 'datetime') item = { data: iso.slice(0, 19), contentType: type };
        else throw new Error(`required custom attribute ${d.uuid} on ${resource} has content type ${type}, which the suite cannot fill`);
        out.push({ version: requestVersion(d, 'v3'), uuid: d.uuid, name: d.name, contentType: type, content: [item] });
    }
    return out;
}

export async function requiredCustomAttributes(api: APIRequestContext, resource: CustomAttributeResource, value: string): Promise<Json[]> {
    return requiredAttributeItems(await apiJson<Json[]>(api, 'GET', `/api/v1/attributes/custom/resources/${resource}`), resource, value);
}

/**
 * A new RA profile of the run on the source's authority whose connector attributes are COPIED from the source RA
 * profile (read-only: one GET of its detail; nothing on the source changes). Created disabled (core default, RA-1);
 * the caller records it and enables it through `enableOwnRaProfile`. The authority is a scope parent of the create
 * (`POST /v1/authorities/{a}/raProfiles` is on the guard's create list): an own RA profile may live under a
 * pre-existing authority.
 */
export async function createRaProfileLike(api: GuardedApi, source: Pick<RaProfileSource, 'uuid' | 'authorityUuid'>, name: string): Promise<Ref> {
    const detail = await apiJson<Json>(api, 'GET', `/api/v1/authorities/${source.authorityUuid}/raProfiles/${source.uuid}`);
    const attributes = (detail.attributes ?? []).filter((a: Json) => !a.type || a.type === 'data').map(toRequestAttribute);
    const created = await apiJson<Json>(api, 'POST', `/api/v1/authorities/${source.authorityUuid}/raProfiles`, {
        name,
        description: `REG run ${RUN_ID}`,
        attributes,
        customAttributes: await requiredCustomAttributes(api, 'raProfiles', regName('ca')),
    });
    return { uuid: created.uuid, name };
}

export type RunRaProfile = (OwnRef | IssueOnlyRef) & { authorityUuid: string };

/**
 * The run's RA profile, CA-agnostic (B1): the run state's when a flow already made it (REG-CFG-03 on a healthy MS ADCS
 * tier); REG_RA_PROFILE_NAME on a local stack (issue-only parent, M4); otherwise a NEW own RA profile copied from an
 * enabled RA profile of the first healthy CA (`pickHealthyAuthority`: MS ADCS, else EJBCA-NG, else PyADCS), enabled.
 * When no CA qualifies it throws RaProfileSourceMissing (callers skip with its reason: `ensureRaProfileOrSkip`).
 */
export async function ensureRaProfile(api: GuardedApi, spec: string): Promise<RunRaProfile> {
    const state = readState();
    if (state.raProfile) return state.raProfile;
    const existing = await existingRaProfile(api);
    if (existing) {
        updateState({ raProfile: existing });
        return existing;
    }
    const pick = await pickHealthyAuthority(api);
    if ('skip' in pick) throw new RaProfileSourceMissing(pick.skip);
    const ref = recordCreated('raProfiles', await createRaProfileLike(api, pick, regName('ra')), spec,
        `API prerequisite; connector attributes copied from an enabled RA profile on ${pick.connectorName}`, { authority: pick.authorityUuid });
    await enableOwnRaProfile(api, pick.authorityUuid, ref);
    const ra = { ...ref, authorityUuid: pick.authorityUuid };
    updateState({ raProfile: ra });
    return ra;
}

/**
 * ensureRaProfile, with the deploy gate as a skip: `skip` is called with the reason when no CA qualifies (pass
 * `(reason) => test.skip(true, reason)`); every other error propagates.
 */
export async function ensureRaProfileOrSkip(api: GuardedApi, spec: string, skip: (reason: string) => void): Promise<RunRaProfile> {
    return orSkipWithoutCa(ensureRaProfile(api, spec), skip);
}

/** Any work that needs the run RA profile (ensureOwnRaProfile, ensureAcmeOnRaProfile, …), with the deploy gate as a skip. */
export async function orSkipWithoutCa<T>(work: Promise<T>, skip: (reason: string) => void): Promise<T> {
    try {
        return await work;
    } catch (e) {
        if (e instanceof RaProfileSourceMissing) skip(e.reason);
        throw e;
    }
}

/** The ledger's own RA profile of this run with this exact name (created, not deleted), or undefined. */
function ownRaProfileNamed(name: string): (OwnRef & { authorityUuid: string }) | undefined {
    const lines = readLedger().filter((l) => l.runId === RUN_ID && l.type === 'raProfiles' && l.name === name);
    const created = [...lines].reverse().find((l) => l.event === 'created');
    if (!created || !ownership(created).own) return undefined;
    const authority = created.parents?.authority;
    const authorityUuid = Array.isArray(authority) ? authority[0] : authority;
    return authorityUuid ? { uuid: created.uuid, name: created.name, kind: 'own', authorityUuid } : undefined;
}

/**
 * An RA profile this run CREATED, for flows that change the RA profile (protocol activation): the run RA profile when
 * it is own; for an issue-only parent (REG_RA_PROFILE_NAME, local stack) an own clone of it (`<run>-ra-own`, connector
 * attributes copied read-only, enabled), found again through the ledger on later calls. M4: nothing is ever activated
 * on the issue-only parent itself.
 */
export async function ensureOwnRaProfile(api: GuardedApi, spec: string): Promise<OwnRef & { authorityUuid: string }> {
    const ra = await ensureRaProfile(api, spec);
    if (!isIssueOnly(ra)) return ra;
    const name = regName('ra-own');
    const known = ownRaProfileNamed(name);
    if (known) return known;
    const ref = recordCreated('raProfiles', await createRaProfileLike(api, ra, name), spec,
        'own clone of the issue-only RA profile (REG_RA_PROFILE_NAME): protocol activation needs an own RA profile (M4)', { authority: ra.authorityUuid });
    await enableOwnRaProfile(api, ra.authorityUuid, ref);
    return { ...ref, authorityUuid: ra.authorityUuid };
}

/** The run's own RA profile with the run's ACME profile activated on it; returns the RA-profile directory URL. */
export async function ensureAcmeOnRaProfile(api: GuardedApi, spec: string): Promise<{ raProfile: OwnRef & { authorityUuid: string }; acmeProfile: OwnRef & { identifier: string }; directoryUrl: string }> {
    const ra = await ensureOwnRaProfile(api, spec);
    const acmeProfile = await ensureAcmeProfile(api, spec);
    if (readState().acmeActivatedOn !== ra.uuid) {
        await activateAcmeOnOwnRaProfile(api, ra.authorityUuid, ra, acmeProfile);
        updateState({ acmeActivatedOn: ra.uuid });
    }
    const acme = await apiJson<Json>(api, 'GET', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/acme`);
    expect(acme.acmeAvailable, 'ACME should be available on the run RA profile').toBe(true);
    logger.info(`ACME directory: ${acme.directoryUrl}`);
    return { raProfile: ra, acmeProfile, directoryUrl: acme.directoryUrl };
}

/** The connector registration name of an authority (read-only), e.g. to decide the SAN oracle of a CA. */
export async function authorityConnectorName(api: APIRequestContext, authorityUuid: string): Promise<string> {
    const a = await apiJson<Json>(api, 'GET', `/api/v1/authorities/${authorityUuid}`);
    return String(a.connectorName ?? '');
}

/**
 * The SAN oracle of a CA (REG-USE-04.1 / 07.1, cert-lifecycle API-12: "what the CA accepts is the CA's decision"):
 * `exact` (set equality, DNS and IP) on EJBCA-NG, whose run profiles copy the CSR's SANs; `dns` (the DNS values are
 * present) on any other CA, whose template may rewrite the SAN extension.
 */
export function sanOracleFor(connectorName: string, env: NodeJS.ProcessEnv = process.env): 'exact' | 'dns' {
    const exact = (env.REG_EXACT_SAN_CONNECTORS ?? 'EJBCA-NG-Connector').split(',').map((s) => s.trim()).filter(Boolean);
    return exact.includes(connectorName) ? 'exact' : 'dns';
}

// ---------------------------------------------------------------- server clock, derived keys, protocol-made objects

/** A `createdAfter` from the SERVER's clock (R17): the Date header of a read just before an action the UI performs (else the runner clock, logged). */
export async function serverCreatedAfter(api: GuardedApi): Promise<string> {
    return createdAfterOf(await apiJsonWithDate(api, 'GET', '/api/v1/auth/profile'), 'server clock read');
}

/**
 * Records the key the platform linked to a run certificate (`certKey_<CN>`) as a DERIVED ledger object with the
 * server-clock `createdAfter`, so the run-end teardown removes it when the platform made it during the run and nothing
 * uses it any more (teardownHandlers `keys`). No key, or no server time: nothing is recorded (the key stays; logged).
 */
export async function recordDerivedKeyOf(api: APIRequestContext, certificateUuid: string, createdAfter: string | undefined, spec: string): Promise<void> {
    const cert = await getCertificate(api, certificateUuid);
    const keyUuid = cert.key?.uuid as string | undefined;
    if (!keyUuid) {
        logger.info(`certificate ${certificateUuid}: no linked key; no derived key recorded`);
        return;
    }
    if (ownership({ uuid: keyUuid }).own) return;
    let bound = createdAfter;
    if (!bound) {
        // Never a silent no-op (Sonnet F9): the key is recorded with the runner clock NOW as its bound. The key was made
        // before, so the teardown keeps it with a warning instead of deleting it — a visible, human-decided leftover.
        bound = createdAfterFrom(new Date(), 0, 0);
        logger.warn(`certificate ${certificateUuid}: no createdAfter for its key ${keyUuid}; recorded with the runner clock now (the teardown will keep it; check by hand)`);
    }
    recordDerived('keys', { uuid: keyUuid, name: `key of certificate ${certificateUuid}` }, spec, bound, 'key the platform linked to a run certificate', { certificate: certificateUuid });
}

/**
 * `recordDerivedKeyOf` after a `recordCreated`, with the by-name fallback of `recordingIssued` (Sonnet F2): when the
 * detail read throws, the run's certificates of `commonName` and their keys are recorded from the inventory instead;
 * a failure of that too surfaces (the test fails, the object is not silently left behind).
 */
export async function recordDerivedKeyOrNamed(api: APIRequestContext, certificateUuid: string, commonName: string, createdAfter: string | undefined, spec: string, note: string): Promise<void> {
    try {
        await recordDerivedKeyOf(api, certificateUuid, createdAfter, spec);
    } catch (e) {
        logger.warn(`recording the key of certificate ${certificateUuid} failed (${String(e).split('\n')[0].slice(0, 120)}); recording by name instead`);
        await recordIssuedNamed(api, commonName, createdAfter, spec, `${note} (recorded by name after a failed key read)`);
    }
}

/**
 * Ledger before assertion for objects a PROTOCOL made (ACME, cert-manager): every inventory certificate whose common
 * name is exactly `commonName` (a run-prefixed name, so only the run can have made it) and that is not in the ledger
 * yet is recorded as this run's. Returns the uuids found (recorded now or before).
 */
export async function recordCertificatesNamed(api: APIRequestContext, commonName: string, spec: string, note: string): Promise<string[]> {
    if (!hasRunFamilyPrefix(commonName)) throw new Error(`recordCertificatesNamed: ${commonName} carries no run prefix; only run-named certificates are adopted`);
    const rows = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: commonName }], 100);
    const uuids = rows.map((r) => String(r.uuid));
    for (const uuid of uuids) {
        if (!ownership({ uuid }).own) recordCreated('certificates', { uuid, name: commonName }, spec, note);
    }
    return uuids;
}

/** Every certificate of a run-prefixed common name and its platform-linked key, in the ledger (idempotent; B1 micro-fix, Fable F2). */
export async function recordIssuedNamed(api: APIRequestContext, commonName: string, createdAfter: string | undefined, spec: string, note: string): Promise<string[]> {
    const uuids = await recordCertificatesNamed(api, commonName, spec, note);
    for (const uuid of uuids) await recordDerivedKeyOf(api, uuid, createdAfter, spec);
    return uuids;
}

/**
 * Runs `work` — an issuance step that can throw AFTER the server issued (a finalize that errors, a wait that times out) —
 * and records the run's certificates of `commonName` and their keys whether it returns or throws (B1 micro-fix, Fable F2:
 * the teardown is ledger-only, so an issued certificate that was never recorded would be left on the tier). The work's own
 * error is the one the caller sees; a failure of the recording on that path is logged, never thrown over it.
 */
export async function recordingIssued<T>(
    api: APIRequestContext, commonName: string, createdAfter: string | undefined, spec: string, note: string, work: () => Promise<T>,
): Promise<{ result: T; uuids: string[] }> {
    let result: T;
    try {
        result = await work();
    } catch (e) {
        try {
            await recordIssuedNamed(api, commonName, createdAfter, spec, `${note} (recorded after the issuance step failed)`);
        } catch (r) {
            logger.warn(`recording the certificates of ${commonName} after a failed issuance step failed too: ${String(r).slice(0, 200)}`);
        }
        throw e;
    }
    return { result, uuids: await recordIssuedNamed(api, commonName, createdAfter, spec, note) };
}

/** Certificate states in which an issuance is still on its way (a successor can still appear or change). */
const ISSUANCE_IN_FLIGHT = new Set(['requested', 'pending_approval', 'pending_issue', 'pending_registration']);

/**
 * Records, then waits for the API state of `commonName` to settle, then records once more (B1 micro-fix, Fable F3): an
 * issuance that was in flight when its source (a cert-manager Certificate) was deleted can still produce a certificate.
 * Settled = two reads in a row list the same certificates in the same states and none is still requested / pending
 * (`expect.poll` with growing intervals, no fixed sleep); a poll that does not settle in `timeoutMs` is logged and the
 * final recording still runs. Returns every uuid recorded.
 */
export async function recordIssuedSettled(
    api: APIRequestContext, commonName: string, createdAfter: string | undefined, spec: string, note: string, opts: { timeoutMs?: number } = {},
): Promise<string[]> {
    await recordIssuedNamed(api, commonName, createdAfter, spec, note);
    let last: string | undefined;
    try {
        await expect.poll(async () => {
            const rows = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: commonName }], 100);
            const signature = rows.map((r) => `${r.uuid}:${r.state}`).sort().join(',');
            const settled = signature === last && !rows.some((r) => ISSUANCE_IN_FLIGHT.has(String(r.state)));
            last = signature;
            return settled;
        }, { timeout: opts.timeoutMs ?? 15_000, intervals: [500, 1_000, 2_000] }).toBe(true);
    } catch (e) {
        logger.warn(`the certificates of ${commonName} did not settle in time (${String(e).split('\n')[0].slice(0, 120)}); recording what exists`);
    }
    return recordIssuedNamed(api, commonName, createdAfter, spec, note);
}

/**
 * Records an ACME account the run registered (REG-USE-05): found by its server-assigned account id (the last path
 * segment of the account URL), recorded under a run-prefixed name (`acmeAccounts` is id-named, review R1).
 */
export async function recordAcmeAccount(api: APIRequestContext, accountUrl: string, acmeProfile: OwnRef, spec: string): Promise<OwnRef> {
    const accountId = accountUrl.split('/').pop() ?? '';
    const accounts = await apiJson<Json[]>(api, 'GET', '/api/v1/acmeAccounts');
    const mine = accounts.find((a) => String(a.accountId) === accountId && a.acmeProfileUuid === acmeProfile.uuid);
    expect(mine, `ACME account ${accountId} of the run ACME profile is listed`).toBeTruthy();
    const name = regName(`acme-account-${String(mine!.accountId).replace(/[^A-Za-z0-9-]/g, '')}`);
    if (ownership({ uuid: mine!.uuid }).own) return { uuid: mine!.uuid, name, kind: 'own' };
    return recordCreated('acmeAccounts', { uuid: mine!.uuid, name }, spec, 'ACME account, left valid', { acmeProfile: acmeProfile.uuid });
}

// ---------------------------------------------------------------- roles and users (B1: REG-CFG-07 / -09 extensions)

/** A NEW run role (not the run's shared role): created through the API with any required custom attribute, recorded. */
export async function createOwnRole(api: GuardedApi, suffix: string, spec: string, note = 'API prerequisite'): Promise<OwnRef> {
    const name = regName(`${suffix}-${Date.now().toString(36)}`);
    const created = await apiJson<Json>(api, 'POST', '/api/v1/roles', {
        name,
        description: `REG run ${RUN_ID}`,
        customAttributes: await requiredCustomAttributes(api, 'roles', regName('ca')),
    });
    return recordCreated('roles', { uuid: created.uuid, name }, spec, note);
}

export interface UserFields {
    firstName?: string;
    lastName?: string;
    email?: string;
    /** Default false: a user the suite creates cannot sign in (it has no identity-provider account anyway). */
    enabled?: boolean;
}

/** `POST /v1/users` for a run-prefixed username (any required custom attribute filled); returns the Ref (not recorded). */
export async function createUser(api: GuardedApi, username: string, fields: UserFields = {}): Promise<Ref> {
    const created = await apiJson<Json>(api, 'POST', '/api/v1/users', {
        username,
        firstName: fields.firstName ?? 'QA',
        lastName: fields.lastName ?? 'Regression',
        email: fields.email ?? `${username}@example.test`,
        enabled: fields.enabled ?? false,
        description: `REG run ${RUN_ID}`,
        groupUuids: [],
        customAttributes: await requiredCustomAttributes(api, 'users', regName('ca')),
    });
    return { uuid: created.uuid, name: username };
}

/** A NEW run user, recorded in the ledger right after the create call. */
export async function createOwnUser(api: GuardedApi, suffix: string, spec: string, fields: UserFields = {}, note = 'API prerequisite'): Promise<OwnRef> {
    const ref = await createUser(api, regName(`${suffix}-${Date.now().toString(36)}`), fields);
    return recordCreated('users', ref, spec, note);
}

/** Replaces the roles of an OWN user with OWN roles (`PATCH /v1/users/{user}/roles`); every object is checked live. */
export async function setOwnUserRoles(api: GuardedApi, user: OwnRef, roles: OwnRef[]): Promise<void> {
    await assertOwnLive(api, 'users', user, 'setOwnUserRoles (user)');
    for (const r of roles) await assertOwnLive(api, 'roles', r, 'setOwnUserRoles (role)');
    await apiJson(api, 'PATCH', `/api/v1/users/${user.uuid}/roles`, roles.map((r) => r.uuid));
}

/** Rows of a full list endpoint (roles, users) that carry `value` in `key`: absence is read from the LIST (core#2511). */
export async function listRowsNamed(api: APIRequestContext, listUrl: '/api/v1/roles' | '/api/v1/users', value: string, key = 'name'): Promise<Json[]> {
    const list = await apiJson<Json[]>(api, 'GET', listUrl);
    return list.filter((x) => x[key] === value);
}

/**
 * REG_RA_PROFILE_NAME: an existing, enabled RA profile of a LOCAL stack (e.g. the seeded EJBCA one) used instead of
 * creating the run's own. It is an issue-only parent: it has no ledger line, so assertOwn refuses every change to it.
 * On a shared tier the variable is ignored (the run makes its own RA profile).
 */
async function existingRaProfile(api: APIRequestContext): Promise<(IssueOnlyRef & { authorityUuid: string }) | undefined> {
    const wanted = process.env.REG_RA_PROFILE_NAME;
    if (!wanted) return undefined;
    if (!isLocalTier()) {
        logger.warn('REG_RA_PROFILE_NAME is honoured only with TIER_KIND=local; ignoring it on a shared tier');
        return undefined;
    }
    const ras = await apiJson<Json[]>(api, 'GET', '/api/v1/raProfiles');
    const ra = ras.find((r) => r.name === wanted);
    expect(ra, `REG_RA_PROFILE_NAME ${wanted} not found`).toBeTruthy();
    expect(ra!.enabled, `RA profile ${wanted} must be enabled`).toBe(true);
    return { ...issueOnly({ uuid: ra!.uuid, name: ra!.name }), authorityUuid: ra!.authorityInstanceUuid };
}

/** The run's MS ADCS authority (REG-CFG-02 / -03 chain; ADCS-specific by design: the checklist item is MS ADCS). */
export async function ensureAuthority(api: GuardedApi, spec: string): Promise<OwnRef | IssueOnlyRef> {
    const state = readState();
    if (state.authority) return state.authority;
    const existing = await existingRaProfile(api);
    if (existing) {
        // The authority of an issue-only RA profile is issue-only too: nothing on it is changed.
        const ref = issueOnly({ uuid: existing.authorityUuid, name: `authority of ${existing.name}` });
        updateState({ authority: ref });
        return ref;
    }
    const source = await findAdcsSource(api);
    const ref = recordCreated('authorities', await createAdcsAuthority(api, regName('adcs'), source), spec, `API prerequisite; CA copied from authority ${source.uuid}`);
    updateState({ authority: ref });
    return ref;
}
