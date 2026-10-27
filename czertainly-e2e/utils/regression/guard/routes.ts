/**
 * guard/routes — route tables of the ILM core REST API that the guard (guard/createGuard.ts) needs, derived from the controller
 * interfaces of the `interfaces` repository (com.otilm.api.interfaces.core.web, .core.web.v2, .core.client; read-only,
 * at revision INTERFACES_REVISION). A mutation without a uuid in its path is not
 * accepted because its body carries "some" own uuid list; it must be an allow-listed create (guardedApi POST_CREATE) or
 * one of the BULK_ROUTES below, whose body names its objects in the list the DTO declares.
 *
 * How the tables were derived (re-derive them when the interfaces change; the generator follows them):
 * - every `@GetMapping` / `@PostMapping` / `@PutMapping` / `@PatchMapping` / `@DeleteMapping` / `@RequestMapping` of a
 *   core controller interface, prefixed with the class-level `@RequestMapping`, with its `@RequestBody` type;
 * - BULK_ROUTES: the mutations without a `{…uuid}` path variable whose body is a uuid list (`List<String>` / `List<UUID>`) or a bulk DTO
 *   with one (`uuids`, `certificateUuids`), on collection routes ending in enable / disable / delete / force / forceDelete / compromise /
 *   destroy / usages / archive / unarchive / revoke, plus DELETE on the collection paths that take a uuid list. LEFT OUT on purpose
 *   (refused by the guard): the platform-level ones (global metadata, CBOMs, OIDs, connector approve /
 *   reconnect: PLATFORM_DENY), the bulk delete of time-quality configurations (`DELETE /v1/timeQualityConfigurations`: no ledger
 *   bulk type; a single own one is deleted by uuid), compliance re-evaluations (`/v1/certificates/compliance`, `/v1/complianceProfiles/compliance`,
 *   `/v1/raProfiles/compliance`, `/v2/compliance[/{resource}]`: no listed verb; the per-object `POST /v2/compliance/{resource}/{uuid}`
 *   stays available through ownership), `PATCH /v1/notifications` (mark as read: per-user state, not a listed verb), audit-log export /
 *   purge, and every other path-less POST that is not a create (`/v1/certificates/create`, `/v1/acmeProfiles/eabKeys`, …). Moved to
 *   guardedApi POST_CREATE: `/v1/inspections` (body-judged, creates nothing), `/v1/certificates/import` (certificate-only entries).
 * - NO_HANDLER_PROBES / MALFORMED_UUID_PROBES: exact (method, path) pairs that
 *   reach NO handler at INTERFACES_REVISION — re-verify them (the grep in each table's comment) whenever
 *   INTERFACES_REVISION moves: a later release that adds a handler turns the allowance into a real mutation.
 * - ROUTE_FIELD_WAIVERS: a body field a named route may fill with a non-own uuid, with its core proof.
 * - API_WORDS: every literal path segment of every core route (any method) plus the codes a path enum may take there
 *   (`{resource}`: Resource codes; `{functionGroup}`: FunctionGroupCode codes; `{type}` of a key: KeyRequestType codes).
 *   A MUTATION path segment that is neither a canonical uuid nor one of these words names an object by NAME (an RA
 *   profile, an end-entity user name, an OID, an OAuth2 provider, a connector kind): the guard cannot prove whose object
 *   that is, so it refuses the request (kind `request`; lifted only by `localStack` on a proven local stack).
 * - SIDE_EFFECT_GETS: GET endpoints whose handler persists something (from a read-only audit of core): the guard sends them only
 *   for own objects (or probe uuids), like a mutation.
 * - TARGET_TYPES / RESOURCE_TYPES: the ledger type of the object a uuid path variable names,
 *   read from the literal segment(s) before it in every core route with a uuid path variable (and from the `Resource`
 *   code where the route takes one: `…/associations/{resource}/{uuid}`, `/v1/comments/{resource}/{uuid}`,
 *   `/v2/compliance/{resource}/{uuid}`, `/v1/attributes/custom/resources/{resource}/objects/{uuid}/{attributeUuid}`);
 *   each BULK_ROUTES entry names the ledger type of its uuid list. An ownership claim counts only for the resource the
 *   request acts on: a ledger line of another type (an id-named `approvals` line naming an RA profile) is refused.
 * - UUID_TYPED_FIELDS: the request DTO fields typed `UUID` / `List<UUID>` / `Set<UUID>`.
 */

/** The `interfaces` revision the tables were derived from. */
export const INTERFACES_REVISION = '2b7962c7 (2026-10-09)';

export type BulkMethod = 'DELETE' | 'PATCH' | 'PUT' | 'POST';

export interface BulkRoute {
    method: BulkMethod;
    /** The API path after `/api` (exact, case-sensitive like Spring's matcher). */
    path: string;
    /** Where the body names its objects: `array` = the body IS the uuid list; a field name = that top-level DTO list. */
    list: 'array' | string;
    /** The other top-level fields of the DTO (a body may carry nothing else; uuids in them must be own like any body uuid). */
    fields?: readonly string[];
    /** The request body type in `interfaces`. */
    dto: string;
    /**
     * The ledger type of the objects the list names: every listed uuid that is not a probe must have a
     * ledger line of exactly this type. undefined: the suite has no ledger type for the resource (key items,
     * notifications, signing / TSP profiles, signing records) — the route is refused unless every listed uuid is a probe.
     */
    type: string | undefined;
}

const arr = (method: BulkMethod, path: string, type: string | undefined, dto = 'List<String>'): BulkRoute => ({ method, path, list: 'array', dto, type });

