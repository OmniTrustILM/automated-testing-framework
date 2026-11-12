/**
 * preflight — does this tier have what the timestamping block builds on? Read-only.
 *
 * WHAT: `offlineBlocker` decides without a single request (a cryptography provider this tier kind cannot provision); `discoverParents`
 * finds the connectors, the authority instance and the vault instance (it is also what the `timestamping` need reads, see
 * ../need.ts); `preflight` then finds, by function group, interface
 * and name, every pre-existing parent of the block: the credential-provider v1 connector (SoftKeyStore), the EJBCA
 * authority-provider connector, the TSA_CRYPTO_PROVIDER cryptography connector, the timestamp-formatting connector (v2),
 * the vault connector (credential-provider v2, `secret` interface), the EJBCA authority instance TSA_AUTHORITY_NAME, the
 * vault instance TSA_VAULT_INSTANCE_NAME, and the EJBCA end-entity profile, certificate profiles and CA of every planned
 * family (resolved through the RA-profile attribute callbacks, as timestamping-setup.sh step 13 does).
 * WHY: timestamping-setup.sh created or approved what it missed; the block never does (create-only, design rule 1): a
 * missing or unapproved parent is a precise reason, the specs skip with it. A family whose CA is missing goes to
 * `missingFamilies` and the others still run.
 * HOW: the bash script's discovery filters on `GET /v1/connectors` (function groups) and `POST /v2/connectors/list`
 * (interfaces); the software v2 provider is picked by interface (`cryptography`) where the script matched its
 * host:port, which the block has no variables for. Every request goes through `Admin` (guarded); a TierError of any read
 * becomes the `unavailable` reason (a SetupError propagates). A reason names what the run asked for (configured names,
 * connector roles, statuses); the tier's own lists and connector names go to the log only.
 */
import { hasLocalProof } from '../../regression/tier/localProof';
import { isLocalTier } from '../../regression/tier/kind';
import type { PlannedFamily, TimestampingConfig } from '../config';
import type { NamedUuid } from '../types';
import { AttributeDef, attrUuid } from './attributes';
import { Logger } from '../../Logger';
import { registerCallbackTarget } from '../../regression/guard/callbackTargets';
import type { GuardedApi } from '../../regression/guard/types';
import { Admin, TierError } from './transport';

type Json = Record<string, any>;

const logger = new Logger('TimestampingSetup');

export interface CryptoConnectorRef extends NamedUuid {
    version: 1 | 2;
}

/** An EJBCA profile or CA as the RA-profile callbacks offer it (`data: { id, name }`). */
export interface EjbcaOption {
    id: unknown;
    name: string;
}

/** Everything step 13 needs for the RA profiles of one family, resolved once. */
export interface RaPlan {
    attrUuids: {
        endEntityProfile: string;
        certificateProfile: string;
        certificationAuthority: string;
        sendNotifications: string;
        keyRecoverable: string;
        usernameGenMethod: string;
    };
    endEntityProfile: EjbcaOption;
    certificateProfile: { nonQualified: EjbcaOption; qualified: EjbcaOption };
    ca: EjbcaOption;
}

export interface Prerequisites {
    /** Host of the connectors as the platform reaches them (summary `connectorHost`). */
    connectorHost: string;
    connectors: {
        credentialProvider: NamedUuid;
        ejbca: NamedUuid;
        crypto: CryptoConnectorRef;
        timestampFormatting: NamedUuid;
        vault: NamedUuid;
    };
    authority: NamedUuid;
    /** The SoftKeyStore credential the authority signs in with (read from the authority; reported only). */
    credential: NamedUuid;
    vaultInstance: NamedUuid;
    /** Keyed by family name: only the families the authority can issue. */
    raPlans: Record<string, RaPlan>;
}

export type PreflightResult =
    | { status: 'ok'; prerequisites: Prerequisites; missingFamilies: Record<string, string> }
    | { status: 'unavailable'; reason: string };

/** Why the block cannot run here, decided without a request; undefined when the preflight may start reading. */
export function offlineBlocker(cfg: TimestampingConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (cfg.cryptoProvider === 'pkcs11') {
        return 'TSA_CRYPTO_PROVIDER=pkcs11 is not provisioned by the TypeScript setup yet (its token needs a PIN secret and a PKCS#11 profile / token label the block has no variables for); use software-v1 or software-v2';
    }
    // The v1 software provider's token form is a callback on `/v1/connectors/{id}/cryptographyProvider/SOFT/callback`: it names the connector
    // KIND, a name-keyed path the guard refuses (rule 6a) unless `localStack` on a proven local stack.
    if (cfg.cryptoProvider === 'software-v1' && !(isLocalTier(env) && hasLocalProof(env))) {
        return 'TSA_CRYPTO_PROVIDER=software-v1 is provisioned on a proven local stack only (its token form is a name-keyed callback path the guard refuses elsewhere); use software-v2';
    }
    return undefined;
}

