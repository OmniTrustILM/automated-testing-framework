/**
 * protocolCa — the protocol CA fixture.
 *
 * WHAT: the protocol CA fixture: an own software token, token profile and RSA-2048 key pair, and a certificate
 *       for that key issued through the run RA profile. SCEP profiles take it as their CA certificate. A v2 software provider
 *       is preferred, a v1 provider is the fallback; when neither yields a readable certificate the fixture throws
 *       `ProtocolCaBlocked` with the reason and the test skips. Every object is recorded right after its create.
 * WHY: SCEP profiles need a CA certificate issued through the run RA profile.
 * HOW: An own software token, profile and RSA-2048 key, and a certificate issued for that key; v2 provider first, v1 as fallback, else
 * `ProtocolCaBlocked` and the test skips; every object is recorded right after its create.
 */
import { waitForCertificateState } from '../wait/certificateState';
import { Logger } from '../../Logger';
import { connectorVersion } from '../platform/connectorApi';
import { GuardedApi } from '../guard/types';
import { requiredCustomAttributes } from '../customAttributes';
import { requestVersion } from '../attributeVersion';
import { commonNameRequestAttribute } from '../lifecycle/preRegistration';
import { apiJson } from '../apiReads';
import { ensureRunRaProfile, RunRaProfile } from '../ownRaProfiles';
import { KeyRef, OwnRef, recordCreated } from '../ledger/ledger';
import { readRunState, runName, runId, updateRunState } from '../ledger/runState';
import { pollUntil } from '../wait';
import type { JsonObject } from '../json';
import { uniqueSuffix } from '../text';
import { settings } from '../run/settings';

const logger = new Logger('ProtocolCa');

/** The fixture cannot be built on this tier (named reason: the spec skips with it). */
export class ProtocolCaBlocked extends Error {
    constructor(readonly reason: string) {
        super(reason);
        this.name = 'ProtocolCaBlocked';
    }
}

/** core#2508: the certificate detail answered 500 for a certificate whose key lives on a v2 token. */
class CertificateDetail500 extends Error {
    constructor(readonly certificateUuid: string) {
        super(`certificate ${certificateUuid}: detail answered 500 (core#2508)`);
        this.name = 'CertificateDetail500';
    }
}

export interface ProtocolCa {
    token: OwnRef;
    tokenProfile: OwnRef;
    key: KeyRef;
    certificate: OwnRef & { commonName: string; fingerprint: string };
    raProfile: RunRaProfile;
    providerVersion?: 1 | 2;
}

/** Software Cryptography Provider attribute names / uuids (qa-integrations/software-cryptography-provider sources). */
const SOFT_PROVIDER = {
    tokenOptions: 'data_options',
    tokenAction: { name: 'data_createTokenAction', uuid: 'cc781ba3-d90b-4fe9-915a-e8d44e1cff86' },
    tokenName: { name: 'data_newTokenName', uuid: '21a79858-a246-4b2a-93e1-1677c8beb6a4' },
    tokenCode: { name: 'data_tokenCode', uuid: '181aae19-d2a3-40ca-b5c7-570c8dfbb3cb' },
    keyAlias: { name: 'data_keyAlias', uuid: '61a228de-c54e-461e-b0d7-ad156a547b51' },
    keyAlgorithm: { name: 'data_keyAlgorithm', uuid: '72159c04-d1a9-4703-8b23-469224425d5f' },
    rsaKeySize: { name: 'data_rsaKeySize', uuid: 'aa7df6ff-1d64-4a1a-96d6-6c7aeadfbdf3' },
} as const;

const KEY_USAGES = ['sign', 'verify', 'encrypt', 'decrypt'];

/** The provider's token name rule: `^[a-zA-Z](?:_?[a-zA-Z0-9]+)*$` (the ILM token name stays run-prefixed). */
export const providerTokenName = (): string => `qareg_${uniqueSuffix()}`;

export interface SoftProvider {
    uuid: string;
    name: string;
    /** The token kind, as the connector declares it on its cryptographyProvider function group (sent on the token requests). */
    kind: string;
    version?: 1 | 2;
}

/** The function group and the kind the Software Cryptography Provider declares (its token kind; the connector defines it). */
export const SOFT_PROVIDER_GROUP = { functionGroup: 'cryptographyProvider', kind: 'SOFT' } as const;

