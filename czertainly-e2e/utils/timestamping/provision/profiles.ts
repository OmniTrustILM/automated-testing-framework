/**
 * profiles — the vault profile, time-quality configuration, mapped user and role, and per set the TSP profile, signing profile, link, Basic
 * credential and grants.
 * Each create is recorded right after it answered. The user is password-less and the Basic-credential passwords are generated per run.
 * A `tspProfiles` line cannot name its signing profile (created second); the pair is on the `signingProfiles` line. Basic credentials are
 * deleted with their TSP profile.
 */
import { OwnRef } from '../../regression/ledger/ledger';
import { basicPassword } from '../secrets';
import type { NamedUuid, StoredBasicCredential } from '../types';
import { AttributeDef, signingOperationAttributes } from './attributes';
import { recordOwn, SetupContext, uuidOf } from './context';

type Json = Record<string, any>;

// The default of request validation: SHA-256, SHA-384 and SHA-512.
const ALLOWED_DIGEST_ALGORITHMS = ['SHA-256', 'SHA-384', 'SHA-512'];

const NTP_CHECK_INTERVAL = 'PT0.5S';
const NTP_CHECK_TIMEOUT = 'PT0.3S';
const NTP_SAMPLES_PER_SERVER = 3;
const NTP_SERVERS_MIN_REACHABLE = 1;
const LEAP_SECOND_GUARD = true;

/** On create and on the link's PUT (a PUT replaces the resource). */
const AUTH_METHODS = ['clientCertificate', 'basicPassword'];


export async function createVaultProfile(ctx: SetupContext, vault: NamedUuid, name: string): Promise<OwnRef> {
    const created = await ctx.admin.request('POST', `/v1/vaults/${vault.uuid}/vaultProfiles`, { name, description: '', attributes: [], customAttributes: [] });
    const ref = recordOwn('vaultProfiles', { uuid: uuidOf(created.body, `vault profile '${name}'`), name }, `timestamping vault profile under vault ${vault.name}`, { vault: vault.uuid }, created.serverAt);
    await ctx.admin.request('PATCH', `/v1/vaults/${vault.uuid}/vaultProfiles/${ref.uuid}/enable`);
    return ref;
}


export interface TimeQuality extends OwnRef {
    accuracy: string;
    ntpServers: string[];
    maxClockDrift: string;
}

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
    const b = created.body ?? {};
    return {
        ...ref,
        accuracy: typeof b.accuracy === 'string' ? b.accuracy : c.accuracy,
        ntpServers: Array.isArray(b.ntpServers) ? b.ntpServers.map(String) : c.ntpServers,
        maxClockDrift: typeof b.maxClockDrift === 'string' ? b.maxClockDrift : c.maxClockDrift,
    };
}


export async function createMappedUser(ctx: SetupContext, username: string): Promise<OwnRef> {
    const created = await ctx.admin.request('POST', '/v1/users', {
        username, firstName: 'QA', lastName: 'Timestamping', email: `${username}@example.test`, enabled: true,
    });
    return recordOwn('users', { uuid: uuidOf(created.body, `user '${username}'`), name: username }, 'mapped user of the TSP Basic credentials', undefined, created.serverAt);
}

export async function createRole(ctx: SetupContext, name: string, user: OwnRef): Promise<OwnRef> {
    const created = await ctx.admin.request('POST', '/v1/roles', { name, description: 'TSP timestamping for the mapped user', customAttributes: [] });
    const role = recordOwn('roles', { uuid: uuidOf(created.body, `role '${name}'`), name }, 'timestamping role of the mapped user', undefined, created.serverAt);
    // PUT /v1/users/{uuid}/roles/{roleUuid} declares a JSON body it never reads, so a body-less call gets a 500 (core#2140).
    // The user's roles are replaced, so the whole role list is PATCHed.
    await ctx.admin.request('PATCH', `/v1/users/${user.uuid}/roles`, [role.uuid]);
    return role;
}


