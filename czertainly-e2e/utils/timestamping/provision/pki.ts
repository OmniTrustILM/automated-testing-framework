/**
 * pki — the token, the token profile and, per set, the key pair, the RA profile and the TSA certificate with its trusted chain
 * (timestamping-setup.sh steps 6, 7 and 12-16).
 *
 * Each function sends the script's requests under run-prefixed names and records the object right after its create answered.
 * ONE exception on the local stack: the root of the TSA chain is marked trusted when it is not yet, because a signing profile
 * refuses an untrusted chain; this is done only when the root is self-signed and its `trustedCa` is exactly false.
 * Chain certificates that core fetched during the run are recorded as DERIVED lines with a server-clock bound; one whose
 * history cannot be read is not recorded and stays.
 */
import { createdAfterMarker, OwnRef, recordDerived } from '../../regression/ledger/ledger';
import { isOwnObject } from '../../regression/ledger/ownership';
import type { CryptoProvider } from '../config';
import { AttributeDef, attrUuid, chosenAttribute, groupUuid, keySpecAttributes, providerNames, RequestAttribute, requestAttribute, requestedKeySpec, signingOperationAttributes } from './attributes';
import { generatedSecret, recordOwn, SETUP_LEDGER_SPEC, SetupContext, uuidOf } from './context';
import type { CryptoConnectorRef, RaPlan } from './preflight';
import type { NamedUuid } from '../types';
import { TierError } from './transport';

type Json = Record<string, any>;

// ------------------------------------------------------------------ step 6: token

/**
 * `software_token_attributes`: the provider serves two token forms. An empty provider answers the create attributes
 * at the top level; one that already holds tokens answers a `data_options` selector whose `group_loadToken` callback
 * (option=new) yields them. Both are handled, as the script does.
 */
async function softwareTokenAttributes(ctx: SetupContext, connector: CryptoConnectorRef, keystoreName: string, code: string): Promise<RequestAttribute[]> {
    const v1 = ctx.cfg.cryptoProvider === 'software-v1';
    const formPath = v1 ? `/v1/connectors/${connector.uuid}/attributes/cryptographyProvider/SOFT` : `/v1/tokens/${connector.uuid}/attributes`;
    const callbackPath = v1 ? `/v1/connectors/${connector.uuid}/cryptographyProvider/SOFT/callback` : `/v2/connectors/${connector.uuid}/callback`;
    // The v1 callback names its connector kind (a name-keyed path): only the local-stack transport may send it (preflight.offlineBlocker).
    const callbackAdmin = v1 ? ctx.localAdmin : ctx.admin;
    if (!callbackAdmin) throw new TierError('the v1 software provider\'s token form is a name-keyed callback that a proven local stack alone may call');
    const defs = await ctx.admin.get<AttributeDef[]>(formPath);
    let createDefs = defs;
    let options: RequestAttribute | undefined;
    if (defs.some((d) => d.name === 'data_options' && d.type === 'data')) {
        const loadGroup = groupUuid(defs, 'group_loadToken');
        createDefs = (await callbackAdmin.request<AttributeDef[]>('POST', callbackPath, {
            uuid: loadGroup, name: 'group_loadToken', pathVariable: { option: 'new' }, requestParameter: {}, body: {},
        })).body ?? [];
        options = chosenAttribute(defs, 'data_options', 'new');
    }
    return [
        requestAttribute(createDefs, 'data_createTokenAction', [{ reference: 'new', data: 'new' }]),
        // The connector names a keystore with letters, digits and underscores only.
        requestAttribute(createDefs, 'data_newTokenName', [{ data: keystoreName }]),
        requestAttribute(createDefs, 'data_tokenCode', [{ data: { secret: code } }]),
        ...(options ? [options] : []),
    ];
}