export const BULK_ROUTES: readonly BulkRoute[] = [
    arr('PATCH', '/v1/acmeAccounts/disable', 'acmeAccounts'), arr('PATCH', '/v1/acmeAccounts/enable', 'acmeAccounts'), arr('PUT', '/v1/acmeAccounts/revoke', 'acmeAccounts'),
    arr('DELETE', '/v1/acmeProfiles/delete', 'acmeProfiles'), arr('DELETE', '/v1/acmeProfiles/delete/force', 'acmeProfiles'),
    arr('PATCH', '/v1/acmeProfiles/disable', 'acmeProfiles'), arr('PATCH', '/v1/acmeProfiles/enable', 'acmeProfiles'),
    arr('DELETE', '/v1/attributes/custom', 'customAttributes'), arr('PATCH', '/v1/attributes/custom/disable', 'customAttributes'),
    arr('PATCH', '/v1/attributes/custom/enable', 'customAttributes'),
    arr('DELETE', '/v1/authorities', 'authorities'), arr('DELETE', '/v1/authorities/force', 'authorities'),
    {
        method: 'PATCH', path: '/v1/certificates', list: 'certificateUuids', fields: ['groupUuids', 'ownerUuid', 'raProfileUuid', 'attributes'],
        dto: 'MultipleCertificateObjectUpdateDto (its `filters` are never accepted)', type: 'certificates',
    },
    arr('PATCH', '/v1/certificates/archive', 'certificates', 'List<UUID>'), arr('PATCH', '/v1/certificates/unarchive', 'certificates', 'List<UUID>'),
    { method: 'POST', path: '/v1/certificates/delete', list: 'uuids', dto: 'RemoveCertificateDto (its `filters` are never accepted)', type: 'certificates' },
    arr('DELETE', '/v1/cmpProfiles/delete', 'cmpProfiles'), arr('DELETE', '/v1/cmpProfiles/delete/force', 'cmpProfiles'),
    arr('PATCH', '/v1/cmpProfiles/disable', 'cmpProfiles'), arr('PATCH', '/v1/cmpProfiles/enable', 'cmpProfiles'),
    arr('DELETE', '/v1/complianceProfiles', 'complianceProfiles'), arr('DELETE', '/v1/complianceProfiles/force', 'complianceProfiles'),
    arr('DELETE', '/v2/complianceProfiles', 'complianceProfiles', 'List<UUID>'), arr('DELETE', '/v2/complianceProfiles/force', 'complianceProfiles', 'List<UUID>'),
    arr('DELETE', '/v1/connectors', 'connectors'), arr('DELETE', '/v1/connectors/force', 'connectors'),
    arr('DELETE', '/v2/connectors', 'connectors', 'List<UUID>'), arr('POST', '/v2/connectors/forceDelete', 'connectors', 'List<UUID>'),
    arr('DELETE', '/v1/credentials', 'credentials'), arr('DELETE', '/v1/discoveries', 'discoveries'), arr('DELETE', '/v1/groups', 'groups'),
    arr('DELETE', '/v1/keys', 'keys'), arr('PATCH', '/v1/keys/destroy', 'keys'), arr('PATCH', '/v1/keys/disable', 'keys'), arr('PATCH', '/v1/keys/enable', 'keys'),
    { method: 'PATCH', path: '/v1/keys/compromise', list: 'uuids', fields: ['reason'], dto: 'BulkCompromiseKeyRequestDto', type: 'keys' },
    { method: 'PUT', path: '/v1/keys/usages', list: 'uuids', fields: ['usage'], dto: 'BulkKeyUsageRequestDto', type: 'keys' },
    // Key items: the `keyItems` ledger type — children of an own `keys` line
    // (recorded from the create response, parent `key`; live read `GET /v1/keys/{key}/items/{uuid}`, whose `name` is
    // the key's run-prefixed name).
    arr('DELETE', '/v1/keys/items', 'keyItems'), arr('PATCH', '/v1/keys/items/destroy', 'keyItems'), arr('PATCH', '/v1/keys/items/disable', 'keyItems'),
    arr('PATCH', '/v1/keys/items/enable', 'keyItems'),
    { method: 'PATCH', path: '/v1/keys/items/compromise', list: 'uuids', fields: ['reason'], dto: 'BulkCompromiseKeyItemRequestDto', type: 'keyItems' },
    { method: 'PUT', path: '/v1/keys/items/usages', list: 'uuids', fields: ['usage'], dto: 'BulkKeyItemUsageRequestDto', type: 'keyItems' },
    arr('DELETE', '/v1/notifications', undefined),
    arr('DELETE', '/v1/raProfiles', 'raProfiles'), arr('PATCH', '/v1/raProfiles/disable', 'raProfiles'), arr('PATCH', '/v1/raProfiles/enable', 'raProfiles'),
    arr('DELETE', '/v1/scepProfiles/delete', 'scepProfiles'), arr('DELETE', '/v1/scepProfiles/delete/force', 'scepProfiles'),
    arr('PATCH', '/v1/scepProfiles/disable', 'scepProfiles'), arr('PATCH', '/v1/scepProfiles/enable', 'scepProfiles'),
    arr('DELETE', '/v1/signingProfiles', undefined, 'List<UUID>'), arr('PATCH', '/v1/signingProfiles/disable', undefined, 'List<UUID>'),
    arr('PATCH', '/v1/signingProfiles/enable', undefined, 'List<UUID>'),
    arr('DELETE', '/v1/signingRecords', undefined, 'List<UUID>'),
    arr('DELETE', '/v1/tokenProfiles', 'tokenProfiles'), arr('PATCH', '/v1/tokenProfiles/disable', 'tokenProfiles'), arr('PATCH', '/v1/tokenProfiles/enable', 'tokenProfiles'),
    arr('DELETE', '/v1/tokens/delete', 'tokens'),
    // BulkTokenProfileKeyUsageRequestDto.uuids: "Token Profile UUIDs" (the route lives under /tokens).
    { method: 'PUT', path: '/v1/tokens/usages', list: 'uuids', fields: ['usage'], dto: 'BulkTokenProfileKeyUsageRequestDto', type: 'tokenProfiles' },
    arr('DELETE', '/v1/tspProfiles', undefined, 'List<UUID>'), arr('PATCH', '/v1/tspProfiles/disable', undefined, 'List<UUID>'),
    arr('PATCH', '/v1/tspProfiles/enable', undefined, 'List<UUID>'),
];

/** The bulk route of a method and API path, or undefined. */
export function bulkRoute(method: string, apiPath: string): BulkRoute | undefined {
    return BULK_ROUTES.find((r) => r.method === method && r.path === apiPath);
}