const functionGroup = (row: Json, code: string, kind: string): boolean =>
    ((row.functionGroups ?? []) as Json[]).some((g) => g.functionGroupCode === code && ((g.kinds ?? []) as string[]).includes(kind));

const hasInterface = (row: Json, code: string, feature?: string): boolean =>
    ((row.interfaces ?? []) as Json[]).some((i) => i.code === code && (!feature || ((i.features ?? []) as string[]).includes(feature)));

/**
 * The connected connector among `candidates`; a candidate that is registered but not connected is the reason (a
 * `waitingForApproval` one is never approved by the setup), none at all is the other one.
 */
function pickConnector(candidates: Json[], what: string): NamedUuid | string {
    const connected = candidates.find((c) => c.status === 'connected');
    if (connected) return { name: String(connected.name ?? ''), uuid: String(connected.uuid) };
    if (!candidates.length) return `no ${what} connector is registered`;
    const first = candidates[0];
    logger.warn(`the ${what} connector is '${first.name}' (${first.uuid}), status ${first.status}`);
    if (first.status === 'waitingForApproval') {
        return `the ${what} connector is waiting for approval (the setup never approves a connector; approve it in the platform and re-run)`;
    }
    return `the ${what} connector is ${first.status ?? 'in an unknown state'}, not connected`;
}

const hostOf = (url: unknown): string => {
    try {
        return typeof url === 'string' ? new URL(url).hostname : '';
    } catch {
        return '';
    }
};

const optionNamed = (options: Json[], name: string): EjbcaOption | undefined => {
    const hit = options.find((o) => o?.data?.name === name);
    return hit ? { id: hit.data.id, name } : undefined;
};

/** Logs what the authority offers; a reason only points at the log. */
const offered = (what: string, options: Json[]): string => {
    logger.warn(`the authority offers these ${what}: ${options.map((o) => String(o?.data?.name)).join(', ') || 'none'}`);
    return 'the offered ones are in the setup log';
};

/** The pre-existing parents the block reads: connectors, the authority instance and the vault instance (no CA or profile lookups). */
export type ParentsResult =
    | { status: 'ok'; connectors: Prerequisites['connectors']; authority: NamedUuid; credential: NamedUuid; vaultInstance: NamedUuid; connectorHost: string }
    | { status: 'unavailable'; reason: string };

/**
 * Steps 1, 3 and 4 of the script, read-only: the connected connectors by function group, interface and feature, the authority instance
 * named by TSA_AUTHORITY_NAME and the vault instance named by TSA_VAULT_INSTANCE_NAME. A TierError of a read propagates (the callers turn
 * it into their reason); a SetupError (a refused identity) always does.
 */