/** `setup_token` (create branch): a token on the cryptography connector, with a generated token code. */
export async function createToken(ctx: SetupContext, connector: CryptoConnectorRef, name: string): Promise<OwnRef> {
    const attributes = await softwareTokenAttributes(ctx, connector, name.replace(/-/g, '_'), generatedSecret());
    const kind = ctx.cfg.cryptoProvider === 'software-v1' ? { kind: 'SOFT' } : {};
    const created = await ctx.admin.request('POST', '/v1/tokens', { name, connectorUuid: connector.uuid, attributes, customAttributes: [], ...kind });
    return recordOwn('tokens', { uuid: uuidOf(created.body, `token '${name}'`), name }, `timestamping token on ${connector.name}`, undefined, created.serverAt);
}

// ------------------------------------------------------------------ step 7: token profile

/** `setup_token_profile` (create branch): sign / verify / encrypt / decrypt, then enabled. */
export async function createTokenProfile(ctx: SetupContext, token: OwnRef, name: string): Promise<OwnRef> {
    const created = await ctx.admin.request('POST', `/v1/tokens/${token.uuid}/tokenProfiles`, {
        name, description: '', attributes: [], customAttributes: [], usage: ['sign', 'verify', 'encrypt', 'decrypt'],
    });
    const ref = recordOwn('tokenProfiles', { uuid: uuidOf(created.body, `token profile '${name}'`), name }, 'timestamping token profile', { token: token.uuid }, created.serverAt);
    await ctx.admin.request('PATCH', `/v1/tokens/${token.uuid}/tokenProfiles/${ref.uuid}/enable`);
    return ref;
}

// ------------------------------------------------------------------ step 12: key pair

export interface KeyPair {
    key: OwnRef;
    privateItemUuid: string;
}

/** `key_spec_definitions`: the key-spec group, resolved by the connector once the algorithm is chosen. */
async function keySpecDefinitions(ctx: SetupContext, tokenProfile: OwnRef, defs: AttributeDef[], keyAlgorithm: string, algorithmAttr: RequestAttribute): Promise<AttributeDef[]> {
    const group = providerNames(ctx.cfg.cryptoProvider).keySpecGroup;
    const uuid = groupUuid(defs, group);
    const body = ctx.cfg.cryptoProvider === 'software-v1'
        ? { uuid, name: group, pathVariable: { algorithm: keyAlgorithm }, requestParameter: {}, body: {}, filter: {} }
        : { uuid, name: group, attributes: [algorithmAttr] };
    return (await ctx.admin.request<AttributeDef[]>('POST', `/v1/keys/${tokenProfile.uuid}/callback`, body)).body ?? [];
}

/** `setup_key_pair` (create branch): the key of the family's algorithm with the script's default key spec, enabled. */
export async function createKeyPair(ctx: SetupContext, token: OwnRef, tokenProfile: OwnRef, keyAlgorithm: 'RSA' | 'ML-DSA', name: string): Promise<KeyPair> {
    const names = providerNames(ctx.cfg.cryptoProvider as CryptoProvider);
    const base = `/v1/tokens/${token.uuid}/tokenProfiles/${tokenProfile.uuid}/keys/keyPair`;
    const defs = await ctx.admin.get<AttributeDef[]>(`${base}/attributes`);
    const algorithm = chosenAttribute(defs, names.keyAlgorithm, keyAlgorithm);
    const alias = requestAttribute(defs, names.keyAlias, [{ data: name }]);
    const specDefs = await keySpecDefinitions(ctx, tokenProfile, defs, keyAlgorithm, algorithm);
    const spec = keySpecAttributes(specDefs, requestedKeySpec(names, keyAlgorithm), keyAlgorithm);
    const created = await ctx.admin.request<Json>('POST', base, { groupUuids: [], name, description: '', attributes: [alias, algorithm, ...spec], customAttributes: [] });
    const key = recordOwn('keys', { uuid: uuidOf(created.body, `${keyAlgorithm} key pair '${name}'`), name }, `timestamping ${keyAlgorithm} key`, { token: token.uuid, tokenProfile: tokenProfile.uuid }, created.serverAt);
    // The items are made with the key; recorded like keyApi.recordKeyItems does, so the item routes are typed and the
    // teardown treats them as gone with their key.
    const recordItems = (detail: Json | undefined): void => {
        for (const item of (detail?.items ?? []) as Json[]) {
            if (item?.uuid) recordOwn('keyItems', { uuid: String(item.uuid), name }, `${String(item.type)} item of key ${key.uuid}`, { key: key.uuid });
        }
    };
    recordItems(created.body);
    // The detail before the enable: its items are recorded even when the enable is refused.
    const detail = await ctx.admin.get<Json>(`/v1/keys/${key.uuid}`);
    if (!((created.body?.items ?? []) as Json[]).length) recordItems(detail);
    await ctx.admin.request('PATCH', `/v1/keys/${key.uuid}/enable`);
    const privateItem = ((detail?.items ?? []) as Json[]).find((i) => i.type === 'Private');
    if (!privateItem?.uuid) throw new TierError(`key ${key.uuid} has no Private item (items: ${JSON.stringify(((detail?.items ?? []) as Json[]).map((i) => i.type))})`);
    return { key, privateItemUuid: String(privateItem.uuid) };
}