/** Every literal segment of the core routes plus the path-enum codes (see the module header). */
export const API_WORDS: ReadonlySet<string> = new Set([
    'acct', 'acme', 'acmeAccounts', 'acmeAuthorizations', 'acmeChallenges', 'acmeOrders', 'acmeProfiles', 'actions',
    'activate', 'admins', 'apiKey', 'approvalProfiles', 'approvals', 'approve', 'approveRecipient', 'archive',
    'assets', 'associate', 'associations', 'async', 'attributes', 'auditLogs', 'auth', 'authentication',
    'authenticationProviders', 'authorities', 'authorityProvider', 'authz', 'availableOperations', 'basic',
    'basicCredentials', 'branding', 'caCertificates', 'callback', 'cancel', 'cas', 'cboms', 'cert', 'certificate',
    'certificateprofiles', 'certificateRequests', 'certificates', 'chain', 'chall', 'cipher', 'cmp', 'cmpProfiles',
    'cmpTransactions', 'comments', 'compliance', 'complianceGroups', 'complianceProfiles', 'complianceProvider',
    'complianceRules', 'compromise', 'conditions', 'confirm', 'connect', 'connector', 'connectors', 'content',
    'contentSigningFormattingAttributes', 'create', 'credentialProvider', 'credentials', 'cryptoAssets',
    'cryptographyProvider', 'csr', 'custom', 'customAttributes', 'dashboard', 'deactivate', 'decrypt', 'delete',
    'destroy', 'directory', 'disable', 'disassociate', 'discoveries', 'discoveryProvider', 'eabKeys', 'enable',
    'encrypt', 'endentity', 'endentityprofiles', 'endEntityProfiles', 'entities', 'entityProvider', 'enums', 'events',
    'executions', 'export', 'filters', 'finalize', 'force', 'forceDelete', 'formattingAttributes', 'globalMetadata',
    'groups', 'health', 'history', 'identify', 'import', 'info', 'inspections', 'instructions', 'issue', 'items',
    'jobs', 'jwt', 'key-change', 'keyItems', 'keyPair', 'keys', 'keystore', 'keyUsages', 'legacyAuthorityProvider',
    'list', 'listViews', 'liveness', 'local', 'location', 'locations', 'logging', 'login', 'mapping', 'messages',
    'metadata', 'new-account', 'new-nonce', 'new-order', 'notificationInstances', 'notificationProfiles',
    'notificationProvider', 'notifications', 'oauth2', 'oauth2Providers', 'objects', 'oids', 'operations', 'order',
    'orders', 'pairs', 'permissions', 'pkiclient.exe', 'platform', 'platformEnums', 'pqcExplanation', 'profile',
    'promote', 'protocols', 'providers', 'proxies', 'purge', 'push', 'random', 'raprofile', 'raProfile', 'raProfiles',
    'readiness', 'reconnect', 'register', 'reject', 'rejectRecipient', 'rekey', 'relations', 'renew', 'replies',
    'requestAttributes', 'resetPassword', 'resolve', 'resourceEvents', 'resources', 'resume', 'retry', 'revoke',
    'revoke-cert', 'roles', 'rules', 'scep', 'scepProfiles', 'schedule', 'scheduler', 'search', 'searchFilters',
    'secret', 'secrets', 'settings', 'sign', 'signature', 'signatureAttributes', 'signatureFormattingConnectors',
    'signingCertificates', 'signingProfiles', 'signingRecords', 'statistics', 'stop', 'supportedProtocols', 'sync',
    'syncSkips', 'syncVaultProfiles', 'system', 'timeQualityConfigurations', 'tokenProfiles', 'tokens', 'triggers',
    'trustedCertificates', 'tsp', 'tspProfileBasicCredentials', 'tspProfiles', 'types', 'unarchive', 'unresolve',
    'upload', 'usages', 'user', 'users', 'validate', 'validation', 'vaultProfiles', 'vaults', 'verify', 'versions',
    'workflows',
]);

// ------------------------------------------------------------------ the resource a uuid path variable names

const IS_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The ledger type of a uuid path variable, keyed by the literal segment before it (`raProfiles`) or the two before it
 * (`attributes/custom`, `acme/activate`), from every core route with a uuid path variable (interfaces at
 * INTERFACES_REVISION). The values are the suite's ledger types (ledger/ownership.ts LIVE_READS and ID_NAMED). A segment that
 * is not here (`signingRecords`, `notifications`, `comments`, `permissions`,
 * `complianceProfiles/rules`, `cboms`, `proxies`, …) names a resource the suite has no ledger type for: unresolvable.
 * `items`: the key items of `/v1/keys/{uuid}/items/{keyItemUuid}` and of
 * `/v1/operations/tokens/{t}/tokenProfiles/{p}/keys/{k}/items/{i}/sign|verify|encrypt|decrypt` — ledger type `keyItems`.
 */
export const TARGET_TYPES: Readonly<Record<string, string>> = {
    acmeAccounts: 'acmeAccounts', acmeProfiles: 'acmeProfiles', approvalProfiles: 'approvalProfiles', approvals: 'approvals',
    authorities: 'authorities', certificates: 'certificates', cmpProfiles: 'cmpProfiles', complianceProfiles: 'complianceProfiles',
    connectors: 'connectors', credentials: 'credentials', discoveries: 'discoveries',
    entities: 'entities', groups: 'groups', items: 'keyItems', keys: 'keys', locations: 'locations',
    notificationInstances: 'notificationInstances', notificationProfiles: 'notificationProfiles', raProfiles: 'raProfiles',
    roles: 'roles', scepProfiles: 'scepProfiles', secrets: 'secrets', tokenProfiles: 'tokenProfiles', tokens: 'tokens',
    users: 'users', vaultProfiles: 'vaultProfiles', vaults: 'vaultInstances',
    // (no single-word `customAttributes` key: no core route has `/customAttributes/{uuid}`)
    'attributes/custom': 'customAttributes',
    'workflows/actions': 'actions', 'workflows/conditions': 'conditions', 'workflows/executions': 'executions',
    'workflows/rules': 'rules', 'workflows/triggers': 'triggers',
    'scheduler/jobs': 'scheduledJobs',
    // `/v1/acmeProfiles/{uuid}/raprofile/{raProfileUuid}`, `/v1/certificates/{uuid}/relations/{certificateUuid}`,
    // `/v1/secrets/{uuid}/syncVaultProfiles/{vaultProfileUuid}`, `…/protocols/{acme|scep|cmp}/activate/{profileUuid}`.
    raprofile: 'raProfiles', relations: 'certificates', syncVaultProfiles: 'vaultProfiles',
    'acme/activate': 'acmeProfiles', 'cmp/activate': 'cmpProfiles', 'scep/activate': 'scepProfiles',
    // Timestamping (tests/timestamping/SHARED-TIER.md): `/v1/signingProfiles/{uuid}`, `/v1/tspProfiles/{uuid}`,
    // `/v1/timeQualityConfigurations/{uuid}`, `/v1/tspProfiles/{tsp}/basicCredentials/{uuid}` and
    // `/v1/signingProfiles/{uuid}/protocols/tsp/activate/{tspProfileUuid}`. `signingRecords` stays unmapped (a record has no ledger type).
    signingProfiles: 'signingProfiles', tspProfiles: 'tspProfiles', timeQualityConfigurations: 'timeQualityConfigurations',
    basicCredentials: 'tspBasicCredentials', 'tsp/activate': 'tspProfiles',
};