/**
 * Pure: the rows of `GET /v1/connectors` that are not reported as other than `connected` and whose `functionGroup` group
 * declares `kind`, with the kind read back from that group. This is the filter core applies to
 * `?functionGroup=&kind=` (ConnectorServiceImpl.java), done on the list because core binds the `kind` query
 * through OptionalEnumConverter and answers 422 "Unknown enum value" for every kind.
 */
export function connectorsOfKind(rows: readonly JsonObject[], functionGroup: string, kind: string): Array<{ uuid: string; name: string; kind: string }> {
    const out: Array<{ uuid: string; name: string; kind: string }> = [];
    for (const r of rows) {
        if (r?.status && String(r.status) !== 'connected') continue;
        const groups = (Array.isArray(r?.functionGroups) ? r.functionGroups : []) as JsonObject[];
        const declared = groups
            .filter((g) => (g?.functionGroupCode ?? g?.code) === functionGroup)
            .flatMap((g) => (Array.isArray(g.kinds) ? g.kinds : []) as unknown[])
            .find((k) => k === kind);
        if (typeof declared === 'string') out.push({ uuid: String(r.uuid), name: String(r.name), kind: declared });
    }
    return out;
}

/** Registered software cryptography providers, v2 first (REG_SOFT_PROVIDER pins one by name). */
async function softwareProviders(api: GuardedApi, env: NodeJS.ProcessEnv = process.env): Promise<SoftProvider[]> {
    const rows = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/connectors');
    const out: SoftProvider[] = [];
    for (const r of connectorsOfKind(rows ?? [], SOFT_PROVIDER_GROUP.functionGroup, SOFT_PROVIDER_GROUP.kind)) {
        const v = await connectorVersion(api, r.uuid);
        out.push({ ...r, ...(v.version ? { version: v.version } : {}) });
    }
    const pinned = settings(env).softProvider;
    const list = pinned ? out.filter((p) => p.name === pinned) : out;
    return [...list].sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
}

/** An attribute of a schema by name (its uuid may differ per provider version; the name is the contract). */
const schemaAttr = (schema: JsonObject[], name: string): JsonObject | undefined => schema.find((a) => a?.name === name);

/**
 * Pure: a request attribute for a definition of a provider schema. The version is the definition's (core refuses another one:
 * AttributeEngine `validateVersionsMatch`), v2 when the schema does not say; a v3 item carries its own `contentType`
 * (BaseAttributeContentV3 has no default subtype), a v2 item does not. `fallback` names the attribute when the schema lacks it.
 */
export function schemaRequestAttribute(def: JsonObject | undefined, fallback: { name: string; uuid: string }, contentType: string, items: JsonObject[]): JsonObject {
    const version = requestVersion(def, 'v2');
    const content = version === 'v3' ? items.map((i) => ({ ...i, contentType: i.contentType ?? contentType })) : items;
    return { name: fallback.name, uuid: def?.uuid ?? fallback.uuid, version, contentType, content };
}

const item = (data: unknown, reference?: string): JsonObject => ({ data, ...(reference ? { reference } : {}) });

/**
 * Picks the content of a provider's choice attribute: the option whose reference or data matches `prefer`, else the
 * first option. Returns undefined when the attribute has no options (then nothing is sent for it).
 */
export function pickOption(attr: JsonObject, prefer: RegExp): JsonObject | undefined {
    const options: JsonObject[] = Array.isArray(attr?.content) ? attr.content : [];
    if (!options.length) return undefined;
    return options.find((o) => prefer.test(String(o.reference ?? '')) || prefer.test(String(o.data ?? ''))) ?? options[0];
}

/** Signature attributes for an RSA key from the connector's `sign/attributes` schema: PKCS#1 v1.5 and SHA-256 preferred. */
export function signatureAttributesFrom(schema: JsonObject[]): JsonObject[] {
    const out: JsonObject[] = [];
    for (const a of schema) {
        if (!a?.name || a.type === 'info' || a.type === 'group') continue;
        const prefer = /digest|hash/i.test(String(a.name)) ? /sha-?256/i : /scheme|padding/i.test(String(a.name)) ? /pkcs1|v1_?5|pkcs#?1/i : /./;
        const option = pickOption(a, prefer);
        if (!option) {
            if ((a.properties as JsonObject | undefined)?.required) throw new Error(`sign attribute ${a.name} is required but offers no options; the suite cannot fill it`);
            continue;
        }
        out.push(schemaRequestAttribute(a, { name: String(a.name), uuid: a.uuid as string }, String(a.contentType ?? 'string'), [item(option.data, option.reference ? String(option.reference) : undefined)]));
    }
    return out;
}