export async function createTspProfile(ctx: SetupContext, name: string, vaultProfile: OwnRef): Promise<OwnRef> {
    const created = await ctx.admin.request('POST', '/v1/tspProfiles', { name, vaultProfileUuid: vaultProfile.uuid, allowedAuthenticationMethods: AUTH_METHODS, customAttributes: [] });
    const ref = recordOwn('tspProfiles', { uuid: uuidOf(created.body, `TSP profile '${name}'`), name }, 'timestamping TSP profile', { vaultProfile: vaultProfile.uuid }, created.serverAt);
    await ctx.admin.request('PATCH', `/v1/tspProfiles/${ref.uuid}/enable`);
    return ref;
}


export interface SigningProfileInput {
    name: string;
    certificate: OwnRef;
    token: OwnRef;
    tspProfile: OwnRef;
    policyOid: string;
    timestampFormatting: NamedUuid;
    timeQuality?: OwnRef;
}

export async function createSigningProfile(ctx: SetupContext, input: SigningProfileInput): Promise<OwnRef> {
    const sigDefs = await ctx.admin.get<AttributeDef[]>(`/v1/signingProfiles/certificates/${input.certificate.uuid}/signatureAttributes`);
    const formatting = await ctx.admin.get<Json[]>(`/v1/signingProfiles/signatureFormattingConnectors/${input.timestampFormatting.uuid}/formattingAttributes`);
    const workflow: Json = {
        type: 'timestamping',
        signatureFormattingConnectorUuid: input.timestampFormatting.uuid,
        // A version that already carries the `v` prefix is not prefixed twice.
        signatureFormattingConnectorAttributes: (formatting ?? []).map((d) => ({ ...d, version: `v${String(d.version ?? '').replace(/^v/, '')}` })),
        qualifiedTimestamp: !!input.timeQuality,
        defaultPolicyId: input.policyOid,
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


/** A PUT replaces the resource, so the vault profile and the methods are sent again; then TSP is activated on the signing profile. */
export async function linkProfiles(ctx: SetupContext, tspProfile: OwnRef, signingProfile: OwnRef, vaultProfile: OwnRef): Promise<void> {
    await ctx.admin.request('PUT', `/v1/tspProfiles/${tspProfile.uuid}`, {
        name: tspProfile.name, defaultSigningProfileUuid: signingProfile.uuid, vaultProfileUuid: vaultProfile.uuid, allowedAuthenticationMethods: AUTH_METHODS, customAttributes: [],
    });
    await ctx.admin.request('PATCH', `/v1/signingProfiles/${signingProfile.uuid}/protocols/tsp/activate/${tspProfile.uuid}`);
}

/** The password is derived from the run secret (secrets.ts); the summary keeps the username and the uuid only. */
export async function createBasicCredential(ctx: SetupContext, tspProfile: OwnRef, user: OwnRef): Promise<StoredBasicCredential> {
    const password = basicPassword(tspProfile.uuid, user.name, ctx.env);
    const created = await ctx.admin.request('POST', `/v1/tspProfiles/${tspProfile.uuid}/basicCredentials`, { username: user.name, password, mappedUserUuid: user.uuid });
    return { username: user.name, uuid: uuidOf(created.body, `Basic credential on TSP profile ${tspProfile.name}`) };
}


export interface SetGrant {
    tspProfile: OwnRef;
    signingProfile: OwnRef;
    token: OwnRef;
    tokenProfile: OwnRef;
}

const unique = (xs: string[]): string[] => [...new Set(xs)].sort();
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The merge of this run's sets only, kept in memory. `keys/sign` is
 * granted resource-wide: Auth refuses object-scoped permissions on `keys`.
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

export async function grantPermissions(ctx: SetupContext, role: OwnRef, grants: SetGrant[]): Promise<void> {
    await ctx.admin.request('POST', `/v1/roles/${role.uuid}/permissions`, permissionDocument(grants));
}