/**
 * The ledger type of a `Resource` code (interfaces com.otilm.api.model.core.auth.Resource) in a route that takes one
 * before a uuid. Codes without a ledger type (keyItems, comments, signingProfiles, …) are unresolvable.
 */
export const RESOURCE_TYPES: Readonly<Record<string, string>> = {
    acmeAccounts: 'acmeAccounts', acmeProfiles: 'acmeProfiles', actions: 'actions', approvalProfiles: 'approvalProfiles',
    approvals: 'approvals', authorities: 'authorities', certificates: 'certificates', cmpProfiles: 'cmpProfiles',
    complianceProfiles: 'complianceProfiles', conditions: 'conditions', connectors: 'connectors', credentials: 'credentials',
    customAttributes: 'customAttributes', discoveries: 'discoveries', entities: 'entities', executions: 'executions',
    groups: 'groups', jobs: 'scheduledJobs', keys: 'keys', locations: 'locations',
    notificationInstances: 'notificationInstances', notificationProfiles: 'notificationProfiles', raProfiles: 'raProfiles',
    roles: 'roles', rules: 'rules', scepProfiles: 'scepProfiles', secrets: 'secrets', tokenProfiles: 'tokenProfiles',
    tokens: 'tokens', triggers: 'triggers', users: 'users', vaultProfiles: 'vaultProfiles', vaults: 'vaultInstances',
};

/** The ledger type of a `Resource` code (exact, case-sensitive like `Resource.findByCode`), or undefined. */
export const ledgerTypeOfResource = (code: unknown): string | undefined =>
    typeof code === 'string' && Object.hasOwn(RESOURCE_TYPES, code) ? RESOURCE_TYPES[code] : undefined;

/** Segments after which the next segment is a `Resource` code and the one after it a uuid of that resource. */
const RESOURCE_CONTEXT = new Set(['associations', 'comments', 'compliance']);

const own = (table: Readonly<Record<string, string>>, key: string | undefined): string | undefined =>
    key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;

/**
 * The ledger type of the uuid at `segs[i]` (`segs` = the API path split on `/`, empty parts dropped: `['v1', 'raProfiles',
 * '<uuid>']`), or undefined when the route names a resource the suite has no ledger type for.
 */
export function resourceTypeAt(segs: readonly string[], i: number): string | undefined {
    const prev = segs[i - 1];
    const prev2 = segs[i - 2];
    // /v1/attributes/custom/resources/{resource}/objects/{objectUuid}/{attributeUuid}
    if (prev === 'objects' && segs[i - 3] === 'resources' && segs[i - 4] === 'custom' && segs[i - 5] === 'attributes') return own(RESOURCE_TYPES, prev2);
    if (prev !== undefined && IS_UUID.test(prev) && prev2 === 'objects' && segs[i - 4] === 'resources' && segs[i - 5] === 'custom') return 'customAttributes';
    // …/associations/{resource}/{uuid}, /v1/comments/{resource}/{uuid}, /v2/compliance/{resource}/{uuid}
    if (prev2 !== undefined && RESOURCE_CONTEXT.has(prev2)) return own(RESOURCE_TYPES, prev);
    if (prev === undefined || IS_UUID.test(prev)) return undefined;
    return own(TARGET_TYPES, prev2 !== undefined ? `${prev2}/${prev}` : undefined) ?? own(TARGET_TYPES, prev);
}

// ------------------------------------------------------------------ uuid-typed request fields

/**
 * Every field NAME of a core request DTO typed `UUID`, `List<UUID>` or `Set<UUID>` (Jackson's UUIDDeserializer reads
 * the 22 / 24-character base64 forms there), derived from `interfaces` at INTERFACES_REVISION: the `@RequestBody` types
 * of the core controller interfaces (com.otilm.api.interfaces.core.**) and every model class reachable from them through
 * field types and superclasses (237 classes; type-use annotations inside generics such as
 * `List<@NotNull ListViewColumnDto>` must be followed, or 10 classes stay hidden; derived by a read-only script). The guard counts the
 * unpadded 22-character base64 form only under these keys and UUID_FIELD_NAME-shaped ones; the names that UUID_FIELD_NAME does not
 * match are `groups` (ProviderComplianceRulesRequestDto), `internalRules` (ComplianceProfileUpdateRequestDto) and
 * `triggers` (DiscoveryDto). Re-derive it when the interfaces change.
 */
export const UUID_TYPED_FIELDS: ReadonlySet<string> = new Set([
    'attributeDefinitionUuids', 'eabSecretUuids', // found through generics: ListViewColumnDto / ListViewFilterDto, AcmeProfile{,Edit}RequestDto
    'altKeyUuid', 'altTokenProfileUuid', 'connectorUuid', 'defaultSigningProfileUuid', 'groupUuid', 'groupUuids', 'groups',
    'interfaceUuid', 'internalRules', 'keyUuid', 'mappedUserUuid', 'notificationInstanceUuid', 'objectUuid', 'ownerUuid',
    'parentUuid', 'raProfileUuid', 'recipientUuids', 'roleUuid', 'ruleUuid', 'sourceCertificateUuid', 'sourceVaultProfileUuid',
    'tokenProfileUuid', 'triggerUuids', 'triggers', 'userUuid', 'uuid', 'uuids', 'vaultProfileUuid',
]);

// ------------------------------------------------------------------ body reference fields