/** The RSA key items of a key detail: `{ public, private }` or the reason they are not acceptable. */
export function keyItemProblems(key: JsonObject): { privateUuid?: string; publicUuid?: string; problems: string[] } {
    const items: JsonObject[] = Array.isArray(key?.items) ? key.items : [];
    const problems: string[] = [];
    const priv = items.find((i) => /^private/i.test(String(i.type)));
    const pub = items.find((i) => /^public/i.test(String(i.type)));
    if (!priv) problems.push('no private key item');
    if (!pub) problems.push('no public key item');
    for (const i of items) if (String(i.keyAlgorithm) !== 'RSA') problems.push(`item ${i.uuid} is ${i.keyAlgorithm}, not RSA`);
    const has = (i: JsonObject | undefined, usages: string[]) => !!i && usages.every((u) => ((i.usage ?? []) as unknown[]).map(String).includes(u));
    if (priv && String(priv.state) !== 'active') problems.push(`private key item state is ${priv.state}, not active`);
    if (priv && !has(priv, ['decrypt', 'sign'])) problems.push(`private key item usages ${JSON.stringify(priv.usage)} lack decrypt + sign`);
    if (pub && !has(pub, ['encrypt', 'verify'])) problems.push(`public key item usages ${JSON.stringify(pub.usage)} lack encrypt + verify`);
    return { ...(priv ? { privateUuid: String(priv.uuid) } : {}), ...(pub ? { publicUuid: String(pub.uuid) } : {}), problems };
}

const ACCEPTABLE_VALIDATION = new Set(['valid', 'expiring']);

