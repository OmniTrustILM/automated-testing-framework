/**
 * profiles — the vault profile, the time-quality configuration, the mapped user and its role, and per set the TSP profile,
 * the signing profile, their link, the Basic credential and the role's grants (timestamping-setup.sh steps 5, 8-10 and 17-21).
 *
 * Each create sends the script's body under a run-prefixed name and is recorded right after it answered. The user is
 * password-less and the Basic-credential passwords are generated per run, so nothing outside the run is read or changed.
 * A `tspProfiles` line cannot name its signing profile (created second); the pair is on the `signingProfiles` line. Basic
 * credentials are not recorded: core deletes them with their TSP profile.
 */
import { OwnRef } from '../../regression/ledger/ledger';
import { basicPassword } from '../secrets';
import type { NamedUuid, StoredBasicCredential } from '../types';
import { AttributeDef, signingOperationAttributes } from './attributes';
import { recordOwn, SetupContext, uuidOf } from './context';

type Json = Record<string, any>;

// The script's request-validation default: SHA-256, SHA-384 and SHA-512 (DigestAlgorithm codes).
const ALLOWED_DIGEST_ALGORITHMS = ['SHA-256', 'SHA-384', 'SHA-512'];

// The time-quality settings timestamping-setup.sh hard-codes as defaults (no TSA_* variable for them).
const NTP_CHECK_INTERVAL = 'PT0.5S';
const NTP_CHECK_TIMEOUT = 'PT0.3S';
const NTP_SAMPLES_PER_SERVER = 3;
const NTP_SERVERS_MIN_REACHABLE = 1;
const LEAP_SECOND_GUARD = true;

/** Both TSP authentication methods, on create and on the link's PUT (a PUT replaces the resource). */
const AUTH_METHODS = ['clientCertificate', 'basicPassword'];

// ------------------------------------------------------------------ step 5: vault profile

/** `setup_vault_profile` (create branch): no data attributes (the credential provider's vault asks for none); enabled. */
export async function createVaultProfile(ctx: SetupContext, vault: NamedUuid, name: string): Promise<OwnRef> {
    const created = await ctx.admin.request('POST', `/v1/vaults/${vault.uuid}/vaultProfiles`, { name, description: '', attributes: [], customAttributes: [] });
    const ref = recordOwn('vaultProfiles', { uuid: uuidOf(created.body, `vault profile '${name}'`), name }, `timestamping vault profile under vault ${vault.name}`, { vault: vault.uuid }, created.serverAt);
    await ctx.admin.request('PATCH', `/v1/vaults/${vault.uuid}/vaultProfiles/${ref.uuid}/enable`);
    return ref;
}

// ------------------------------------------------------------------ step 8: time-quality configuration

export interface TimeQuality extends OwnRef {
    accuracy: string;
    ntpServers: string[];
    maxClockDrift: string;
}

/** `setup_time_quality_config` (create branch): config.ts values plus the script's defaults; the stored settings are reported. */
export async function createTimeQuality(ctx: SetupContext, name: string): Promise<TimeQuality> {
    const c = ctx.cfg;
    const created = await ctx.admin.request<Json>('POST', '/v1/timeQualityConfigurations', {
        name,
        accuracy: c.accuracy,
        ntpServers: c.ntpServers.map((s) => s.trim()),
        ntpCheckInterval: NTP_CHECK_INTERVAL,
        ntpCheckTimeout: NTP_CHECK_TIMEOUT,
        ntpSamplesPerServer: NTP_SAMPLES_PER_SERVER,
        ntpServersMinReachable: NTP_SERVERS_MIN_REACHABLE,
        maxClockDrift: c.maxClockDrift,
        leapSecondGuard: LEAP_SECOND_GUARD,
        customAttributes: [],
    });
    const ref = recordOwn('timeQualityConfigurations', { uuid: uuidOf(created.body, `time-quality configuration '${name}'`), name }, 'time-quality configuration of the qualified sets', undefined, created.serverAt);
    // record_time_quality_settings: the values as the server stored them.
    const b = created.body ?? {};
    return {
        ...ref,
        accuracy: typeof b.accuracy === 'string' ? b.accuracy : c.accuracy,
        ntpServers: Array.isArray(b.ntpServers) ? b.ntpServers.map(String) : c.ntpServers,
        maxClockDrift: typeof b.maxClockDrift === 'string' ? b.maxClockDrift : c.maxClockDrift,
    };
}

// ------------------------------------------------------------------ steps 9–10: mapped user and role