/**
 * The resource a uuid-bearing request DTO field names, for the names whose meaning is the same in every DTO that has them. Derived from
 * `interfaces` at INTERFACES_REVISION by a read-only script: every field of the request DTOs (the `@RequestBody` types of the core
 * controller interfaces and every model class reachable from them) typed `UUID` / `List|Set<UUID>`, or `String` / `List|Set<String>` with
 * `uuid` in its name — 45 names (generics included, see above); the field's `@Schema` description decides the resource. A canonical uuid
 * that is the whole string value of such a field (directly or in its list) must be own WITH a ledger line of exactly this type, or a probe;
 * `null` = a resource the suite has no ledger type for (compliance provider groups and rules, comments, proxies): probes
 * only (fail-closed, like an unresolvable path target). The REFERENCE_FIELDS waiver (`connectorUuid`, `interfaceUuid`, `raProfileUuid` as a
 * top-level string of an own create / update) is applied first and unchanged. `objectUuid` is typed by its sibling `resource`
 * (SIBLING_TYPED_FIELDS); every other uuid-bearing field is in UNMAPPED_UUID_FIELDS.
 */
export const BODY_FIELD_TYPES: Readonly<Record<string, string | null>> = {
    actionsUuids: 'actions', // TriggerRequestDto, UpdateTriggerRequestDto: existing actions of the trigger
    altKeyUuid: 'keys', // ClientCertificate{Issue,Rekey,}RequestDto: alternative key
    altTokenProfileUuid: 'tokenProfiles', // ClientCertificate{Issue,Rekey,}RequestDto
    authorityInstanceUuid: 'authorities', // RaProfileDto: authority provider instance
    caCertificateUuid: 'certificates', // BaseScepProfileRequestDto: CA certificate for SCEP
    certificateUuid: 'certificates', // UpdateUserRequestDto: an inventory certificate
    certificateUuids: 'certificates', // CertificateComplianceCheckDto, MultipleCertificateObjectUpdateDto
    conditionsUuids: 'conditions', // RuleRequestDto, UpdateRuleRequestDto
    connectorUuid: 'connectors', // every DTO: the provider connector (compliance, credential, discovery, notification, vault, …)
    customAttributeUuid: 'customAttributes', // AttributeMappingDto
    eabSecretUuids: 'secrets', // AcmeProfile{,Edit}RequestDto: secrets holding the EAB HMAC keys
    executionsUuids: 'executions', // ActionRequestDto, UpdateActionRequestDto
    groupUuids: 'groups', // certificate / key / secret / protocol groups: ILM groups everywhere
    keyUuid: 'keys', // ClientCertificate{Issue,Rekey,}RequestDto
    mappedUserUuid: 'users', // TspBasicCredential{Create,Update}RequestDto: the ILM user
    notificationInstanceUuid: 'notificationInstances', // NotificationProfileUpdateRequestDto
    notificationProfileUuid: 'notificationProfiles', // ExecutionItemRequestDto
    ownerUuid: 'users', // certificate / key / secret owner user
    raProfileUuid: 'raProfiles', // protocol profiles, certificate updates, issue to location, client certificate requests
    raProfileUuids: 'raProfiles', // RaProfileAssociationRequestDto
    roleUuid: 'roles', // ApprovalStepRequestDto
    rulesUuids: 'rules', // TriggerRequestDto, UpdateTriggerRequestDto: workflow rules
    signingCertificateUuid: 'certificates', // BaseCmpProfileRequestDto
    sourceCertificateUuid: 'certificates', // ClientCertificateRegistrationDto, ClientCertificateRequestDto
    sourceVaultProfileUuid: 'vaultProfiles', // SecretUpdateObjectsDto
    tokenProfileUuid: 'tokenProfiles', // ClientCertificate{Issue,Rekey,}RequestDto, EditKeyRequestDto, InspectionRequestDto
    triggerUuids: 'triggers', // EventSettingsDto, TriggerEventAssociationRequestDto
    triggers: 'triggers', // DiscoveryDto: workflow triggers after the discovery
    userUuid: 'users', // ApprovalStepRequestDto
    vaultProfileUuid: 'vaultProfiles', // TspProfileRequestDto
    defaultSigningProfileUuid: 'signingProfiles', // TspProfileRequestDto: the TSP profile's default signing profile
    // The two fields of the timestamping workflow DTO (TimestampingWorkflowRequestDto) a signing profile create / update names; the
    // generic derivation missed them (a polymorphic `workflow` subtype). The time-quality configuration must be own; the formatting
    // connector must be own too, except where a route waives it (ROUTE_PATH_WAIVERS).
    timeQualityConfigurationUuid: 'timeQualityConfigurations',
    signatureFormattingConnectorUuid: 'connectors', // TimestampingWorkflowRequestDto, ContentSigningWorkflowRequestDto
    // No ledger type (probes only until the batch that first creates them adds the type and its teardown handler):
    groups: null, // ProviderComplianceRulesRequestDto: compliance PROVIDER groups (not ILM groups)
    internalRules: null, // ComplianceProfileUpdateRequestDto: compliance internal rules
    ruleUuid: null, // ComplianceProfileRulesPatchRequestDto, ComplianceRule{Addition,Deletion}RequestDto: compliance rules
    parentUuid: null, // CommentCreateRequestDto: a comment thread root
    proxyUuid: null, // ConnectorRequestDto, ConnectorUpdateRequestDto: a connector proxy
};

/**
 * Fields typed by a SIBLING field of the same object: the sibling holds a `Resource` code, mapped through
 * RESOURCE_TYPES; a missing or unknown code (or one without a ledger type) makes the field probes-only.
 * `objectUuid` + `resource`: TriggerEventAssociationRequestDto (`POST /v1/workflows/events`).
 */
export const SIBLING_TYPED_FIELDS: Readonly<Record<string, string>> = { objectUuid: 'resource' };

/**
 * The uuid-bearing request DTO fields (same derivation) whose resource differs between DTOs or is no inventory object:
 * a uuid under them may be ANY own object (or a probe) — each with the reason it stays unmapped.
 */