async function buildOn(api: GuardedApi, spec: string, provider: SoftProvider, raProfile: RunRaProfile): Promise<ProtocolCa> {
    const stamp = uniqueSuffix();
    // 1. Token (ILM name run-prefixed; the provider's own token name follows its alphabet).
    const tokenSchema = await apiJson<JsonObject[]>(api, 'GET', `/api/v1/tokens/${provider.uuid}/attributes?kind=${encodeURIComponent(provider.kind)}`);
    const optionsAttr = schemaAttr(tokenSchema, SOFT_PROVIDER.tokenOptions);
    const tattr = (def: { name: string; uuid: string }, contentType: string, items: JsonObject[]): JsonObject => schemaRequestAttribute(schemaAttr(tokenSchema, def.name), def, contentType, items);
    const tokenName = runName(`fca-token-${stamp}`);
    const tokenCreated = await apiJson<JsonObject>(api, 'POST', '/api/v1/tokens', {
        name: tokenName,
        connectorUuid: provider.uuid,
        kind: provider.kind,
        attributes: [
            ...(optionsAttr ? [schemaRequestAttribute(optionsAttr, { name: SOFT_PROVIDER.tokenOptions, uuid: String(optionsAttr.uuid) }, 'string', [item('new', 'Create new Token')])] : []),
            tattr(SOFT_PROVIDER.tokenAction, 'string', [item('new', 'new')]),
            tattr(SOFT_PROVIDER.tokenName, 'string', [item(providerTokenName())]),
            tattr(SOFT_PROVIDER.tokenCode, 'secret', [item({ secret: `${runId()}-${stamp}` })]),
        ],
        customAttributes: await requiredCustomAttributes(api, 'tokens', runName('ca')),
    });
    const token = recordCreated('tokens', { uuid: String(tokenCreated.uuid), name: tokenName }, { spec, note: `protocol CA token on ${provider.name} (v${provider.version ?? '?'})` });

    // 2. Token profile with every usage the SCEP CA key needs.
    const tpName = runName(`fca-tp-${stamp}`);
    const tpCreated = await apiJson<JsonObject>(api, 'POST', `/api/v1/tokens/${token.uuid}/tokenProfiles`, {
        name: tpName,
        description: `REG run ${runId()}`,
        attributes: [],
        customAttributes: await requiredCustomAttributes(api, 'tokenProfiles', runName('ca')),
        enabled: true,
        usage: KEY_USAGES,
    });
    const tokenProfile = recordCreated('tokenProfiles', { uuid: String(tpCreated.uuid), name: tpName }, { spec, note: 'protocol CA token profile', parents: { token: token.uuid } });

    // 3. RSA-2048 key pair (enabled: ACTIVE items).
    const keySchema = await apiJson<JsonObject[]>(api, 'GET', `/api/v1/tokens/${token.uuid}/tokenProfiles/${tokenProfile.uuid}/keys/keyPair/attributes`);
    const kattr = (def: { name: string; uuid: string }, contentType: string, items: JsonObject[]): JsonObject => schemaRequestAttribute(schemaAttr(keySchema, def.name), def, contentType, items);
    const keyName = runName(`fca-key-${stamp}`);
    const keyCreated = await apiJson<JsonObject>(api, 'POST', `/api/v1/tokens/${token.uuid}/tokenProfiles/${tokenProfile.uuid}/keys/keyPair`, {
        name: keyName,
        description: `REG run ${runId()}`,
        groupUuids: [],
        attributes: [
            kattr(SOFT_PROVIDER.keyAlias, 'string', [item(`${providerTokenName()}key`)]),
            kattr(SOFT_PROVIDER.keyAlgorithm, 'string', [item('RSA', 'RSA')]),
            kattr(SOFT_PROVIDER.rsaKeySize, 'integer', [item(2048, 'RSA_2048')]),
        ],
        customAttributes: await requiredCustomAttributes(api, 'keys', runName('ca')),
        enabled: true,
    });
    const keyRef = recordCreated('keys', { uuid: String(keyCreated.uuid), name: keyName }, { spec, note: 'protocol CA RSA-2048 key pair', parents: { token: token.uuid, tokenProfile: tokenProfile.uuid } });
    let keyDetail = await apiJson<JsonObject>(api, 'GET', `/api/v1/keys/${keyRef.uuid}`);
    let items = keyItemProblems(keyDetail);
    if (items.problems.some((p) => /usages/.test(p))) {
        // The items did not inherit the profile usages: set them on the own key (UpdateKeyUsageRequestDto).
        await apiJson(api, 'PUT', `/api/v1/keys/${keyRef.uuid}/usages`, { usage: KEY_USAGES });
        keyDetail = await apiJson<JsonObject>(api, 'GET', `/api/v1/keys/${keyRef.uuid}`);
        items = keyItemProblems(keyDetail);
    }
    if (items.problems.length) throw new ProtocolCaBlocked(`protocol CA key on ${provider.name} is not a SCEP CA key: ${items.problems.join('; ')}`);
    const key: KeyRef = { ...keyRef, keyItems: { privateUuid: items.privateUuid, publicUuid: items.publicUuid } };

    // 4. Certificate for the key through the run RA profile (core builds the CSR; the signature attributes come from the provider).
    const signSchema = await apiJson<JsonObject[]>(api, 'GET', `/api/v1/operations/tokens/${token.uuid}/tokenProfiles/${tokenProfile.uuid}/keys/${key.uuid}/items/${items.privateUuid}/sign/attributes`);
    const commonName = runName(`fca-${stamp}`);
    const issued = await apiJson<JsonObject>(api, 'POST', `/api/v2/operations/authorities/${raProfile.authorityUuid}/raProfiles/${raProfile.uuid}/certificates`, {
        format: 'pkcs10',
        tokenProfileUuid: tokenProfile.uuid,
        keyUuid: key.uuid,
        // the CN definition of the RA profile's CSR attribute set (v3 on core 2.20), built like the pre-registration one
        csrAttributes: [await commonNameRequestAttribute(api, raProfile, commonName)],
        signatureAttributes: signatureAttributesFrom(signSchema ?? []),
        attributes: [],
        customAttributes: await requiredCustomAttributes(api, 'certificates', runName('ca')),
    });
    const certRef = recordCreated('certificates', { uuid: String(issued.uuid), name: commonName }, { spec, note: 'protocol CA certificate (issued for the own token key)', parents: { raProfile: raProfile.uuid, authority: raProfile.authorityUuid, key: key.uuid } });
    try {
        await waitForCertificateState(api, certRef.uuid, 'issued', 180_000);
    } catch (e) {
        // core#2508 shows up in the wait itself (the detail answers 500 three times in a row): read it once to tell it apart.
        if (/consecutive 500/.test(String(e))) await certificateDetailOrBlocked(api, certRef.uuid);
        throw e;
    }
    const detail = await certificateDetailOrBlocked(api, certRef.uuid);
    let validation = String(detail.validationStatus ?? '');
    if (!ACCEPTABLE_VALIDATION.has(validation)) {
        // A fresh certificate may wait for its first validation: ask for one (side-effect GET on an OWN certificate) and poll.
        await api.get(`/api/v1/certificates/${certRef.uuid}/validate`);
        validation = await pollUntil(
            async () => String((await certificateDetailOrBlocked(api, certRef.uuid)).validationStatus ?? ''),
            (status) => ACCEPTABLE_VALIDATION.has(status),
            { timeoutMs: 60_000, intervalMs: 3000, tolerateErrors: 0, onTimeout: 'return' },
        );
        if (!ACCEPTABLE_VALIDATION.has(validation)) throw new ProtocolCaBlocked(`protocol CA certificate validation status is "${validation}" (SCEP needs valid or expiring)`);
    }
    const fingerprint = String(detail.fingerprint ?? '').toLowerCase();
    if (!fingerprint) throw new Error(`protocol CA certificate ${certRef.uuid}: the detail carries no fingerprint`);
    const ca: ProtocolCa = { token, tokenProfile, key, certificate: { ...certRef, commonName, fingerprint }, raProfile, providerVersion: provider.version };
    updateRunState({ protocolCaToken: token, protocolCaTokenProfile: tokenProfile, protocolCaKey: key, caCertificate: certRef });
    logger.info(`protocol CA ready on ${provider.name}: certificate ${certRef.uuid} (${commonName})`);
    return ca;
}