/** `setup_mapped_user` (create branch): a regular user without a certificate and without a password (it never signs in). */
export async function createMappedUser(ctx: SetupContext, username: string): Promise<OwnRef> {
    const created = await ctx.admin.request('POST', '/v1/users', {
        username, firstName: 'QA', lastName: 'Timestamping', email: `${username}@example.test`, enabled: true,
    });
    return recordOwn('users', { uuid: uuidOf(created.body, `user '${username}'`), name: username }, 'mapped user of the TSP Basic credentials', undefined, created.serverAt);
}

/** `setup_timestamping_role` (create branch): the role, attached to the mapped user; its grants come per set (step 21). */
export async function createRole(ctx: SetupContext, name: string, user: OwnRef): Promise<OwnRef> {
    const created = await ctx.admin.request('POST', '/v1/roles', { name, description: 'TSP timestamping for the mapped user', customAttributes: [] });
    const role = recordOwn('roles', { uuid: uuidOf(created.body, `role '${name}'`), name }, 'timestamping role of the mapped user', undefined, created.serverAt);
    // The user's whole role list (only this role): PUT /v1/users/{uuid}/roles/{roleUuid} declares a JSON body it never reads, so a
    // body-less call has no Content-Type and Core answers 500 (core#2140); the authors' suite attaches the role the same way.
    await ctx.admin.request('PATCH', `/v1/users/${user.uuid}/roles`, [role.uuid]);
    return role;
}

// ------------------------------------------------------------------ step 17: TSP profile

/** `setup_tsp_profile` (create branch): client certificate and Basic password, backed by the vault profile; enabled. */
export async function createTspProfile(ctx: SetupContext, name: string, vaultProfile: OwnRef): Promise<OwnRef> {
    const created = await ctx.admin.request('POST', '/v1/tspProfiles', { name, vaultProfileUuid: vaultProfile.uuid, allowedAuthenticationMethods: AUTH_METHODS, customAttributes: [] });
    const ref = recordOwn('tspProfiles', { uuid: uuidOf(created.body, `TSP profile '${name}'`), name }, 'timestamping TSP profile', { vaultProfile: vaultProfile.uuid }, created.serverAt);
    await ctx.admin.request('PATCH', `/v1/tspProfiles/${ref.uuid}/enable`);
    return ref;
}

// ------------------------------------------------------------------ step 18: signing profile

export interface SigningProfileInput {
    name: string;
    certificate: OwnRef;
    token: OwnRef;
    tspProfile: OwnRef;
    policyOid: string;
    timestampFormatting: NamedUuid;
    /** The qualified set: qualifiedTimestamp and this time-quality configuration. */
    timeQuality?: OwnRef;
}

/** `setup_signing_profile`: managed static-key signing with the TSA certificate, a timestamping workflow; enabled. */
export async function createSigningProfile(ctx: SetupContext, input: SigningProfileInput): Promise<OwnRef> {
    const sigDefs = await ctx.admin.get<AttributeDef[]>(`/v1/signingProfiles/certificates/${input.certificate.uuid}/signatureAttributes`);
    const formatting = await ctx.admin.get<Json[]>(`/v1/signingProfiles/signatureFormattingConnectors/${input.timestampFormatting.uuid}/formattingAttributes`);
    const workflow: Json = {
        type: 'timestamping',
        signatureFormattingConnectorUuid: input.timestampFormatting.uuid,
        // The script sends the formatter's definitions back with a `v`-prefixed version (`"v" + (.version | tostring)`);
        // a version that already carries the prefix is not prefixed twice.
        signatureFormattingConnectorAttributes: (formatting ?? []).map((d) => ({ ...d, version: `v${String(d.version ?? '').replace(/^v/, '')}` })),
        qualifiedTimestamp: !!input.timeQuality,
        defaultPolicyId: input.policyOid,
        // No --allowed-policy-ids: the set's own policy OID only.
        allowedPolicyIds: [input.policyOid],
        allowedDigestAlgorithms: ALLOWED_DIGEST_ALGORITHMS,
        ...(input.timeQuality ? { timeQualityConfigurationUuid: input.timeQuality.uuid } : {}),
    };
    const created = await ctx.admin.request('POST', '/v1/signingProfiles', {
        name: input.name,
        workflow,
        signingScheme: {
            signingScheme: 'managed',
            managedSigningType: 'static_key',
            certificateUuid: input.certificate.uuid,
            signingOperationAttributes: signingOperationAttributes(sigDefs, ctx.cfg.signatureScheme, ctx.cfg.signatureDigest),
        },
        customAttributes: [],
    });
    const parents: Record<string, string> = { tspProfile: input.tspProfile.uuid, certificate: input.certificate.uuid, token: input.token.uuid };
    if (input.timeQuality) parents.timeQualityConfiguration = input.timeQuality.uuid;
    const ref = recordOwn('signingProfiles', { uuid: uuidOf(created.body, `signing profile '${input.name}'`), name: input.name },
        `timestamping signing profile (${input.timeQuality ? 'qualified' : 'non-qualified'})`, parents, created.serverAt);
    await ctx.admin.request('PATCH', `/v1/signingProfiles/${ref.uuid}/enable`);
    return ref;
}