export const UNMAPPED_UUID_FIELDS: Readonly<Record<string, string>> = {
    attributeDefinitionUuids: 'ListViewColumnDto, ListViewFilterDto: READ_ONLY attribute definitions; "a value sent in a request is ignored"',
    attributeUuid: 'SourceParam, ValueSourceBindingDto: an attribute definition (custom, metadata or connector-defined)',
    groupUuid: 'ApprovalStepRequestDto: an ILM group; ComplianceGroupRequestDto / ComplianceProfileGroupsPatchRequestDto: a compliance group',
    interfaceUuid: 'AuthorityInstanceRequestDto, DiscoveryDto, VaultInstanceRequestDto: a connector interface (capability id, REFERENCE_FIELDS)',
    mappingAttributeUuid: 'AttributeMappingDto: an attribute definition of any kind',
    recipientUuids: 'NotificationProfileUpdateRequestDto: users, groups or roles (by recipient type)',
    uuid: 'ComplianceRuleRequestDto (a rule), ConnectRequestDto (a connector), NameAndUuidDto, ObjectPermissionsRequestDto: differs per DTO; ' +
        'in `PUT /v1/roles/{own}/permissions` an `objects[].uuid` entry names the object a permission of the OWN role covers — the ' +
        'object itself is not mutated (accepted)',
    uuids: 'the bulk DTOs: keys, key items, token profiles or certificates (the bulk route types them: BULK_ROUTES)',
};

// ------------------------------------------------------------------ typed top-level list bodies

export interface ListBodyRoute {
    method: BulkMethod;
    /** The API path with `{id}` for each uuid path variable (exact, case-sensitive). */
    path: string;
    /** The ledger type of the uuids in the body list; null = a resource without a ledger type (probes only). */
    type: string | null;
    /** The `@RequestBody` in `interfaces`. */
    dto: string;
}

/**
 * Routes WITH a uuid path variable whose body is a top-level uuid list (`@RequestBody List<String> | List<UUID>`; every
 * such route of the core controller interfaces at INTERFACES_REVISION, from the pass-5 route table): each listed uuid is
 * claimed like a bulk-route uuid — own with a ledger line of `type`, or a probe. A top-level uuid list on any other
 * route with a path target or on a create is refused. Not here, on purpose: list bodies of OBJECTS or codes
 * (`List<RequestAttribute>` validations / activation / vault-profile sync, `List<AttributeContent>` custom-attribute
 * content, `List<ObjectPermissionsRequestDto>`, `List<Resource>`: their uuids sit in object fields, judged as fields),
 * and `POST /v2/compliance/{resource}` (`List<UUID>`, no uuid path variable: a path-less compliance re-evaluation,
 * refused as neither a create nor a bulk route).
 */
export const LIST_BODY_TYPES: readonly ListBodyRoute[] = [
    { method: 'PATCH', path: '/v1/roles/{id}/users', type: 'users', dto: 'List<String> userUuids (RoleManagementController.updateUsers)' },
    { method: 'PATCH', path: '/v1/users/{id}/roles', type: 'roles', dto: 'List<String> roleUuids (UserManagementController.updateRoles)' },
    // The items of the key in the path ("only those key items"): ledger type `keyItems`.
    { method: 'DELETE', path: '/v1/keys/{id}', type: 'keyItems', dto: 'List<String> keyItemUuids (CryptographicKeyController.deleteKey)' },
    { method: 'PATCH', path: '/v1/keys/{id}/destroy', type: 'keyItems', dto: 'List<String> keyItemUuids (destroyKey)' },
    { method: 'PATCH', path: '/v1/keys/{id}/disable', type: 'keyItems', dto: 'List<String> keyItemUuids (disableKey)' },
    { method: 'PATCH', path: '/v1/keys/{id}/enable', type: 'keyItems', dto: 'List<String> keyItemUuids (enableKey)' },
    { method: 'DELETE', path: '/v1/tokens/{id}/keys/{id}', type: 'keyItems', dto: 'List<String> keyItemUuids (deleteKey)' },
    { method: 'PATCH', path: '/v1/tokens/{id}/keys/{id}/destroy', type: 'keyItems', dto: 'List<String> keyItemUuids (destroyKey)' },
    { method: 'PATCH', path: '/v1/tokens/{id}/keys/{id}/disable', type: 'keyItems', dto: 'List<String> keyItemUuids (disableKey)' },
    { method: 'PATCH', path: '/v1/tokens/{id}/keys/{id}/enable', type: 'keyItems', dto: 'List<String> keyItemUuids (enableKey)' },
];

// ------------------------------------------------------------------ exact probe tables

export interface NoHandlerProbe {
    method: 'POST' | 'DELETE' | 'PUT' | 'PATCH';
    /** The API path (exact, case-sensitive). */
    path: string;
    /** Why no handler exists at INTERFACES_REVISION (the controller and its methods). */
    proof: string;
}

/**
 * (method, path) pairs whose controller defines GET only, so Spring's handler mapping
 * answers `HttpRequestMethodNotSupportedException` (core ExceptionHandlingAdvice → 400) before any
 * controller or service; the security chain authenticates first (SecurityConfig). The guard sends such a
 * pair bodyless, without a query, without an identity header, as the run's own identity. Verified against `interfaces`
 * at INTERFACES_REVISION by `grep -n Mapping` of the controller named in `proof`; no `/**` catch-all handler exists
 * (grep of `"/**"` in core and interfaces finds only servlet filter registrations), and the only wildcard POST
 * (`CallbackController`, `/v1/{resource}/{parentObjectUuid}/callback`) needs three segments.
 * Re-verify when INTERFACES_REVISION moves (module header).
 */
export const NO_HANDLER_PROBES: readonly NoHandlerProbe[] = [
    { method: 'POST', path: '/v1/statistics', proof: 'StatisticsController — @RequestMapping("/v1/statistics"), @GetMapping only' },
    { method: 'DELETE', path: '/v1/info', proof: 'InfoController — @RequestMapping("/v1"), @GetMapping("/info"), health GETs only' },
];

/** The NO_HANDLER_PROBES pair of a method and API path, or undefined. */
export function noHandlerProbe(method: string, apiPath: string): NoHandlerProbe | undefined {
    return NO_HANDLER_PROBES.find((p) => p.method === method && p.path === apiPath);
}

export interface MalformedUuidProbe {
    method: 'PUT' | 'DELETE';
    /** The API path template with `{x}` for the one non-uuid literal. */
    template: string;
    /** The literals `{x}` may take (never a pattern); none is uuid-like. */
    literals: readonly string[];
    /** Where core answers 422 before any lookup, read or write. */
    proof: string;
}