// ------------------------------------------------------------------ step 13: RA profile

const ejbcaObject = (option: { id: unknown; name: string }) => [{ data: { id: option.id, name: option.name }, reference: option.name }];

/** `setup_ra_profile` (create branch) with the profile ids the preflight resolved; enabled. */
export async function createRaProfile(ctx: SetupContext, authority: NamedUuid, plan: RaPlan, qualified: boolean, name: string): Promise<OwnRef> {
    const a = plan.attrUuids;
    const certificateProfile = qualified ? plan.certificateProfile.qualified : plan.certificateProfile.nonQualified;
    const created = await ctx.admin.request('POST', `/v1/authorities/${authority.uuid}/raProfiles`, {
        name,
        description: '',
        attributes: [
            { name: 'endEntityProfile', content: ejbcaObject(plan.endEntityProfile), contentType: 'object', uuid: a.endEntityProfile, version: 'v2' },
            { name: 'certificateProfile', content: ejbcaObject(certificateProfile), contentType: 'object', uuid: a.certificateProfile, version: 'v2' },
            { name: 'certificationAuthority', content: ejbcaObject(plan.ca), contentType: 'object', uuid: a.certificationAuthority, version: 'v2' },
            { name: 'sendNotifications', content: [{ data: false }], contentType: 'boolean', uuid: a.sendNotifications, version: 'v2' },
            { name: 'keyRecoverable', content: [{ data: false }], contentType: 'boolean', uuid: a.keyRecoverable, version: 'v2' },
            // EJBCA_USERNAME_GEN_METHOD=CN: the end entity is named after the certificate's CN (run-prefixed, unique).
            { name: 'usernameGenMethod', content: [{ data: 'CN' }], contentType: 'string', uuid: a.usernameGenMethod, version: 'v2' },
        ],
        customAttributes: [],
    });
    const ref = recordOwn('raProfiles', { uuid: uuidOf(created.body, `RA profile '${name}'`), name }, `timestamping RA profile (${certificateProfile.name}, CA ${plan.ca.name})`, { authority: authority.uuid }, created.serverAt);
    await ctx.admin.request('PATCH', `/v1/authorities/${authority.uuid}/raProfiles/${ref.uuid}/enable`);
    return ref;
}

// ------------------------------------------------------------------ steps 14–16: certificate

export interface IssueInput {
    commonName: string;
    authority: NamedUuid;
    raProfile: OwnRef;
    token: OwnRef;
    tokenProfile: OwnRef;
    keyPair: KeyPair;
}

