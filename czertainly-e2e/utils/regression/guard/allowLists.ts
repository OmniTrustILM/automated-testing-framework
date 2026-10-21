import { isCanonicalUuid, UUID } from './uuids';
import { SEG } from './urls';

// ------------------------------------------------------------------ POST allow-list

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
    // An event-trigger association of an object (`eventAssociations` ledger type): its body names the
    // object (`objectUuid`, own) and the triggers (own); without a canonical objectUuid it is platform-level (PLATFORM_DENY).
    '/v1/workflows/events',
    // Body-judged creates of four areas (inventory, certificate lifecycle, platform):
    // `POST /v1/inspections` — class "body-judged, creates nothing". NOT a read: with a
    // `tokenProfileUuid` core resolves the profile and records the connector's import-capability answer on that profile
    // row (KeyTransferCapabilityService.java:139-156 → KeyTransferCapabilityWriter.java:50-64), so the field is judged
    // as a typed body field (guard/routes.ts BODY_FIELD_TYPES → tokenProfiles: own or a probe); without it, or with a plain
    // non-uuid string, nothing is persisted but the audit record (FileInspectionServiceImpl.java:51-53, :76-101;
    // ContainerReader.java:9-23; InspectionControllerImpl.java:27-39). A raw context may still not POST it.
    '/v1/inspections',
    // `POST /v1/certificates/import`, certificate-only entries (CREATE_BODY_SHAPES): a
    // certificate entry goes through the same upload as `/v1/certificates/upload` and one already in the inventory is
    // left as it is (`EXISTING`, no write: CertificateImportServiceImpl.java:385-406); a `keyDestination` (the key
    // import, which writes into a token profile) is refused by the shape rule before anything is sent.
    '/v1/certificates/import',
    // Certificate lifecycle: a platform-level pre-registration CREATES a certificate placeholder (core
    // ClientOperationServiceImpl.registerCertificate, service/v2/impl/ClientOperationServiceImpl.java:620-700: a new
    // REQUESTED → PENDING_REGISTRATION → REGISTERED row under the path RA profile; with a secret, a new
    // CertificateRegistrationAuthorization row, :1046-1062; nothing on a pre-existing object). Body judged like every
    // create: `sourceCertificateUuid` → certificates, `ownerUuid` → users, `groupUuids` → groups must be own.
    '/v2/operations/authorities/{id}/raProfiles/{id}/certificates/register',
    // Platform: the v2 ADMIN create of a connector (interfaces v2/ConnectorController.java:105; core
    // v2/ConnectorServiceImpl.java:319-322 `createNewConnector(request, CONNECTED)`): the same DTO family as
    // `/v1/connectors` (name, url, authType, attributes; `proxyUuid` stays probes-only). Approve / reconnect / connect
    // and `connector/register` stay on PLATFORM_DENY.
    '/v2/connectors',
    // Platform: the v2 create of a compliance profile (interfaces v2/ComplianceProfileController.java:75;
    // core service/v2/impl/ComplianceProfileServiceImpl.java:165 createComplianceProfile: a new profile row with its own
    // rule / group association rows; the referenced provider rules are read, never written). `internalRules` / `groups`
    // stay probes-only typed fields, `connectorUuid` a reference; the v1 create was allow-listed already.
    '/v2/complianceProfiles',
    // A saved view of the run's own user (`savedViews` ledger type; interfaces ListViewController.java:55-56,
    // core ListViewServiceImpl.java:124-147: one row of the caller, nothing on another user's views). Its body is held to
    // the saved-view shape (guard/savedViews.ts); `defaultView: true` only while no pre-existing view is a default.
    '/v1/listViews',
];

/**
 * POST paths that only READ: lists, searches, and attribute validations (`…/attributes/validate`,
 * `…/attributes/<kind>/validate`, a connector's `/{functionGroup}/{kind}/validate`; a certificate's own
 * `/certificates/{uuid}/validate` re-runs its validation and is a mutation). `{seg}` = one unreserved segment, never
 * `.` / `..`.
 */