/**
 * The controller passes the path variable to `SecuredUUID.fromString(uuid)` as the
 * argument of the service call; the constructor throws `ValidationException("Invalid UUID … in the request")` on
 * `UUID.fromString` failure (core security/authz/SecuredUUID), answered as 422
 * (api/ExceptionHandlingAdvice) before any lookup, read or write. A literal that is not uuid-like cannot
 * name an object, and no other mapping under `/v1/groups/` or `/v1/credentials/` matches a one-segment literal other
 * than the `{uuid}` route (interfaces GroupController, CredentialController). Other controllers
 * resolve name-like segments (`/v1/operations/{raProfileName}/…`): never listed here. Re-verify when
 * INTERFACES_REVISION moves (module header).
 */
export const MALFORMED_UUID_PROBES: readonly MalformedUuidProbe[] = [
    { method: 'PUT', template: '/v1/groups/{x}', literals: ['not-a-uuid'], proof: 'GroupControllerImpl editGroup → SecuredUUID.fromString(uuid)' },
    { method: 'DELETE', template: '/v1/groups/{x}', literals: ['not-a-uuid'], proof: 'GroupControllerImpl deleteGroup → SecuredUUID.fromString(uuid)' },
    { method: 'PUT', template: '/v1/credentials/{x}', literals: ['not-a-uuid'], proof: 'CredentialControllerImpl editCredential → SecuredUUID.fromString(uuid)' },
    { method: 'DELETE', template: '/v1/credentials/{x}', literals: ['not-a-uuid'], proof: 'CredentialControllerImpl deleteCredential → SecuredUUID.fromString(uuid)' },
];

/** The MALFORMED_UUID_PROBES entry a method and API path match EXACTLY (template with one listed literal), or undefined. */
export function malformedUuidProbe(method: string, apiPath: string): MalformedUuidProbe | undefined {
    return MALFORMED_UUID_PROBES.find((p) => p.method === method && p.literals.some((l) => p.template.replace('{x}', l) === apiPath));
}

// ------------------------------------------------------------------ route-scoped body field waivers

export interface RouteFieldWaiver {
    method: BulkMethod;
    /** The API path with `{id}` for each uuid path variable (exact). */
    path: string;
    /** The TOP-LEVEL string field whose canonical uuid value may name a non-own object on this route. */
    field: string;
    /** The body condition under which the waiver applies. */
    when: (body: Record<string, unknown>) => boolean;
    /** Core proof: what the request writes, and that it writes nothing on the referenced object. */
    proof: string;
}

/**
 * The provider-rule ruleUuid waiver on an own compliance profile: `PATCH /v2/complianceProfiles/{own}/rules` (interfaces
 * v2/ComplianceProfileController) with a canonical `connectorUuid` names a PROVIDER rule (`ruleUuid`): a catalogue entry of the
 * compliance provider (`GET /v2/complianceProfiles/rules`), not an inventory object. Core
 * `ComplianceProfileServiceImpl.patchComplianceProfileRules` (service/v2/impl/ComplianceProfileServiceImpl) writes only the
 * OWN profile's `compliance_profile_rule` rows (delete + create of the association) after reading the rule from the connector
 * (`ruleHandler.getProviderRule`); nothing is written on the connector or the rule. Without `connectorUuid` the rule is an
 * INTERNAL rule: not waived (probes only, BODY_FIELD_TYPES `ruleUuid: null`). The path target (the profile) stays an own
 * `complianceProfiles` line; the waiver covers the top-level string field only (a list or a nested key is scanned).
 */
export const ROUTE_FIELD_WAIVERS: readonly RouteFieldWaiver[] = [
    {
        method: 'PATCH', path: '/v2/complianceProfiles/{id}/rules', field: 'ruleUuid',
        when: (body) => typeof body.connectorUuid === 'string' && IS_UUID.test(body.connectorUuid),
        proof: 'ComplianceProfileServiceImpl (v2): provider branch writes compliance_profile_rule rows of the path profile only',
    },
];

const ROUTE_WAIVER_RES = ROUTE_FIELD_WAIVERS.map((w) => ({ w, re: new RegExp(`^${w.path.replace(/\{id\}/g, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')}$`) }));

/** The top-level fields waived for a method, API path and (plain object) body: empty for anything else. */
export function routeFieldWaivers(method: string, apiPath: string, body: unknown): ReadonlySet<string> {
    const out = new Set<string>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return out;
    for (const { w, re } of ROUTE_WAIVER_RES) {
        if (w.method === method && re.test(apiPath) && w.when(body as Record<string, unknown>)) out.add(w.field);
    }
    return out;
}

export interface RoutePathWaiver {
    method: BulkMethod;
    /** The API path with `{id}` for each uuid path variable (exact). */
    path: string;
    /** The key path from the body's root to the string field, e.g. `['workflow', 'signatureFormattingConnectorUuid']` (objects only, no list). */
    keyPath: readonly string[];
    /** The body condition under which the waiver applies. */
    when: (body: Record<string, unknown>) => boolean;
    /** Core proof: what the request writes, and that it writes nothing on the referenced object. */
    proof: string;
}

/**
 * Route-scoped waivers of a NESTED reference field (the sibling of ROUTE_FIELD_WAIVERS, whose fields are top-level): the string at
 * `keyPath` may name a non-own object on this route and is neither claimed nor typed (a non-canonical form is still refused; the same
 * field anywhere else, or as a list, is judged as usual).
 * - `POST /v1/signingProfiles`, `workflow.signatureFormattingConnectorUuid` of a timestamping or content-signing workflow
 *   (TimestampingWorkflowRequestDto, ContentSigningWorkflowRequestDto): core `SigningProfileServiceImpl` resolves the connector
 *   (`getConnectorEntity`, read), checks its feature flag (`validateFormattingConnectorFeature`) and stores the reference on the NEW
 *   profile version (`setSignatureFormattingConnector`) and the attribute values under (connector, new profile)
 *   (`persistSignatureFormattingConnectorAttributes`); nothing is written on the connector. The profile's own certificate and
 *   time-quality configuration stay typed and must be own.
 */
