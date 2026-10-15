/**
 * protocolCa — the protocol CA fixture F-CA (phase-05 B2 "Protocols"; plan §0.4): an OWN software token, token
 * profile and RSA-2048 key pair on the Software Cryptography Provider, and a certificate for that key issued through
 * the run RA profile (v2 issue with `keyUuid` + `tokenProfileUuid`, CSR built by core). The certificate is what a SCEP
 * profile takes as its CA certificate (rules §7.2 r2: ISSUED, VALID / EXPIRING, RSA key items with ENCRYPT + VERIFY on
 * the public and DECRYPT + SIGN on the ACTIVE private item) and what a CMP profile could sign responses with.
 *
 * Provider choice: a v2 software provider first, then v1 (`REG_SOFT_PROVIDER=<connector name>` pins one). core#2508:
 * when the certificate detail answers 500 on a v2 token the fixture is rebuilt on a v1 provider when one is
 * registered, else `ProtocolCaBlocked` names `[blocked: core#2508]` (the spec skips with that reason, never a pass).
 * Everything is recorded in the ledger right after its create and kept in the run state (token, tokenProfile, key,
 * caCertificate); the run-end teardown removes certificate → key (handler below) → token profile → token.
 */
import { waitForCertificateState } from '../certificateUtils';
import { Logger } from '../Logger';
import { connectorVersion } from './connectorApi';
import { GuardedApi, guardApi } from './guardedApi';
import { requiredCustomAttributesOf } from './protocolProfiles';
import { apiJson, ensureRaProfile, RunRaProfile } from './regressionApi';
import { KeyRef, LedgerLine, OwnRef, readState, recordCreated, regName, RUN_ID, updateState } from './regressionRun';
import type { TeardownContext } from './runTeardown';
import { deleteVerified } from './teardownHandlers';

const logger = new Logger('ProtocolCa');

type Json = Record<string, any>;

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
export const SOFT_PROVIDER = {
    tokenOptions: 'data_options',
    tokenAction: { name: 'data_createTokenAction', uuid: 'cc781ba3-d90b-4fe9-915a-e8d44e1cff86' },
    tokenName: { name: 'data_newTokenName', uuid: '21a79858-a246-4b2a-93e1-1677c8beb6a4' },
    tokenCode: { name: 'data_tokenCode', uuid: '181aae19-d2a3-40ca-b5c7-570c8dfbb3cb' },
    keyAlias: { name: 'data_keyAlias', uuid: '61a228de-c54e-461e-b0d7-ad156a547b51' },
    keyAlgorithm: { name: 'data_keyAlgorithm', uuid: '72159c04-d1a9-4703-8b23-469224425d5f' },
    rsaKeySize: { name: 'data_rsaKeySize', uuid: 'aa7df6ff-1d64-4a1a-96d6-6c7aeadfbdf3' },
} as const;

/** core's CSR attribute for the subject CN (attribute/CsrAttributes.java). */
export const CSR_COMMON_NAME = { name: 'commonName', uuid: '9abaeba0-973d-11ed-a8fc-0242ac120002' } as const;

const KEY_USAGES = ['sign', 'verify', 'encrypt', 'decrypt'];

/** The provider's token name rule: `^[a-zA-Z](?:_?[a-zA-Z0-9]+)*$` (the ILM token name stays run-prefixed). */
export const providerTokenName = (): string => `qareg_${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36).padStart(3, '0')}`;

export interface SoftProvider {
    uuid: string;
    name: string;
    version?: 1 | 2;
}

