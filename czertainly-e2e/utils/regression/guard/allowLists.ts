import { isCanonicalUuid, UUID } from './uuids';
import { SEG } from './urls';

/** POST paths (after /api) that CREATE an object. `{id}` = any canonical uuid (a scope parent, never checked). Body checked. */
export const POST_CREATE: readonly string[] = [
    '/v1/roles', '/v1/groups', '/v1/users', '/v1/credentials', '/v1/authorities', '/v1/authorities/{id}/raProfiles',
    '/v1/acmeProfiles', '/v1/scepProfiles', '/v1/cmpProfiles', '/v1/tokens', '/v1/tokens/{id}/tokenProfiles',
    '/v1/tokens/{id}/tokenProfiles/{id}/keys/[A-Za-z]+', '/v1/discoveries', '/v1/attributes/custom',
    '/v1/notificationInstances', '/v1/notificationProfiles',
    '/v1/workflows/(triggers|rules|conditions|actions|executions)', '/v1/entities', '/v1/entities/{id}/locations',
    '/v1/vaults', '/v1/vaults/{id}/vaultProfiles', '/v1/vaults/{id}/vaultProfiles/{id}/secrets', '/v1/complianceProfiles',
    '/v1/approvalProfiles', '/v1/connectors', '/v1/certificates/upload', '/v1/certificates/upload/async',
    '/v2/operations/authorities/{id}/raProfiles/{id}/certificates',
    // Without a canonical objectUuid an event-trigger association is platform-level.
    '/v1/workflows/events',
    // With a `tokenProfileUuid` core records an answer on that profile, so the field is judged as a typed body field.
    '/v1/inspections',
    // A `keyDestination` is refused by its CREATE_BODY_SHAPES rule.
    '/v1/certificates/import',
    '/v2/operations/authorities/{id}/raProfiles/{id}/certificates/register',
    // The v2 admin create of a connector; approve / reconnect / connect / register stay on PLATFORM_DENY.
    '/v2/connectors',
    // `internalRules` / `groups` stay probes-only.
    '/v2/complianceProfiles',
    '/v1/timeQualityConfigurations', '/v1/tspProfiles', '/v1/signingProfiles',
];

/**
 * POST paths that only READ: lists, searches and attribute validations. `{seg}` = one unreserved segment, never `.` / `..`. A certificate's
 * own `/validate` is a mutation.
 */
export const POST_READ: readonly string[] = [
    '/v1/certificates', '/v1/keys', '/v1/discoveries/list', '/v1/entities/list', '/v1/locations', '/v1/secrets',
    '/v1/vaults/list', '/v1/vaultProfiles/list', '/v1/auditLogs', '/v1/oids/list', '/v1/users/identify',
    '/v1/certificates/content', '/v1/workflows/events/{seg}/history', '/v1/workflows/events/{seg}/{seg}/{id}/history',
    '/v1/({seg}/)*attributes(/{seg})?/validate', '/v1/connectors/{id}/{seg}/{seg}/validate',
    // Deleting signing records stays a bulk route with no ledger type.
    '/v2/connectors/list', '/v1/signingProfiles/list', '/v1/tspProfiles/list', '/v1/timeQualityConfigurations/list', '/v1/signingRecords',
    '/v1/signingProfiles/{id}/signingRecords',
];

/** Client protocol traffic (ACME / SCEP / CMP endpoints): authenticated by the protocol, bodies are protocol messages. */
export const POST_PROTOCOL: readonly string[] = ['/v[12]/protocols(/{seg})+'];


/**
 * Attribute callbacks of the timestamping setup forms. Not plain reads: each writes an audit row; the body is judged like a create's
 * (core expands credentials named in it) and the path id must be a preflight-discovered target or an own token profile.
 */
export const POST_CALLBACK: readonly string[] = ['/v1/raProfiles/{id}/callback', '/v1/keys/{id}/callback', '/v2/connectors/{id}/callback'];

/** What the id in a callback's path must be. */
export type CallbackParent = 'authority' | 'connector' | 'tokenProfile';

const CALLBACK_PARENTS: ReadonlyArray<[RegExp, CallbackParent]> = [
    [new RegExp(`^/v1/raProfiles/(${UUID})/callback$`), 'authority'],
    [new RegExp(`^/v1/keys/(${UUID})/callback$`), 'tokenProfile'],
    [new RegExp(`^/v2/connectors/(${UUID})/callback$`), 'connector'],
];

/** The parent a callback path names (kind and lower-cased uuid), or undefined for any other path. */
export function callbackParentOf(apiPath: string): { kind: CallbackParent; uuid: string } | undefined {
    for (const [re, kind] of CALLBACK_PARENTS) {
        const m = re.exec(apiPath);
        if (m) return { kind, uuid: m[1].toLowerCase() };
    }
    return undefined;
}