// ------------------------------------------------------------------ steps 19–20: link and Basic credential

/**
 * `link_tsp_signing_profile`: the TSP profile's default signing profile (a PUT replaces the resource: the vault profile
 * and the methods are sent again), then the TSP protocol activated on the signing profile for that TSP profile.
 */
export async function linkProfiles(ctx: SetupContext, tspProfile: OwnRef, signingProfile: OwnRef, vaultProfile: OwnRef): Promise<void> {
    await ctx.admin.request('PUT', `/v1/tspProfiles/${tspProfile.uuid}`, {
        name: tspProfile.name, defaultSigningProfileUuid: signingProfile.uuid, vaultProfileUuid: vaultProfile.uuid, allowedAuthenticationMethods: AUTH_METHODS, customAttributes: [],
    });
    await ctx.admin.request('PATCH', `/v1/signingProfiles/${signingProfile.uuid}/protocols/tsp/activate/${tspProfile.uuid}`);
}

/**
 * `setup_tsp_basic_credential` (create branch): the mapped user's username with a password derived from the run secret (secrets.ts); the
 * summary keeps the username and the uuid only.
 */
export async function createBasicCredential(ctx: SetupContext, tspProfile: OwnRef, user: OwnRef): Promise<StoredBasicCredential> {
    const password = basicPassword(tspProfile.uuid, user.name, ctx.env);
    const created = await ctx.admin.request('POST', `/v1/tspProfiles/${tspProfile.uuid}/basicCredentials`, { username: user.name, password, mappedUserUuid: user.uuid });
    return { username: user.name, uuid: uuidOf(created.body, `Basic credential on TSP profile ${tspProfile.name}`) };
}

// ------------------------------------------------------------------ step 21: object-scoped grants

export interface SetGrant {
    tspProfile: OwnRef;
    signingProfile: OwnRef;
    token: OwnRef;
    tokenProfile: OwnRef;
}

const unique = (xs: string[]): string[] => [...new Set(xs)].sort();
/** Code-point order, as jq's sort and group_by use. */
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `timestamping_permissions` of every completed set, merged like `merge_permissions` (resources and objects grouped and
 * sorted as jq's group_by does, allows de-duplicated). `keys/sign` is granted resource-wide: Auth refuses object-scoped
 * permissions on `keys`. savePermissions replaces the whole set, and the role is the run's own: the merge is of this
 * run's sets only, kept in memory.
 */
export function permissionDocument(grants: SetGrant[]): Json {
    const objects = new Map<string, Map<string, { uuid: string; name: string; allow: string[] }>>();
    const add = (resource: string, ref: OwnRef, allow: string[]): void => {
        const byUuid = objects.get(resource) ?? new Map();
        const prior = byUuid.get(ref.uuid);
        byUuid.set(ref.uuid, { uuid: ref.uuid, name: prior?.name ?? ref.name, allow: unique([...(prior?.allow ?? []), ...allow]) });
        objects.set(resource, byUuid);
    };
    for (const g of grants) {
        add('tspProfiles', g.tspProfile, ['timestamp', 'detail']);
        add('signingProfiles', g.signingProfile, ['detail']);
        add('tokens', g.token, ['detail']);
        add('tokenProfiles', g.tokenProfile, ['detail']);
    }
    const resources = [
        ...[...objects].map(([name, byUuid]) => ({
            name, allowAllActions: false, actions: [] as string[],
            objects: [...byUuid.values()].sort((a, b) => byCodePoint(a.uuid, b.uuid)).map((o) => ({ ...o, deny: [] as string[] })),
        })),
        ...(grants.length ? [{ name: 'keys', allowAllActions: false, actions: ['sign'], objects: [] }] : []),
    ].sort((a, b) => byCodePoint(a.name, b.name));
    return { allowAllResources: false, resources };
}

/** `grant_timestamping_permissions`: the merged document of every completed set, saved on the run's role. */
export async function grantPermissions(ctx: SetupContext, role: OwnRef, grants: SetGrant[]): Promise<void> {
    await ctx.admin.request('POST', `/v1/roles/${role.uuid}/permissions`, permissionDocument(grants));
}