export async function discoverParents(admin: Admin, cfg: TimestampingConfig): Promise<ParentsResult> {
    const unavailable = (reason: string): ParentsResult => ({ status: 'unavailable', reason });
    // Step 1 of the script: v1 connectors by function group + kind, v2 connectors by interface (and feature).
    const v1 = await admin.get<Json[]>('/v1/connectors');
    const v2 = await admin.listItems<Json>('/v2/connectors/list');
    const v2Version = new Map(v2.map((c) => [String(c.uuid), String(c.version ?? '')]));

    const credentialProvider = pickConnector(v1.filter((c) => functionGroup(c, 'credentialProvider', 'SoftKeyStore')), 'credential-provider (SoftKeyStore)');
    if (typeof credentialProvider === 'string') return unavailable(credentialProvider);
    const ejbca = pickConnector(v1.filter((c) => functionGroup(c, 'authorityProvider', 'EJBCA')), 'authority-provider (EJBCA)');
    if (typeof ejbca === 'string') return unavailable(ejbca);

    let crypto: CryptoConnectorRef;
    if (cfg.cryptoProvider === 'software-v1') {
        const picked = pickConnector(v1.filter((c) => functionGroup(c, 'cryptographyProvider', 'SOFT') && v2Version.get(String(c.uuid)) !== 'v2'), 'cryptography-provider v1 (SOFT)');
        if (typeof picked === 'string') return unavailable(picked);
        crypto = { ...picked, version: 1 };
    } else {
        // The script matched http://<connector host>:<port> + v2; the block picks the software provider by interface.
        const picked = pickConnector(
            v2.filter((c) => c.version === 'v2' && hasInterface(c, 'cryptography') && !/pkcs11/i.test(`${c.name} ${c.url}`)),
            'cryptography-provider v2 (software)',
        );
        if (typeof picked === 'string') return unavailable(picked);
        crypto = { ...picked, version: 2 };
    }
    const timestampFormatting = pickConnector(v2.filter((c) => hasInterface(c, 'signatureFormatting', 'timestamping')), 'timestamp-formatting (signatureFormatting / timestamping)');
    if (typeof timestampFormatting === 'string') return unavailable(timestampFormatting);

    // Step 3: the EJBCA authority instance, by name (a parent only).
    const authorities = await admin.get<Json[]>('/v1/authorities');
    const authorityRow = authorities.find((a) => a.name === cfg.authorityName);
    if (!authorityRow) return unavailable('no authority instance has the name TSA_AUTHORITY_NAME gives; the setup never creates one');
    const authority: NamedUuid = { name: cfg.authorityName, uuid: String(authorityRow.uuid) };
    const credential = await authorityCredential(admin, authorityRow);

    // Step 4: the vault instance, by name; its connector is the vault connector of the summary.
    const vaults = await admin.listItems<Json>('/v1/vaults/list');
    const vaultRow = vaults.find((v) => v.name === cfg.vaultInstanceName);
    if (!vaultRow) return unavailable('no vault instance has the name TSA_VAULT_INSTANCE_NAME gives; the setup never creates one');
    const vaultInstance: NamedUuid = { name: cfg.vaultInstanceName, uuid: String(vaultRow.uuid) };
    const vaultConnectorUuid = vaultRow.connector?.uuid ?? vaultRow.connectorUuid;
    const secretConnectors = v2.filter((c) => hasInterface(c, 'secret') && (!vaultConnectorUuid || String(c.uuid) === String(vaultConnectorUuid)));
    const vault = pickConnector(secretConnectors, `vault (credential-provider v2, secret interface${vaultConnectorUuid ? ', of the vault instance TSA_VAULT_INSTANCE_NAME names' : ''})`);
    if (typeof vault === 'string') return unavailable(vault);

    const v1Credential = v1.find((c) => String(c.uuid) === credentialProvider.uuid);
    const connectorHost = hostOf(v1Credential?.url) || hostOf(v2.find((c) => String(c.uuid) === credentialProvider.uuid)?.url);
    return { status: 'ok', connectors: { credentialProvider, ejbca, crypto, timestampFormatting, vault }, authority, credential, vaultInstance, connectorHost };
}

/** The read-only preflight; see the file header. */
export async function preflight(admin: Admin, cfg: TimestampingConfig, env: NodeJS.ProcessEnv, api: GuardedApi): Promise<PreflightResult> {
    const blocked = offlineBlocker(cfg, env);
    if (blocked) return { status: 'unavailable', reason: blocked };
    const unavailable = (reason: string): PreflightResult => ({ status: 'unavailable', reason });
    try {
        const parents = await discoverParents(admin, cfg);
        if (parents.status === 'unavailable') return unavailable(parents.reason);
        // The only pre-existing objects an attribute callback of this setup may name: what was just discovered (the guard's POST_CALLBACK rule).
        // A tier without the components never gets here: no callback is sent before the connectors, the authority and the vault are found.
        registerCallbackTarget(api, 'authority', parents.authority.uuid);
        registerCallbackTarget(api, 'connector', parents.connectors.crypto.uuid);
        // Step 13's resolution, once for every planned family.
        const ra = await raPlans(admin, parents.authority, cfg);
        if ('reason' in ra) return unavailable(ra.reason);
        return {
            status: 'ok',
            prerequisites: {
                connectorHost: parents.connectorHost,
                connectors: parents.connectors,
                authority: parents.authority,
                credential: parents.credential,
                vaultInstance: parents.vaultInstance,
                raPlans: ra.plans,
            },
            missingFamilies: ra.missingFamilies,
        };
    } catch (e) {
        if (e instanceof TierError) return unavailable(`preflight: ${e.message}`);
        throw e;
    }
}

/** The authority's `credential` attribute (`{ uuid, name }`), from the list row or else its detail; reported only. */
async function authorityCredential(admin: Admin, row: Json): Promise<NamedUuid> {
    const read = (attrs: unknown): NamedUuid | undefined => {
        const attr = ((attrs ?? []) as Json[]).find((a) => a.name === 'credential');
        const data = attr?.content?.[0]?.data;
        return data?.uuid ? { name: String(data.name ?? ''), uuid: String(data.uuid) } : undefined;
    };
    return read(row.attributes) ?? read((await admin.get<Json>(`/v1/authorities/${row.uuid}`)).attributes) ?? { name: '', uuid: '' };
}