/** Registered software cryptography providers, v2 first (REG_SOFT_PROVIDER pins one by name). */
export async function softwareProviders(api: GuardedApi, env: NodeJS.ProcessEnv = process.env): Promise<SoftProvider[]> {
    const rows = await apiJson<Json[]>(api, 'GET', '/api/v1/connectors?functionGroup=cryptographyProvider&kind=SOFT');
    const out: SoftProvider[] = [];
    for (const r of rows ?? []) {
        if (r.status && String(r.status) !== 'connected') continue;
        const v = await connectorVersion(api, String(r.uuid));
        out.push({ uuid: String(r.uuid), name: String(r.name), ...(v.version ? { version: v.version } : {}) });
    }
    const pinned = env.REG_SOFT_PROVIDER;
    const list = pinned ? out.filter((p) => p.name === pinned) : out;
    return [...list].sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
}

/** An attribute of a schema by name (its uuid may differ per provider version; the name is the contract). */
const schemaAttr = (schema: Json[], name: string): Json | undefined => schema.find((a) => a?.name === name);

const stringAttr = (name: string, uuid: string, data: string, reference?: string): Json =>
    ({ name, uuid, version: 'v2', contentType: 'string', content: [{ data, ...(reference ? { reference } : {}) }] });

/**
 * Picks the content of a provider's choice attribute: the option whose reference or data matches `prefer`, else the
 * first option. Returns undefined when the attribute has no options (then nothing is sent for it).
 */
export function pickOption(attr: Json, prefer: RegExp): Json | undefined {
    const options: Json[] = Array.isArray(attr?.content) ? attr.content : [];
    if (!options.length) return undefined;
    return options.find((o) => prefer.test(String(o.reference ?? '')) || prefer.test(String(o.data ?? ''))) ?? options[0];
}

/** Signature attributes for an RSA key from the connector's `sign/attributes` schema: PKCS#1 v1.5 and SHA-256 preferred. */
export function signatureAttributesFrom(schema: Json[]): Json[] {
    const out: Json[] = [];
    for (const a of schema) {
        if (!a?.name || a.type === 'info' || a.type === 'group') continue;
        const prefer = /digest|hash/i.test(String(a.name)) ? /sha-?256/i : /scheme|padding/i.test(String(a.name)) ? /pkcs1|v1_?5|pkcs#?1/i : /./;
        const option = pickOption(a, prefer);
        if (!option) {
            if (a.properties?.required) throw new Error(`sign attribute ${a.name} is required but offers no options; the suite cannot fill it`);
            continue;
        }
        out.push({ name: a.name, uuid: a.uuid, version: 'v2', contentType: a.contentType ?? 'string', content: [{ data: option.data, ...(option.reference ? { reference: option.reference } : {}) }] });
    }
    return out;
}

/** The RSA key items of a key detail: `{ public, private }` or the reason they are not acceptable. */
export function keyItemProblems(key: Json): { privateUuid?: string; publicUuid?: string; problems: string[] } {
    const items: Json[] = Array.isArray(key?.items) ? key.items : [];
    const problems: string[] = [];
    const priv = items.find((i) => /^private/i.test(String(i.type)));
    const pub = items.find((i) => /^public/i.test(String(i.type)));
    if (!priv) problems.push('no private key item');
    if (!pub) problems.push('no public key item');
    for (const i of items) if (String(i.keyAlgorithm) !== 'RSA') problems.push(`item ${i.uuid} is ${i.keyAlgorithm}, not RSA`);
    const has = (i: Json | undefined, usages: string[]) => !!i && usages.every((u) => (i.usage ?? []).map(String).includes(u));
    if (priv && String(priv.state) !== 'active') problems.push(`private key item state is ${priv.state}, not active`);
    if (priv && !has(priv, ['decrypt', 'sign'])) problems.push(`private key item usages ${JSON.stringify(priv.usage)} lack decrypt + sign`);
    if (pub && !has(pub, ['encrypt', 'verify'])) problems.push(`public key item usages ${JSON.stringify(pub.usage)} lack encrypt + verify`);
    return { ...(priv ? { privateUuid: String(priv.uuid) } : {}), ...(pub ? { publicUuid: String(pub.uuid) } : {}), problems };
}