/** The certificate detail, or CertificateDetail500 when it answers 500 (core#2508 on v2 tokens). */
async function certificateDetailOrBlocked(api: GuardedApi, uuid: string): Promise<JsonObject> {
    const res = await api.get(`/api/v1/certificates/${uuid}`);
    if (res.status() === 500) throw new CertificateDetail500(uuid);
    if (!res.ok()) throw new Error(`GET /api/v1/certificates/${uuid} → ${res.status()} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as JsonObject;
}

/**
 * The protocol CA of this run: the run state's when its certificate is still ISSUED and readable, else built on the first
 * usable software provider. Throws `RaProfileSourceMissing` (no CA) or `ProtocolCaBlocked` (named reason) — the spec
 * skips with the reason, never a pass.
 */
export async function ensureProtocolCaCertificate(api: GuardedApi, spec: string): Promise<ProtocolCa> {
    const raProfile = await ensureRunRaProfile(api, spec);
    const state = readRunState();
    if (state.caCertificate && state.protocolCaToken && state.protocolCaTokenProfile && state.protocolCaKey) {
        const res = await api.get(`/api/v1/certificates/${state.caCertificate.uuid}`);
        if (res.ok()) {
            const detail = (await res.json()) as JsonObject;
            if (detail.state === 'issued' && ACCEPTABLE_VALIDATION.has(String(detail.validationStatus))) {
                return { token: state.protocolCaToken, tokenProfile: state.protocolCaTokenProfile, key: state.protocolCaKey, raProfile, certificate: { ...state.caCertificate, commonName: String(detail.commonName ?? state.caCertificate.name), fingerprint: String(detail.fingerprint).toLowerCase() } };
            }
        }
        logger.warn(`run state protocol CA certificate ${state.caCertificate.uuid} is not usable any more (${res.status()}); building a fresh one`);
    }
    const providers = await softwareProviders(api);
    if (!providers.length) throw new ProtocolCaBlocked('no connected Software Cryptography Provider (functionGroup cryptographyProvider, kind SOFT) is registered on this tier');
    const tried: string[] = [];
    for (const provider of providers) {
        try {
            return await buildOn(api, spec, provider, raProfile);
        } catch (e) {
            if (!(e instanceof CertificateDetail500)) throw e;
            tried.push(`${provider.name} (v${provider.version ?? '?'})`);
            logger.warn(`core#2508: certificate detail answers 500 on ${provider.name}; trying the next provider`);
        }
    }
    throw new ProtocolCaBlocked(`[blocked: core#2508] certificate detail answers 500 for a certificate on ${tried.join(', ')} and no other software provider is registered`);
}

/** A spec's skip helper: runs `work`, turning the fixture's named refusals into a skip (RaProfileSourceMissing is left to orSkipWithoutCa). */
export async function orSkipWithoutProtocolCa<T>(work: Promise<T>, skip: (reason: string) => void): Promise<T> {
    try {
        return await work;
    } catch (e) {
        if (e instanceof ProtocolCaBlocked) skip(e.reason);
        throw e;
    }
}
