/**
 * authorities — the MS ADCS chain of the configuration checklist (REG-CFG-02 / -03) and the own authority and credential creators.
 * REG_RA_PROFILE_NAME (local stack only) is an issue-only parent: no ledger
 * line, never changed. CA host and name are read at run time, never stored.
 */
import { APIRequestContext, expect } from '@playwright/test';
import { Logger } from '../../Logger';
import { apiJson, ApiAnswer } from '../apiReads';
import { describeHealth, healthByVersion, listConnectors } from '../platform/connectorApi';
import type { AttributeDefinition } from '../platform/cryptoAlgorithmCases';
import { requiredCustomAttributes, toRequestAttributes } from '../customAttributes';
import type { GuardedApi } from '../guard/types';
import type { JsonObject } from '../json';
import { CreateOnlyRef, issueOnly, OwnRef } from '../ledger/ledger';
import { readRunState, runName, updateRunState, ownName } from '../ledger/runState';
import { hasRunFamilyPrefix } from '../run/runId';
import { isLocalTier } from '../tier/kind';
import { createOwn, recordIfAccepted } from '../ownCrud';
import { send } from '../inventory/searchApi';
import { settings } from '../run/settings';
import { objectOf, rowsOf } from '../json';

const logger = new Logger('Authorities');

export interface AdcsSource {
    uuid: string;
    name: string;
    connectorUuid: string;
    connectorName: string;
    interfaceUuid?: string;
    caHost: string;
    caName: string;
    attributes: JsonObject[];
}

export async function findAdcsSource(api: APIRequestContext): Promise<AdcsSource> {
    const { adcsSourceAuthority: wantedName, adcsConnector: connectorName } = settings();
    const all = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/authorities');
    const candidates = all.filter((a) =>
        wantedName ? a.name === wantedName : a.connectorName === connectorName && a.status === 'connected' && !hasRunFamilyPrefix(String(a.name)),
    );
    expect(candidates.length, `no MS ADCS source authority (connector ${connectorName}${wantedName ? `, name ${wantedName}` : ''})`).toBeGreaterThan(0);
    const detail = await apiJson<JsonObject>(api, 'GET', `/api/v1/authorities/${candidates[0].uuid}`);
    const attrs = rowsOf(detail.attributes);
    const valueOf = (name: string): JsonObject | undefined => rowsOf(attrs.find((a) => a.name === name)?.content)[0];
    const ca = valueOf('data_ca')?.data as JsonObject | undefined;
    const caHost = (ca?.caHost ?? valueOf('data_caHost')?.data) as string | undefined;
    const caName = (ca?.caName ?? valueOf('data_caName')?.data) as string | undefined;
    expect(caHost && caName, `source authority ${detail.uuid} exposes no CA host / name`).toBeTruthy();
    return {
        uuid: String(detail.uuid),
        name: String(detail.name),
        connectorUuid: String(detail.connectorUuid),
        connectorName: String(detail.connectorName),
        interfaceUuid: objectOf(detail.connectorInterface).uuid as string | undefined,
        caHost: caHost!,
        caName: caName!,
        attributes: attrs,
    };
}

export async function findAdcsTemplate(api: APIRequestContext, source: AdcsSource): Promise<{ reference: string; data: string }> {
    const ras = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/raProfiles');
    const onSource = ras.filter((r) => r.authorityInstanceUuid === source.uuid && r.enabled);
    for (const r of onSource) {
        const d = await apiJson<JsonObject>(api, 'GET', `/api/v1/authorities/${source.uuid}/raProfiles/${r.uuid}`);
        const t = rowsOf(rowsOf(d.attributes).find((a) => a.name === 'data_certificateTemplate')?.content)[0];
        if (t && (!settings().adcsTemplate || t.data === settings().adcsTemplate)) return { reference: t.reference as string, data: t.data as string };
    }
    const template = settings().adcsTemplate;
    if (template) return { reference: template, data: template };
    throw new Error(`no certificate template found on the RA profiles of authority ${source.uuid}; set REG_ADCS_TEMPLATE`);
}

const v3 = (a: JsonObject): JsonObject => ({ version: 'v3', uuid: a.uuid, name: a.name, contentType: a.contentType, content: a.content });

async function createOwnAdcsAuthority(api: GuardedApi, spec: string, suffix: string, o: { source: AdcsSource; name?: string }): Promise<OwnRef> {
    const { source } = o;
    const schema = await apiJson<JsonObject[]>(api, 'GET', `/api/v1/authorities/${source.connectorUuid}/attributes`).catch(() => [] as JsonObject[]);
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
    const { answer: _answer, ...ref } = await createOwn(api, spec, {
        type: 'authorities',
        path: '/api/v1/authorities',
        name: o.name ?? ownName(suffix),
        note: `API prerequisite; CA copied from authority ${source.uuid}`,
        body: {
            connectorUuid: source.connectorUuid,
            interfaceUuid: source.interfaceUuid,
            attributes,
            customAttributes: await requiredCustomAttributes(api, 'authorities', runName('ca')),
        },
    });
    return ref;
}