const ACCEPTABLE_VALIDATION = new Set(['valid', 'expiring']);

async function buildOn(api: GuardedApi, spec: string, provider: SoftProvider, raProfile: RunRaProfile): Promise<ProtocolCa> {
    const stamp = Date.now().toString(36);
    // 1. Token (ILM name run-prefixed; the provider's own token name follows its alphabet).
    const tokenSchema = await apiJson<Json[]>(api, 'GET', `/api/v1/tokens/${provider.uuid}/attributes?kind=SOFT`);
    const optionsAttr = schemaAttr(tokenSchema, SOFT_PROVIDER.tokenOptions);
    const attr = (def: { name: string; uuid: string }) => schemaAttr(tokenSchema, def.name)?.uuid ?? def.uuid;
    const tokenName = regName(`fca-token-${stamp}`);
    const tokenCreated = await apiJson<Json>(api, 'POST', '/api/v1/tokens', {
        name: tokenName,
        connectorUuid: provider.uuid,
        kind: 'SOFT',
        attributes: [
            ...(optionsAttr ? [stringAttr(SOFT_PROVIDER.tokenOptions, String(optionsAttr.uuid), 'new', 'Create new Token')] : []),
            stringAttr(SOFT_PROVIDER.tokenAction.name, attr(SOFT_PROVIDER.tokenAction), 'new', 'new'),
            stringAttr(SOFT_PROVIDER.tokenName.name, attr(SOFT_PROVIDER.tokenName), providerTokenName()),
            { name: SOFT_PROVIDER.tokenCode.name, uuid: attr(SOFT_PROVIDER.tokenCode), version: 'v2', contentType: 'secret', content: [{ data: { secret: `${RUN_ID}-${stamp}` } }] },
        ],
        customAttributes: await requiredCustomAttributesOf(api, 'tokens', regName('ca')),
    });
    const token = recordCreated('tokens', { uuid: String(tokenCreated.uuid), name: tokenName }, spec, `F-CA token on ${provider.name} (v${provider.version ?? '?'})`);

    // 2. Token profile with every usage the SCEP CA key needs.
    const tpName = regName(`fca-tp-${stamp}`);
    const tpCreated = await apiJson<Json>(api, 'POST', `/api/v1/tokens/${token.uuid}/tokenProfiles`, {
        name: tpName,
        description: `REG run ${RUN_ID}`,
        attributes: [],
        customAttributes: await requiredCustomAttributesOf(api, 'tokenProfiles', regName('ca')),
        enabled: true,
        usage: KEY_USAGES,
    });
    const tokenProfile = recordCreated('tokenProfiles', { uuid: String(tpCreated.uuid), name: tpName }, spec, 'F-CA token profile', { token: token.uuid });

    // 3. RSA-2048 key pair (enabled: ACTIVE items).
    const keySchema = await apiJson<Json[]>(api, 'GET', `/api/v1/tokens/${token.uuid}/tokenProfiles/${tokenProfile.uuid}/keys/keyPair/attributes`);
    const kattr = (def: { name: string; uuid: string }) => schemaAttr(keySchema, def.name)?.uuid ?? def.uuid;
    const keyName = regName(`fca-key-${stamp}`);
    const keyCreated = await apiJson<Json>(api, 'POST', `/api/v1/tokens/${token.uuid}/tokenProfiles/${tokenProfile.uuid}/keys/keyPair`, {
        name: keyName,
        description: `REG run ${RUN_ID}`,
        groupUuids: [],
        attributes: [
            stringAttr(SOFT_PROVIDER.keyAlias.name, kattr(SOFT_PROVIDER.keyAlias), `${providerTokenName()}key`),
            stringAttr(SOFT_PROVIDER.keyAlgorithm.name, kattr(SOFT_PROVIDER.keyAlgorithm), 'RSA', 'RSA'),
            { name: SOFT_PROVIDER.rsaKeySize.name, uuid: kattr(SOFT_PROVIDER.rsaKeySize), version: 'v2', contentType: 'integer', content: [{ reference: 'RSA_2048', data: 2048 }] },
        ],
        customAttributes: await requiredCustomAttributesOf(api, 'keys', regName('ca')),
        enabled: true,
    });
    const keyRef = recordCreated('keys', { uuid: String(keyCreated.uuid), name: keyName }, spec, 'F-CA RSA-2048 key pair', { token: token.uuid, tokenProfile: tokenProfile.uuid });
    let keyDetail = await apiJson<Json>(api, 'GET', `/api/v1/keys/${keyRef.uuid}`);
    let items = keyItemProblems(keyDetail);
    if (items.problems.some((p) => /usages/.test(p))) {
        // The items did not inherit the profile usages: set them on the own key (UpdateKeyUsageRequestDto).
        await apiJson(api, 'PUT', `/api/v1/keys/${keyRef.uuid}/usages`, { usage: KEY_USAGES });
        keyDetail = await apiJson<Json>(api, 'GET', `/api/v1/keys/${keyRef.uuid}`);
        items = keyItemProblems(keyDetail);
    }
    if (items.problems.length) throw new ProtocolCaBlocked(`F-CA key on ${provider.name} is not a SCEP CA key: ${items.problems.join('; ')}`);
    const key: KeyRef = { ...keyRef, keyItems: { privateUuid: items.privateUuid, publicUuid: items.publicUuid } };

    // 4. Certificate for the key through the run RA profile (core builds the CSR; the signature attributes come from the provider).
    const signSchema = await apiJson<Json[]>(api, 'GET', `/api/v1/operations/tokens/${token.uuid}/tokenProfiles/${tokenProfile.uuid}/keys/${key.uuid}/items/${items.privateUuid}/sign/attributes`);
    const commonName = regName(`fca-${stamp}`);
    const issued = await apiJson<Json>(api, 'POST', `/api/v2/operations/authorities/${raProfile.authorityUuid}/raProfiles/${raProfile.uuid}/certificates`, {
        format: 'pkcs10',
        tokenProfileUuid: tokenProfile.uuid,
        keyUuid: key.uuid,
        csrAttributes: [stringAttr(CSR_COMMON_NAME.name, CSR_COMMON_NAME.uuid, commonName)],
        signatureAttributes: signatureAttributesFrom(signSchema ?? []),
        attributes: [],
        customAttributes: await requiredCustomAttributesOf(api, 'certificates', regName('ca')),
    });
    const certRef = recordCreated('certificates', { uuid: String(issued.uuid), name: commonName }, spec, 'F-CA certificate (issued for the own token key)',
        { raProfile: raProfile.uuid, authority: raProfile.authorityUuid, key: key.uuid });
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
        const end = Date.now() + 60_000;
        while (!ACCEPTABLE_VALIDATION.has(validation) && Date.now() < end) {
            await new Promise((r) => setTimeout(r, 3000));
            validation = String((await certificateDetailOrBlocked(api, certRef.uuid)).validationStatus ?? '');
        }
        if (!ACCEPTABLE_VALIDATION.has(validation)) throw new ProtocolCaBlocked(`F-CA certificate validation status is "${validation}" (SCEP needs valid or expiring; rules §7.2 r2)`);
    }
    const fingerprint = String(detail.fingerprint ?? '').toLowerCase();
    if (!fingerprint) throw new Error(`F-CA certificate ${certRef.uuid}: the detail carries no fingerprint`);
    const ca: ProtocolCa = { token, tokenProfile, key, certificate: { ...certRef, commonName, fingerprint }, raProfile, providerVersion: provider.version };
    updateState({ token, tokenProfile, key, caCertificate: certRef });
    logger.info(`F-CA ready on ${provider.name}: certificate ${certRef.uuid} (${commonName})`);
    return ca;
}