export const POST_READ: readonly string[] = [
    '/v1/certificates', '/v1/keys', '/v1/discoveries/list', '/v1/entities/list', '/v1/locations', '/v1/secrets',
    '/v1/vaults/list', '/v1/vaultProfiles/list', '/v1/auditLogs', '/v1/oids/list', '/v1/users/identify',
    '/v1/certificates/content', '/v1/workflows/events/{seg}/history', '/v1/workflows/events/{seg}/{seg}/{id}/history',
    '/v1/({seg}/)*attributes(/{seg})?/validate', '/v1/connectors/{id}/{seg}/{seg}/validate',
];

/** Client protocol traffic (ACME / SCEP / CMP endpoints): authenticated by the protocol, bodies are protocol messages. */
export const POST_PROTOCOL: readonly string[] = ['/v[12]/protocols(/{seg})+'];


export type PostRouteKind = 'create' | 'read' | 'protocol';

const compile = (list: readonly string[]) => list.map((p) => new RegExp(`^${p.replace(/\{id\}/g, UUID).replace(/\{seg\}/g, SEG)}$`));
const POST_KINDS: Array<[PostRouteKind, RegExp[]]> = [['protocol', compile(POST_PROTOCOL)], ['read', compile(POST_READ)], ['create', compile(POST_CREATE)]];

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

// ------------------------------------------------------------------ reference fields

/**
 * TOP-LEVEL body fields that may name a PRE-EXISTING object on an own create / update (never on a DELETE), decided per
 * field from the request DTOs in `interfaces` (com.otilm.api.model.*). Default deny: every other uuid must be own. The
 * value must be a canonical uuid STRING (a non-canonical form is refused, never waived; a list or an object under the
 * field is no reference and is scanned like any other value).
 * - connectorUuid: the provider an own authority / credential / token / entity / vault / discovery / notification
 *   instance uses (AuthorityInstanceRequestDto, CredentialRequestDto, TokenInstanceRequestDto, EntityInstanceRequestDto,
 *   VaultInstanceRequestDto, DiscoveryDto, NotificationInstanceRequestDto); the connector is only referenced, and
 *   connector registration / approval is on the platform deny-list.
 * - interfaceUuid: the connector's function-group interface (AuthorityInstanceRequestDto, DiscoveryDto,
 *   VaultInstanceRequestDto): a capability id of the connector, not an inventory object.
 * - raProfileUuid: the RA profile an own ACME / SCEP / CMP profile issues through, or an own certificate / location
 *   issue is assigned to (AcmeProfileRequestDto, AcmeProfileEditRequestDto, BaseScepProfileRequestDto,
 *   BaseCmpProfileRequestDto, CertificateUpdateObjectsDto, MultipleCertificateObjectUpdateDto, IssueToLocationRequestDto,
 *   ClientCertificateRequestDto): stored on the own object, the RA profile is not changed (issuing under any RA profile
 *   is already on the create allow-list). Side effect, accepted: while the own object exists the RA profile has a
 *   dependant (the run-end teardown removes it).
 * Not allowed until a key teardown handler exists: tokenProfileUuid /
 * altTokenProfileUuid — the platform generates the own certificate's key IN the foreign token profile, i.e. it leaves
 * a key in a foreign token that no teardown handler removes yet.
 * Deliberately NOT allowed (must be own or a probe): authorityUuid — no request DTO carries it in a body (the authority
 * is a path scope parent); keyUuid / altKeyUuid — issuing with a pre-existing key attaches it to a new certificate (its
 * associations and usage change); groupUuids / groupUuid — group membership feeds approvals (ApprovalStepRequestDto) and
 * notifications to the group's members (the suite creates its own groups, REG-CFG-06); ownerUuid / userUuid / roleUuid /
 * recipientUuids / notificationInstanceUuid / mappedUserUuid — point real people or delivery channels at run objects;
 * certificateUuid / signingCertificateUuid / caCertificateUuid / sourceCertificateUuid — bind or sign with a
 * pre-existing certificate; proxyUuid — connector routing (platform-level); rulesUuids / actionsUuids / conditionsUuids
 * / executionsUuids / triggerUuids / objectUuid — workflow wiring would make a foreign part fire on run events or keep it
 * from being deleted; uuid (ObjectPermissionsRequestDto) — a role permission on a pre-existing object.
 */