/** `issue_certificate`: a CSR made by the platform from the key, CN only, with the configured scheme and digest. */
export async function issueCertificate(ctx: SetupContext, input: IssueInput): Promise<OwnRef> {
    const csrDefs = await ctx.admin.get<AttributeDef[]>('/v1/certificates/csr/attributes');
    const cnUuid = attrUuid(csrDefs, 'commonName', 'string');
    const k = input.keyPair;
    const sigDefs = await ctx.admin.get<AttributeDef[]>(
        `/v1/operations/tokens/${input.token.uuid}/tokenProfiles/${input.tokenProfile.uuid}/keys/${k.key.uuid}/items/${k.privateItemUuid}/sign/attributes`,
    );
    const created = await ctx.admin.request('POST', `/v2/operations/authorities/${input.authority.uuid}/raProfiles/${input.raProfile.uuid}/certificates`, {
        format: 'pkcs10',
        request: '',
        attributes: [],
        csrAttributes: [{ name: 'commonName', content: [{ data: input.commonName, contentType: 'string' }], contentType: 'string', uuid: cnUuid, version: 'v3' }],
        signatureAttributes: signingOperationAttributes(sigDefs, ctx.cfg.signatureScheme, ctx.cfg.signatureDigest),
        keyUuid: k.key.uuid,
        tokenProfileUuid: input.tokenProfile.uuid,
        customAttributes: [],
    });
    return recordOwn('certificates', { uuid: uuidOf(created.body, `TSA certificate CN=${input.commonName}`), name: input.commonName }, 'timestamping TSA certificate',
        { raProfile: input.raProfile.uuid, authority: input.authority.uuid }, created.serverAt);
}

/** `poll_certificate`: issued, or the failure message of the certificate's history, or a timeout. */
export async function waitIssued(ctx: SetupContext, certificate: OwnRef): Promise<void> {
    const last = await ctx.admin.poll(
        () => ctx.admin.get<Json>(`/v1/certificates/${certificate.uuid}`),
        (d) => d?.state === 'issued' || d?.state === 'failed',
        ctx.poll.certificateAttempts, ctx.poll.certificateIntervalMs, `issuance of ${certificate.name}`,
    );
    if (last?.state === 'issued') return;
    if (last?.state === 'failed') {
        const history = await ctx.admin.get<Json[]>(`/v1/certificates/${certificate.uuid}/history`);
        const raw = (history ?? []).find((h) => h.event === 'Issue Certificate' && h.status === 'FAILED')?.message;
        let text = raw ?? '(no error message available in the certificate history)';
        try {
            // The message is a JSON-encoded string: {"message":"<text>"}.
            text = raw ? String(JSON.parse(raw).message ?? raw) : text;
        } catch {
            // not JSON: the message as it is
        }
        // The CA's message is the tier's text: the log has it, the reason only says where to look.
        ctx.log.warn(`issuance of ${certificate.name} failed: ${text}`);
        throw new TierError('certificate issuance failed (the CA\'s message is in the setup log)');
    }
    throw new TierError(`certificate issuance timed out after ${ctx.poll.certificateAttempts} reads (last state: '${last?.state ?? ''}')`);
}

/**
 * `trust_certificate_chain`: link the issuer now, walk to the root, mark the root trusted when it is not yet (the one
 * change to a pre-existing object, local stack only, logged), and wait until the TSA certificate validates.
 */