export type PostRouteKind = 'create' | 'read' | 'protocol' | 'callback';

const compile = (list: readonly string[]) => list.map((p) => new RegExp(`^${p.replace(/\{id\}/g, UUID).replace(/\{seg\}/g, SEG)}$`));
const POST_KINDS: Array<[PostRouteKind, RegExp[]]> = [['protocol', compile(POST_PROTOCOL)], ['read', compile(POST_READ)], ['callback', compile(POST_CALLBACK)], ['create', compile(POST_CREATE)]];

/** Which allow-listed POST an API path is, or undefined (a POST elsewhere is a mutation). */
export function postRouteKind(apiPath: string): PostRouteKind | undefined {
    return POST_KINDS.find(([, res]) => res.some((re) => re.test(apiPath)))?.[0];
}

export function isAllowedPostRoute(apiPath: string): boolean {
    return postRouteKind(apiPath) !== undefined;
}

/** A POST a RAW context may send (lint and `allowedRawPost`): a read-only or protocol path; a create needs the guard. */
export function isRawPostRouteAllowed(apiPath: string): boolean {
    const kind = postRouteKind(apiPath);
    return kind === 'read' || kind === 'protocol';
}

/**
 * Top-level body fields that may name a pre-existing object on an own create / update (never on a DELETE); the value
 * must be a canonical uuid string. Default deny: every other uuid must be own.
 * `tokenProfileUuid` / `altTokenProfileUuid` stay out: the key would be generated inside a foreign token.
 * `keyUuid`, group, owner, certificate, workflow and similar fields stay out: they bind, sign with, notify or rewire a pre-existing object.
 */
export const REFERENCE_FIELDS: Readonly<Record<string, string>> = {
    connectorUuid: 'the connector (provider) of an own object; referenced, never changed',
    interfaceUuid: 'the connector function-group interface: a capability id, not an inventory object',
    raProfileUuid: 'the RA profile an own protocol profile / certificate issues through; the RA profile is not changed',
};

const objectLevel = (body: unknown): boolean =>
    !!body && typeof body === 'object' && !Array.isArray(body) && isCanonicalUuid((body as { objectUuid?: unknown }).objectUuid);

const END = '(?:[/.]|$)';
const deny = (body: string): RegExp => new RegExp(`^/v[12]/${body}${END}`, 'i');
const denyExact = (body: string): RegExp => new RegExp(`^/v[12]/${body}(?:\\.|$)`, 'i');

/**
 * Platform-level endpoints, v1 and v2, case-insensitive (`purge.json` is
 * the same endpoint): refused unless `localStack` on a proven local stack.
 */
export const PLATFORM_DENY: ReadonlyArray<{ path: RegExp; why: string; when?: (body: unknown) => boolean }> = [
    { path: deny('settings'), why: 'platform settings' },
    { path: deny('scheduler'), why: 'scheduled jobs of the platform' },
    { path: denyExact('auth/profile'), why: 'the profile of the logged-in (pre-existing) user' },
    {
        path: denyExact('workflows/events'),
        why: 'a platform-level event trigger association (no canonical objectUuid: it fires for every object)',
        when: (body) => !objectLevel(body),
    },
    { path: deny('trustedCertificates'), why: 'the platform\'s trusted certificates' },
    { path: deny('proxies'), why: 'connector proxies' },
    { path: deny('attributes/metadata'), why: 'global metadata definitions' },
    { path: deny('cboms'), why: 'the CBOM repository (upload, delete, sync)' },
    { path: denyExact(`connectors/(?:approve|reconnect|connect|${UUID}/(?:approve|reconnect))`), why: 'connector approve / reconnect / connect' },
    { path: denyExact('connector/register'), why: 'connector registration' },
    { path: deny('branding'), why: 'platform branding' },
    { path: deny('local'), why: 'local administrator management' },
    { path: denyExact('auditLogs/purge'), why: 'the platform audit log (purge)' },
    { path: deny('oids'), why: 'the platform OID registry' },
    { path: denyExact('discoveries/schedule'), why: 'a scheduled (platform-level) discovery job' },
    // The legacy client API names RA profiles by NAME; the uuid-keyed `tokens` / `authorities` routes stay.
    { path: new RegExp(`^/v[12]/operations/(?!(?:tokens|authorities)/)[^/]+${END}`, 'i'), why: 'the legacy name-keyed client API (/v1/operations/{raProfileName}/…)' },
];

export function platformDenied(apiPath: string, body?: unknown): string | undefined {
    return PLATFORM_DENY.find((d) => d.path.test(apiPath) && (!d.when || d.when(body)))?.why;
}
