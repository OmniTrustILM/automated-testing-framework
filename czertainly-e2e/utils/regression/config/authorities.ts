/**
 * config/authorities — the MS ADCS chain of the configuration checklist (REG-CFG-02 / -03): the pre-existing MS ADCS
 * source authority (read only), the run's OWN authority on the same CA, the template lookup, the live-health blocker that
 * makes the chain skip on a tier without a healthy MS ADCS connector, and REG_RA_PROFILE_NAME (an issue-only RA profile
 * of a local stack). The MS ADCS source is the first connected authority on the MS-ADCS-NG connector (override with
 * REG_ADCS_SOURCE_AUTHORITY / REG_ADCS_CONNECTOR); its CA host and name are read at runtime and never stored here.
 * Also an own Basic credential and an own authority that copies a pre-existing one's data attributes (REG-CONN-14).
 */
import { APIRequestContext, APIResponse, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { Logger } from '../../Logger';
import { apiJson } from '../apiReads';
import { describeHealth, healthByVersion, listConnectors } from '../platform/connectorApi';
import type { AttributeDefinition } from '../platform/cryptoAlgorithmCases';
import { requestAttributesFrom, requiredCustomAttributes, toRequestAttributes } from '../customAttributes';
import type { GuardedApi } from '../guard/types';
import type { JsonObject } from '../json';
import { CreateOnlyRef, issueOnly, OwnRef, recordCreated, Ref } from '../ledger/ledger';
import { readRunState, runName, updateRunState } from '../ledger/runState';
import { hasRunFamilyPrefix } from '../run/runId';
import { isLocalTier } from '../tier/kind';

const logger = new Logger('authorities');

type Json = Record<string, any>;

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
    // Messages name foreign objects by uuid only: reports may be shared.
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
        customAttributes: await requiredCustomAttributes(api, 'authorities', runName('ca')),
    });
    return { uuid: created.uuid, name };
}

/**
 * Why the MS ADCS chain cannot run on this tier, or undefined when it can: a connected MS ADCS NG authority exists
 * (REG_ADCS_CONNECTOR) AND its connector answers its live health (the stored `connected`
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
    return health.healthy ? undefined : `${describeHealth(health)} — environment blocker (deploy gate)`;
}

/** The connector registration name of an authority (read-only), e.g. to decide the SAN oracle of a CA. */
export async function authorityConnectorName(api: APIRequestContext, authorityUuid: string): Promise<string> {
    const a = await apiJson<Json>(api, 'GET', `/api/v1/authorities/${authorityUuid}`);
    return String(a.connectorName ?? '');
}

/**
 * REG_RA_PROFILE_NAME: an existing, enabled RA profile of a LOCAL stack (e.g. the seeded EJBCA one) used instead of
 * creating the run's own. It is an issue-only parent: it has no ledger line, so assertOwn refuses every change to it.
 * On a shared tier the variable is ignored (the run makes its own RA profile).
 */
export async function existingRaProfile(api: APIRequestContext): Promise<(CreateOnlyRef & { authorityUuid: string }) | undefined> {
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
export async function ensureAuthority(api: GuardedApi, spec: string): Promise<OwnRef | CreateOnlyRef> {
    const state = readRunState();
    if (state.authority) return state.authority;
    const existing = await existingRaProfile(api);
    if (existing) {
        // The authority of an issue-only RA profile is issue-only too: nothing on it is changed.
        const ref = issueOnly({ uuid: existing.authorityUuid, name: `authority of ${existing.name}` });
        updateRunState({ authority: ref });
        return ref;
    }
    const source = await findAdcsSource(api);
    const ref = recordCreated('authorities', await createAdcsAuthority(api, runName('adcs'), source), spec, `API prerequisite; CA copied from authority ${source.uuid}`);
    updateRunState({ authority: ref });
    return ref;
}

// ---------------------------------------------------------------- own credential and an authority like an existing one (REG-CONN-14)

/** The credential-provider attribute definitions of a kind (`GET /v1/connectors/{uuid}/attributes/credentialProvider/{kind}`). */
export const listCredentialAttributes = (api: APIRequestContext, connectorUuid: string, kind = 'Basic'): Promise<AttributeDefinition[]> =>
    apiJson<AttributeDefinition[]>(api, 'GET', `/api/v1/connectors/${connectorUuid}/attributes/credentialProvider/${kind}`);

/** `POST /v1/credentials`: an own Basic credential on the credential connector (username / password from the definitions by name). */
export async function createOwnBasicCredential(api: GuardedApi, connector: { uuid: string; name: string }, suffix: string, spec: string, login?: { username: string; password: string }): Promise<OwnRef> {
    const name = runName(suffix);
    // A throw-away login for an OWN credential: generated per call, never a tier login, never logged.
    login = login ?? { username: `qa-${Date.now().toString(36)}`, password: `Qa-${randomBytes(12).toString('base64url')}` };
    const defs = await listCredentialAttributes(api, connector.uuid, 'Basic');
    const values: Record<string, unknown> = {};
    for (const d of defs) {
        if (/user/i.test(d.name)) values[d.name] = login.username;
        if (/pass/i.test(d.name)) values[d.name] = login.password;
    }
    const created = await apiJson<JsonObject>(api, 'POST', '/api/v1/credentials', {
        name,
        kind: 'Basic',
        connectorUuid: connector.uuid,
        attributes: requestAttributesFrom(defs, values, login.username),
        customAttributes: await requiredCustomAttributes(api, 'credentials', runName('ca')),
    });
    return recordCreated('credentials', { uuid: String(created.uuid), name }, spec, `own Basic credential on ${connector.name}`);
}

/** A connected pre-existing authority on a connector whose name matches (never a run object). */
export async function findAuthoritySource(api: APIRequestContext, connectorName: RegExp): Promise<JsonObject | undefined> {
    const all = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/authorities');
    return all.find((a) => connectorName.test(String(a.connectorName)) && a.status === 'connected' && !/^qa-(reg|api)-/.test(String(a.name)));
}

/**
 * An own authority on the SAME connector as `source`, with the source's DATA attributes copied read-only (one GET of
 * its detail) and every credential-typed attribute replaced by the own credential: the own Basic credential is used
 * on an authority (REG-CONN-14) without any CA host written into the suite. The raw response is returned (a refused
 * creation is the connector's verdict: the caller records it and proves nothing was left behind).
 */
export async function createOwnAuthorityLike(api: GuardedApi, source: JsonObject, credential: OwnRef, suffix: string, spec: string): Promise<{ name: string; response: APIResponse; ref?: OwnRef }> {
    const name = runName(suffix);
    const detail = await apiJson<JsonObject>(api, 'GET', `/api/v1/authorities/${source.uuid}`);
    const attributes = toRequestAttributes(detail.attributes as JsonObject[] | undefined).map((a) =>
        a.contentType === 'credential' ? { ...a, content: [{ reference: credential.name, data: { uuid: credential.uuid, name: credential.name } }] } : a);
    const response = await api.post('/api/v1/authorities', {
        data: {
            name,
            connectorUuid: source.connectorUuid,
            kind: detail.kind ?? source.kind,
            attributes,
            customAttributes: await requiredCustomAttributes(api, 'authorities', runName('ca')),
        },
    });
    if (!response.ok()) return { name, response };
    const created = (await response.json()) as JsonObject;
    return { name, response, ref: recordCreated('authorities', { uuid: String(created.uuid), name }, spec, `own authority like ${source.connectorName} with the own credential`) };
}