export const ROUTE_PATH_WAIVERS: readonly RoutePathWaiver[] = [
    {
        method: 'POST', path: '/v1/signingProfiles', keyPath: ['workflow', 'signatureFormattingConnectorUuid'],
        when: (body) => isPlainObject(body.workflow) && (body.workflow.type === 'timestamping' || body.workflow.type === 'content_signing'),
        proof: 'SigningProfileServiceImpl: reads the connector entity, stores a reference and attribute values on the new profile only',
    },
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The key paths waived for a method, API path and (plain object) body: empty for anything else. */
export function routePathWaivers(method: string, apiPath: string, body: unknown): ReadonlyArray<readonly string[]> {
    if (!isPlainObject(body)) return [];
    return ROUTE_PATH_WAIVERS.filter((w) => w.method === method && w.path === apiPath && w.when(body)).map((w) => w.keyPath);
}

const LIST_BODY_RES = LIST_BODY_TYPES.map((r) => ({ r, re: new RegExp(`^${r.path.replace(/\{id\}/g, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')}$`) }));

/** The typed list-body route of a method and API path, or undefined. */
export function listBodyRoute(method: string, apiPath: string): ListBodyRoute | undefined {
    return LIST_BODY_RES.find(({ r, re }) => r.method === method && re.test(apiPath))?.r;
}

/**
 * GET endpoints that persist something (from a read-only audit of every core `@GetMapping` handler, its
 * `*ControllerImpl` and up to three service levels, core main 2026-10-14). The guard sends them only for OWN objects
 * (`{id}`: must be a canonical uuid of this run, or a probe, with a ledger line of the type the route names;
 * `{parent}`: a canonical uuid, a scope parent), unless `localStack` on a proven local stack; one without an
 * object (`{id}`) is refused. Matched case-SENSITIVELY like Spring's matcher (the guard refuses every
 * other spelling of `/api` and every `;`, `%2f`, `%5c`, `%2e`, `//`, dot segment and backslash in a GET path first)
 * against the DECODED path (the remaining percent-escapes decoded), so `valid%61te` is the same endpoint.
 * - certificates/{id}/validate: stores the validation result, may move ISSUED → REVOKED and fire status-change events;
 * - certificates/{id}/chain[/{format}]: stores issuer links and creates the certificates it downloads through AIA;
 * - authorities/{a}/raProfiles/{id}/caCertificates: saves the CA certificates as new certificate rows;
 * - acmeProfiles/{p}/acmeAccounts/{id}: marks expired orders invalid, updates the account's failed-order count;
 * - secrets/{id}/content: a new secret version when the vault content changed;
 * - tokens/{id}: the token status, refreshed from the connector;
 * - approvals (list, user list, detail): a request filter expires overdue PENDING approvals of every user;
 * - v2 oauth2 providers (list, login): session rows;
 * - proxies/{id}/instructions: calls the provisioning service (its side effects are not visible from core: uncertain).
 * NOT on the list: `v1|v2 connectors/{id}/health` (the read-only core audit found
 * that the handler only reads — it asks the connector for its health and stores nothing — and REG-DEP-01 must read the
 * live health of PRE-EXISTING connectors).
 * NOT on the list (documented deviation): GETs that only cache a connector's ATTRIBUTE DEFINITIONS (the
 * `…/attributes` schema reads keyed by a connector, an authority or a token, and the authority / entity / notification
 * instance detail of an object created before its attributes were stored locally). They change no setting, state or
 * relation of an object, every UI form of the platform triggers them, and they are the read side of creating an own
 * object on a referenced connector (REFERENCE_FIELDS `connectorUuid`), e.g. `createOwnAdcsAuthority`.
 */
export const SIDE_EFFECT_GETS: readonly string[] = [
    '/v1/certificates/{id}/validate', '/v1/certificates/{id}/chain', '/v1/certificates/{id}/chain/{seg}',
    '/v1/authorities/{parent}/raProfiles/{id}/caCertificates', '/v1/acmeProfiles/{parent}/acmeAccounts/{id}',
    '/v1/secrets/{id}/content', '/v1/tokens/{id}',
    '/v1/approvals', '/v1/approvals/user', '/v1/approvals/{id}', '/v2/oauth2/providers', '/v2/oauth2/providers/{seg}/login',
    '/v1/proxies/{id}/instructions',
];

const PLACEHOLDER_UUID = '00000000-0000-0000-0000-000000000000';

const SIDE_EFFECT_RES = SIDE_EFFECT_GETS.map((t) => {
    const roles: Array<'id' | 'parent'> = [];
    const body = t.replace(/\{(id|parent|seg)\}/g, (_m, k: string) => {
        if (k === 'seg') return '[^/]+';
        roles.push(k as 'id' | 'parent');
        return '([^/]+)';
    });
    // The ledger type of each `{id}`, read from the template's literal segments.
    const segs = t.replace(/\{(id|parent)\}/g, PLACEHOLDER_UUID).split('/').filter(Boolean);
    const idTypes = t.split('/').filter(Boolean).flatMap((s, i) => (s === '{id}' ? [resourceTypeAt(segs, i)] : []));
    // Case-sensitive like Spring's matcher: `apiPathOfPathname` is case-sensitive too.
    return { re: new RegExp(`^${body}/?$`), roles, idTypes };
});

/** The API path a server matches: `;` matrix content dropped and percent-escapes decoded per segment. */
export function decodedApiPath(apiPath: string): string {
    return apiPath.split('/').map((s) => {
        const plain = s.replace(/;.*$/, '');
        try {
            return decodeURIComponent(plain);
        } catch {
            return plain;
        }
    }).join('/');
}

/**
 * The objects a side-effect GET names (`ids`: must be own, `types[i]` the ledger type of `ids[i]` — undefined when the
 * suite has none; `parents`: scope parents), or undefined for any other GET.
 */
export function sideEffectGet(apiPath: string): { ids: string[]; types: Array<string | undefined>; parents: string[] } | undefined {
    const path = decodedApiPath(apiPath);
    for (const { re, roles, idTypes } of SIDE_EFFECT_RES) {
        const m = re.exec(path);
        if (!m) continue;
        const ids: string[] = [];
        const parents: string[] = [];
        roles.forEach((r, i) => (r === 'id' ? ids : parents).push(m[i + 1]));
        return { ids, types: [...idTypes], parents };
    }
    return undefined;
}