export async function trustChain(ctx: SetupContext, certificate: OwnRef): Promise<void> {
    // Building the chain links the issuer now, rather than whenever Core's queued validation runs.
    await ctx.admin.get(`/v1/certificates/${certificate.uuid}/chain`);
    const leaf = await ctx.admin.poll(
        () => ctx.admin.get<Json>(`/v1/certificates/${certificate.uuid}`),
        (d) => !!d?.issuerCertificateUuid || (d?.subjectDn !== undefined && d.subjectDn === d.issuerDn),
        ctx.poll.linkageAttempts, ctx.poll.linkageIntervalMs, `issuer linkage of ${certificate.name}`,
    );
    if (!leaf?.issuerCertificateUuid) {
        if (leaf?.subjectDn !== undefined && leaf.subjectDn === leaf.issuerDn) return; // self-signed: no chain to trust
        ctx.log.warn(`no issuer linked for ${certificate.name}: issuerDn '${leaf?.issuerDn ?? ''}'`);
        throw new TierError(`Core holds no issuer certificate for the TSA certificate after ${ctx.poll.linkageAttempts} reads; ` +
            'the issuing CA must be in the inventory (Core fetches it from the CA Issuers URI; the setup never uploads one)');
    }
    const chain: Json[] = [];
    let current = String(leaf.issuerCertificateUuid);
    let complete = false;
    for (let hop = 0; hop < 16 && !complete; hop++) {
        const detail = await ctx.admin.get<Json>(`/v1/certificates/${current}`);
        chain.push(detail);
        const next = detail?.issuerCertificateUuid ? String(detail.issuerCertificateUuid) : '';
        if (!next || next === current) complete = true;
        else current = next;
    }
    if (!complete) throw new TierError(`the chain of ${certificate.name} has more than 16 issuers; refusing to walk further`);
    const root = chain[chain.length - 1];
    await recordAddedIssuers(ctx, chain);
    // The top of the walked chain is a root only when it is self-signed; else Core lacks its issuer.
    if (root.subjectDn === undefined || root.subjectDn !== root.issuerDn) {
        ctx.log.warn(`the top of the chain of ${certificate.name} (${current}) is not self-signed: issuerDn '${root.issuerDn ?? ''}'`);
        throw new TierError('the top of the TSA certificate\'s chain is not self-signed: Core holds no certificate of its issuer');
    }
    if (root.trustedCa === false) {
        // Design rule 1: the ONE change to a pre-existing object, on a proven local stack only (`localAdmin`, never the strict guard).
        // A shared tier needs the root CA trusted beforehand: the block is unavailable with this reason otherwise.
        if (!ctx.localAdmin) throw new TierError('the issuing CA is not trusted, and the setup marks it trusted on a proven local stack only (a shared tier needs the CA trusted beforehand)');
        ctx.log.warn(`marking the issuing root CA ${current} trusted (pre-existing object, local stack only: timestamping-setup.sh step 16)`);
        await ctx.localAdmin.request('PATCH', `/v1/certificates/${current}`, { trustedCa: true });
    } else if (root.trustedCa !== true) {
        // No trustedCa flag: Core does not hold it as a CA, and the PATCH would be refused.
        throw new TierError('the root of the TSA certificate\'s chain carries no trustedCa flag (not a CA certificate in Core)');
    }
    const validation = await ctx.admin.poll(
        () => ctx.admin.get<Json>(`/v1/certificates/${certificate.uuid}/validate`),
        (v) => v?.resultStatus === 'valid' || v?.resultStatus === 'expiring',
        ctx.poll.validationAttempts, ctx.poll.validationIntervalMs, `validation of ${certificate.name}`,
    );
    if (validation?.resultStatus !== 'valid' && validation?.resultStatus !== 'expiring') {
        throw new TierError(`the TSA certificate validates as '${validation?.resultStatus ?? ''}' after ${ctx.poll.validationAttempts} reads (expected valid or expiring)`);
    }
}

/** The earliest event of a certificate's history (the detail has no creation time), or undefined. */
async function creationTime(ctx: SetupContext, uuid: string): Promise<number | undefined> {
    const events = await ctx.admin.get<Array<{ created?: string }>>(`/v1/certificates/${uuid}/history`);
    const times = (events ?? []).map((e) => Date.parse(e.created ?? '')).filter((t) => !Number.isNaN(t));
    return times.length ? Math.min(...times) : undefined;
}

/**
 * The issuer certificates Core added to the inventory while building this run's chains: created (history, server
 * clock) at or after the provisioning start. Recorded as derived lines; one already in the ledger is skipped.
 */
async function recordAddedIssuers(ctx: SetupContext, chain: Json[]): Promise<void> {
    const start = ctx.admin.provisionedAt();
    if (!start) {
        ctx.log.warn('no server time of the provisioning start: issuer certificates Core may have added are not recorded');
        return;
    }
    const createdAfter = createdAfterMarker(start);
    for (const cert of chain) {
        const uuid = String(cert?.uuid ?? '');
        if (!uuid || isOwnObject({ uuid })) continue;
        const created = await creationTime(ctx, uuid);
        if (created === undefined) {
            ctx.log.warn(`issuer certificate ${uuid}: creation time unknown (history empty); not recorded, it stays in the inventory`);
            continue;
        }
        if (created < Date.parse(createdAfter)) continue; // pre-existing: a parent only
        recordDerived('certificates', { uuid, name: String(cert.commonName ?? cert.subjectDn ?? 'issuer certificate') }, {
            spec: SETUP_LEDGER_SPEC, createdAfter, note: 'issuer certificate Core fetched into the inventory while building a TSA chain',
        });
    }
}