export const REFERENCE_FIELDS: Readonly<Record<string, string>> = {
    connectorUuid: 'the connector (provider) of an own object; referenced, never changed',
    interfaceUuid: 'the connector function-group interface: a capability id, not an inventory object',
    raProfileUuid: 'the RA profile an own protocol profile / certificate issues through; the RA profile is not changed',
};

// ------------------------------------------------------------------ platform deny-list

/** `objectUuid` of a workflow event association: a canonical uuid string, else the association is platform-level. */
const objectLevel = (body: unknown): boolean =>
    !!body && typeof body === 'object' && !Array.isArray(body) && isCanonicalUuid((body as { objectUuid?: unknown }).objectUuid);

/** The end of a deny pattern for a SUBTREE: the next segment or a `.suffix` (Spring's suffix spellings), or the end. */
const END = '(?:[/.]|$)';
const deny = (body: string): RegExp => new RegExp(`^/v[12]/${body}${END}`, 'i');
/** One endpoint (not its subtree): itself or a `.suffix` spelling of it (`purge.json`, `purge.`). */
const denyExact = (body: string): RegExp => new RegExp(`^/v[12]/${body}(?:\\.|$)`, 'i');

/**
 * Platform-level endpoints, v1 and v2, case-insensitive, anchored `([/.]|$)` (`purge.json`,
 * `settings.` are the same endpoint): refused for every mutating method unless `localStack` on a proven local stack.
 * Read POSTs (`/v1/oids/list`, `/v1/auditLogs`) are allow-listed before this.
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
    { path: deny('timeQualityConfigurations'), why: 'time-quality configurations' },
    { path: deny('attributes/metadata'), why: 'global metadata definitions' },
    { path: deny('cboms'), why: 'the CBOM repository (upload, delete, sync)' },
    { path: denyExact(`connectors/(?:approve|reconnect|connect|${UUID}/(?:approve|reconnect))`), why: 'connector approve / reconnect / connect' },
    { path: denyExact('connector/register'), why: 'connector registration' },
    { path: deny('branding'), why: 'platform branding' },
    { path: deny('local'), why: 'local administrator management' },
    { path: denyExact('auditLogs/purge'), why: 'the platform audit log (purge)' },
    { path: deny('oids'), why: 'the platform OID registry' },
    { path: denyExact('discoveries/schedule'), why: 'a scheduled (platform-level) discovery job' },
    // The legacy client API names RA profiles and end entities by NAME (`/v1/operations/{raProfileName}/
    // certificate/revoke`, `…/endentity/{username}`); the uuid-keyed `/v1/operations/tokens/{uuid}/…` and
    // `/v2/operations/authorities/{uuid}/…` stay (an RA profile NAMED `tokens` / `authorities` gets no further: its
    // path-less legacy routes are no create and no bulk route).
    { path: new RegExp(`^/v[12]/operations/(?!(?:tokens|authorities)/)[^/]+${END}`, 'i'), why: 'the legacy name-keyed client API (/v1/operations/{raProfileName}/…)' },
];

/** Why a mutation of `apiPath` is a platform-level change, or undefined. */
export function platformDenied(apiPath: string, body?: unknown): string | undefined {
    return PLATFORM_DENY.find((d) => d.path.test(apiPath) && (!d.when || d.when(body)))?.why;
}