/** The certificate detail, or CertificateDetail500 when it answers 500 (core#2508 on v2 tokens). */
async function certificateDetailOrBlocked(api: GuardedApi, uuid: string): Promise<Json> {
    const res = await api.get(`/api/v1/certificates/${uuid}`);
    if (res.status() === 500) throw new CertificateDetail500(uuid);
    if (!res.ok()) throw new Error(`GET /api/v1/certificates/${uuid} → ${res.status()} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as Json;
}

/**
 * The F-CA of this run: the run state's when its certificate is still ISSUED and readable, else built on the first
 * usable software provider. Throws `RaProfileSourceMissing` (no CA) or `ProtocolCaBlocked` (named reason) — the spec
 * skips with the reason, never a pass.
 */
export async function ensureProtocolCaCertificate(api: GuardedApi, spec: string): Promise<ProtocolCa> {
    const raProfile = await ensureRaProfile(api, spec);
    const state = readState();
    if (state.caCertificate && state.token && state.tokenProfile && state.key) {
        const res = await api.get(`/api/v1/certificates/${state.caCertificate.uuid}`);
        if (res.ok()) {
            const detail = (await res.json()) as Json;
            if (detail.state === 'issued' && ACCEPTABLE_VALIDATION.has(String(detail.validationStatus))) {
                return { token: state.token, tokenProfile: state.tokenProfile, key: state.key, raProfile, certificate: { ...state.caCertificate, commonName: String(detail.commonName ?? state.caCertificate.name), fingerprint: String(detail.fingerprint).toLowerCase() } };
            }
        }
        logger.warn(`run state F-CA certificate ${state.caCertificate.uuid} is not usable any more (${res.status()}); building a fresh one`);
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

// ------------------------------------------------------------------ run-end teardown of own token keys (NOT a registered handler)

/** The one-line plan text of `removeOwnTokenKey` for the registered `keys` handler to reuse. */
export const OWN_KEY_TEARDOWN_ACTION = 'own token key: PATCH /v1/keys/disable + /destroy [uuid] (4xx tolerated), DELETE /v1/keys [uuid], absence by GET /v1/keys/{uuid}';

/**
 * Removes an own token key (a non-derived `keys` line) the way the teardown does: disable and destroy its items (bulk
 * routes by key uuid through the guard; a 4xx "already" answer is tolerated), then bulk DELETE /v1/keys [uuid]; absence
 * proven by GET /v1/keys/{uuid}. Exactly ONE `keys` handler exists in the registry (teardownHandlers.ts, wired by the
 * guard pass and shared with the platform area): this module registers none and only exports the removal for it to call
 * after `guardHandler`'s ledger + live check (reviewer F5).
 */
export async function removeOwnTokenKey(ctx: TeardownContext, line: LedgerLine): Promise<void> {
    if (line.derived) throw new Error(`removeOwnTokenKey: handed a derived key line ${line.uuid}; derived keys belong to teardownHandlers`);
    const api = guardApi(ctx.api);
    for (const step of ['disable', 'destroy']) {
        const resp = await api.patch(`/api/v1/keys/${step}`, { data: [line.uuid] });
        if (resp.status() >= 500) throw new Error(`Failed to ${step} key ${line.uuid}: ${resp.status()} - ${(await resp.text()).slice(0, 300)}`);
        if (!resp.ok()) ctx.warn(`key ${line.uuid}: ${step} answered ${resp.status()} (${(await resp.text()).slice(0, 120)}); continuing to the delete`);
    }
    await deleteVerified(ctx, {
        uuid: line.uuid,
        what: `key ${line.uuid}`,
        detailUrl: `/api/v1/keys/${line.uuid}`,
        // The bulk DELETE answers 204 even for a uuid it did not find; the GET afterwards is the proof.
        send: () => api.delete('/api/v1/keys', { data: [line.uuid] }),
    });
}