/**
 * `setup_ra_profile`'s lookups: the RA-profile attribute definitions of the authority, the EJBCA end-entity profile by
 * name, the two certificate profiles and every family's CA through the authority's callbacks. A missing profile stops the
 * block; a missing CA stops only its family (the RSA family is required by the plan, so its CA stops the block).
 */
async function raPlans(admin: Admin, authority: NamedUuid, cfg: TimestampingConfig): Promise<{ plans: Record<string, RaPlan>; missingFamilies: Record<string, string> } | { reason: string }> {
    // Reasons name the variable, not the value: they end up in reports (the names are in the log).
    const where = 'the authority TSA_AUTHORITY_NAME names';
    const defs = await admin.get<AttributeDef[]>(`/v1/authorities/${authority.uuid}/attributes/raProfile`);
    let attrUuids: RaPlan['attrUuids'];
    try {
        attrUuids = {
            endEntityProfile: attrUuid(defs, 'endEntityProfile', 'object'),
            certificateProfile: attrUuid(defs, 'certificateProfile', 'object'),
            certificationAuthority: attrUuid(defs, 'certificationAuthority', 'object'),
            sendNotifications: attrUuid(defs, 'sendNotifications', 'boolean'),
            keyRecoverable: attrUuid(defs, 'keyRecoverable', 'boolean'),
            usernameGenMethod: attrUuid(defs, 'usernameGenMethod', 'string'),
        };
    } catch (e) {
        if (e instanceof TierError) return { reason: `${where} is not an EJBCA authority the setup can use: ${e.message}` };
        throw e;
    }
    // The EJBCA-internal authority id is a static mapping value of the CA attribute's callback.
    const caDef = defs.find((d) => d.name === 'certificationAuthority');
    const authorityId = caDef?.attributeCallback?.mappings?.find((m) => m.to === 'authorityId' && m.value !== undefined)?.value;
    if (authorityId === undefined) return { reason: `${where}: the certificationAuthority attribute carries no authorityId callback mapping` };

    const eeOptions = (defs.find((d) => d.name === 'endEntityProfile')?.content ?? []) as Json[];
    const endEntityProfile = optionNamed(eeOptions, cfg.ejbcaEndEntityProfile);
    if (!endEntityProfile) return { reason: `${where} offers no EJBCA end-entity profile named by TSA_EJBCA_EE_PROFILE (${offered('end-entity profiles', eeOptions)})` };

    const callback = (attr: string, name: string) => admin.request<Json[]>('POST', `/v1/raProfiles/${authority.uuid}/callback`, {
        uuid: attr,
        name,
        pathVariable: { endEntityProfileId: endEntityProfile.id, authorityId },
        requestParameter: {},
        body: {},
        filter: {},
    }).then((a) => a.body ?? []);
    const certificateProfiles = await callback(attrUuids.certificateProfile, 'certificateProfile');
    const nonQualified = optionNamed(certificateProfiles, cfg.ejbcaCertificateProfile);
    if (!nonQualified) return { reason: `${where} offers no EJBCA certificate profile named by TSA_EJBCA_CERT_PROFILE (${offered('certificate profiles', certificateProfiles)})` };
    const qualified = optionNamed(certificateProfiles, cfg.ejbcaCertificateProfileQualified);
    if (!qualified) return { reason: `${where} offers no EJBCA certificate profile named by TSA_EJBCA_CERT_PROFILE_QUALIFIED (${offered('certificate profiles', certificateProfiles)})` };

    const cas = await callback(attrUuids.certificationAuthority, 'certificationAuthority');
    const plans: Record<string, RaPlan> = {};
    const missingFamilies: Record<string, string> = {};
    for (const family of cfg.families) {
        const ca = optionNamed(cas, family.ejbcaCa);
        if (ca) {
            plans[family.name] = { attrUuids, endEntityProfile, certificateProfile: { nonQualified, qualified }, ca };
            continue;
        }
        const why = `${where} offers no EJBCA CA named by ${caVariable(family)} (${offered('CAs', cas)})`;
        if (family.name === 'rsa') return { reason: why };
        missingFamilies[family.name] = why;
    }
    return { plans, missingFamilies };
}

const caVariable = (family: PlannedFamily): string => (family.name === 'rsa' ? 'TSA_EJBCA_CA' : 'TSA_MLDSA_EJBCA_CA');