/**
 * Why the MS ADCS chain cannot run on this tier, or undefined: needs a connected MS ADCS NG authority AND a connector answering live health
 * (the stored `connected` alone gave a false pass).
 */
export async function adcsBlocker(api: APIRequestContext): Promise<string | undefined> {
    const connectorName = settings().adcsConnector;
    const all = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/authorities');
    const authority = all.find((a) => a.connectorName === connectorName && a.status === 'connected');
    if (!authority) return `no connected authority on the ${connectorName} connector on this tier (e.g. a local stack with EJBCA)`;
    const connector = (await listConnectors(api)).find((c) => c.uuid === authority.connectorUuid);
    if (!connector) return `${connectorName}: the authority's connector is not listed`;
    const health = await healthByVersion(api, connector);
    return health.healthy ? undefined : `${describeHealth(health)} — environment blocker (deploy gate)`;
}

export async function authorityConnectorName(api: APIRequestContext, authorityUuid: string): Promise<string> {
    const a = await apiJson<JsonObject>(api, 'GET', `/api/v1/authorities/${authorityUuid}`);
    return String(a.connectorName ?? '');
}

/**
 * REG_RA_PROFILE_NAME: an existing enabled RA profile of a LOCAL stack, used as an issue-only parent (assertOwn refuses changes to it);
 * ignored on a shared tier.
 */
export async function existingRaProfile(api: APIRequestContext): Promise<(CreateOnlyRef & { authorityUuid: string }) | undefined> {
    const wanted = settings().raProfileName;
    if (!wanted) return undefined;
    if (!isLocalTier()) {
        logger.warn('REG_RA_PROFILE_NAME is honoured only with TIER_KIND=local; ignoring it on a shared tier');
        return undefined;
    }
    const ras = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/raProfiles');
    const ra = ras.find((r) => r.name === wanted);
    expect(ra, `REG_RA_PROFILE_NAME ${wanted} not found`).toBeTruthy();
    expect(ra!.enabled, `RA profile ${wanted} must be enabled`).toBe(true);
    return { ...issueOnly({ uuid: String(ra!.uuid), name: String(ra!.name) }), authorityUuid: String(ra!.authorityInstanceUuid) };
}

export async function ensureAuthority(api: GuardedApi, spec: string): Promise<OwnRef | CreateOnlyRef> {
    const state = readRunState();
    if (state.authority) return state.authority;
    const existing = await existingRaProfile(api);
    if (existing) {
        // The authority of an issue-only RA profile is issue-only too.
        const ref = issueOnly({ uuid: existing.authorityUuid, name: `authority of ${existing.name}` });
        updateRunState({ authority: ref });
        return ref;
    }
    const source = await findAdcsSource(api);
    const ref = await createOwnAdcsAuthority(api, spec, 'adcs', { source, name: runName('adcs') });
    updateRunState({ authority: ref });
    return ref;
}


export const listCredentialAttributes = (api: APIRequestContext, connectorUuid: string, kind = 'Basic'): Promise<AttributeDefinition[]> =>
    apiJson<AttributeDefinition[]>(api, 'GET', `/api/v1/connectors/${connectorUuid}/attributes/credentialProvider/${kind}`);

export async function findAuthoritySource(api: APIRequestContext, connectorName: RegExp): Promise<JsonObject | undefined> {
    const all = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/authorities');
    return all.find((a) => connectorName.test(String(a.connectorName)) && a.status === 'connected' && !/^qa-(reg|api)-/.test(String(a.name)));
}

/**
 * An own authority on the same connector as `source`, data attributes copied read-only and credential attributes replaced by the own
 * credential; a probe: recorded only when the connector accepted it.
 */
export async function probeOwnAuthorityLike(api: GuardedApi, spec: string, suffix: string, o: { source: JsonObject; credential: OwnRef }): Promise<{ name: string; answer: ApiAnswer; ref?: OwnRef }> {
    const { source, credential } = o;
    const name = ownName(suffix);
    const detail = await apiJson<JsonObject>(api, 'GET', `/api/v1/authorities/${source.uuid}`);
    const attributes = toRequestAttributes(detail.attributes as JsonObject[] | undefined).map((a) =>
        a.contentType === 'credential' ? { ...a, content: [{ reference: credential.name, data: { uuid: credential.uuid, name: credential.name } }] } : a);
    const answer = await send(api, 'POST', '/api/v1/authorities', {
        data: {
            name,
            connectorUuid: source.connectorUuid,
            kind: detail.kind ?? source.kind,
            attributes,
            customAttributes: await requiredCustomAttributes(api, 'authorities', runName('ca')),
        },
    });
    return { name, answer, ref: recordIfAccepted('authorities', answer, name, spec, `own authority like ${source.connectorName} with the own credential`) };
}

/** True when a refused authority create names a logon or credential refusal by the connector. */
export function isCredentialLogonRefusal(text: string): boolean {
    return /STATUS_LOGON_FAILURE|0xc000006d|logon failure|login failed|invalid credentials|bad credentials/i.test(text);
}
