/**
 * routes — route tables of the ILM core REST API that the guard needs, derived from the `interfaces` repository.
 * Re-derive them when INTERFACES_REVISION moves; the probe tables are only valid at that revision.
 */

export const INTERFACES_REVISION = '2b7962c7 (2026-10-09)';

export type BulkMethod = 'DELETE' | 'PATCH' | 'PUT' | 'POST';

export interface BulkRoute {
    method: BulkMethod;
    path: string;
    list: 'array' | string;
    fields?: readonly string[];
    dto: string;
    /** Ledger type of the listed uuids; undefined = the suite has none, so the route is refused unless every uuid is a probe. */
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
    arr('PATCH', '/v1/keys/removeFromInventory', 'keys'),
    // Key items: ledger type `keyItems`, children of an own `keys` line.
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
    { method: 'PUT', path: '/v1/tokens/usages', list: 'uuids', fields: ['usage'], dto: 'BulkTokenProfileKeyUsageRequestDto', type: 'tokenProfiles' },
    arr('DELETE', '/v1/tspProfiles', undefined, 'List<UUID>'), arr('PATCH', '/v1/tspProfiles/disable', undefined, 'List<UUID>'),
    arr('PATCH', '/v1/tspProfiles/enable', undefined, 'List<UUID>'),
];

/** The bulk route of a method and API path, or undefined. */
export function bulkRoute(method: string, apiPath: string): BulkRoute | undefined {
    return BULK_ROUTES.find((r) => r.method === method && r.path === apiPath);
}

/** Every literal segment of the core routes plus the path-enum codes. */
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
    'notificationProvider', 'notifications', 'oauth2', 'oauth2Providers', 'objects', 'oids', 'onboard', 'operations', 'order',
    'orders', 'pairs', 'permissions', 'pkiclient.exe', 'platform', 'platformEnums', 'pqcExplanation', 'profile',
    'promote', 'protocols', 'providers', 'proxies', 'purge', 'push', 'random', 'raprofile', 'raProfile', 'raProfiles',
    'readiness', 'reconnect', 'register', 'reject', 'rejectRecipient', 'rekey', 'relations', 'removeFromInventory', 'renew', 'replies',
    'requestAttributes', 'resetPassword', 'resolve', 'resourceEvents', 'resources', 'resume', 'retry', 'revoke',
    'revoke-cert', 'roles', 'rules', 'scep', 'scepProfiles', 'schedule', 'scheduler', 'search', 'searchFilters',
    'secret', 'secrets', 'settings', 'sign', 'signature', 'signatureAttributes', 'signatureFormattingConnectors',
    'signingCertificates', 'signingProfiles', 'signingRecords', 'statistics', 'stop', 'supportedProtocols', 'sync',
    'syncSkips', 'syncVaultProfiles', 'system', 'timeQualityConfigurations', 'tokenKeys', 'tokenProfiles', 'tokens', 'triggers',
    'trustedCertificates', 'tsp', 'tspProfileBasicCredentials', 'tspProfiles', 'types', 'unarchive', 'unresolve',
    'upload', 'usages', 'user', 'users', 'validate', 'validation', 'vaultProfiles', 'vaults', 'verify', 'versions',
    'workflows',
]);

const IS_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Ledger type of a uuid path variable, keyed by the segment before it
 * (`raProfiles`) or the two before it (`acme/activate`). Missing = unresolvable.
 */
export const TARGET_TYPES: Readonly<Record<string, string>> = {
    acmeAccounts: 'acmeAccounts', acmeProfiles: 'acmeProfiles', approvalProfiles: 'approvalProfiles', approvals: 'approvals',
    authorities: 'authorities', certificates: 'certificates', cmpProfiles: 'cmpProfiles', complianceProfiles: 'complianceProfiles',
    connectors: 'connectors', credentials: 'credentials', discoveries: 'discoveries',
    entities: 'entities', groups: 'groups', items: 'keyItems', keys: 'keys', locations: 'locations',
    notificationInstances: 'notificationInstances', notificationProfiles: 'notificationProfiles', raProfiles: 'raProfiles',
    roles: 'roles', scepProfiles: 'scepProfiles', secrets: 'secrets', tokenProfiles: 'tokenProfiles', tokens: 'tokens',
    users: 'users', vaultProfiles: 'vaultProfiles', vaults: 'vaultInstances',
    'attributes/custom': 'customAttributes',
    'workflows/actions': 'actions', 'workflows/conditions': 'conditions', 'workflows/executions': 'executions',
    'workflows/rules': 'rules', 'workflows/triggers': 'triggers',
    'scheduler/jobs': 'scheduledJobs',
    raprofile: 'raProfiles', relations: 'certificates', syncVaultProfiles: 'vaultProfiles',
    'acme/activate': 'acmeProfiles', 'cmp/activate': 'cmpProfiles', 'scep/activate': 'scepProfiles',
    // `signingRecords` stays unmapped: a record has no ledger type.
    signingProfiles: 'signingProfiles', tspProfiles: 'tspProfiles', timeQualityConfigurations: 'timeQualityConfigurations',
    basicCredentials: 'tspBasicCredentials', 'tsp/activate': 'tspProfiles',
};

/** Ledger type of a `Resource` code in a route that takes one before a uuid; codes without a ledger type are unresolvable. */
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

export const ledgerTypeOfResource = (code: unknown): string | undefined =>
    typeof code === 'string' && Object.hasOwn(RESOURCE_TYPES, code) ? RESOURCE_TYPES[code] : undefined;

const RESOURCE_CONTEXT = new Set(['associations', 'comments', 'compliance']);

const own = (table: Readonly<Record<string, string>>, key: string | undefined): string | undefined =>
    key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;

/** The ledger type of the uuid at `segs[i]` (the API path split on `/`), or undefined when the suite has none. */
export function resourceTypeAt(segs: readonly string[], i: number): string | undefined {
    const prev = segs[i - 1];
    const prev2 = segs[i - 2];
    if (prev === 'objects' && segs[i - 3] === 'resources' && segs[i - 4] === 'custom' && segs[i - 5] === 'attributes') return own(RESOURCE_TYPES, prev2);
    if (prev !== undefined && IS_UUID.test(prev) && prev2 === 'objects' && segs[i - 4] === 'resources' && segs[i - 5] === 'custom') return 'customAttributes';
    if (prev2 !== undefined && RESOURCE_CONTEXT.has(prev2)) return own(RESOURCE_TYPES, prev);
    if (prev === undefined || IS_UUID.test(prev)) return undefined;
    return own(TARGET_TYPES, prev2 !== undefined ? `${prev2}/${prev}` : undefined) ?? own(TARGET_TYPES, prev);
}

/** Request DTO field names typed UUID / List<UUID> / Set<UUID>; the guard also counts unpadded 22-character base64 uuids under these keys. */
export const UUID_TYPED_FIELDS: ReadonlySet<string> = new Set([
    'attributeDefinitionUuids', 'eabSecretUuids',
    'altKeyUuid', 'altTokenProfileUuid', 'connectorUuid', 'defaultSigningProfileUuid', 'groupUuid', 'groupUuids', 'groups',
    'interfaceUuid', 'internalRules', 'keyUuid', 'mappedUserUuid', 'notificationInstanceUuid', 'objectUuid', 'ownerUuid',
    'parentUuid', 'raProfileUuid', 'recipientUuids', 'roleUuid', 'ruleUuid', 'sourceCertificateUuid', 'sourceVaultProfileUuid',
    'tokenProfileUuid', 'triggerUuids', 'triggers', 'userUuid', 'uuid', 'uuids', 'vaultProfileUuid',
]);

/**
 * The resource a uuid-bearing request field names, where it is the same in every DTO. A canonical uuid in such a field
 * must be own with a ledger line of this type, or a probe; `null` = no ledger type (probes only).
 */
export const BODY_FIELD_TYPES: Readonly<Record<string, string | null>> = {
    actionsUuids: 'actions',
    altKeyUuid: 'keys',
    altTokenProfileUuid: 'tokenProfiles',
    authorityInstanceUuid: 'authorities',
    caCertificateUuid: 'certificates',
    certificateUuid: 'certificates',
    certificateUuids: 'certificates',
    conditionsUuids: 'conditions',
    connectorUuid: 'connectors',
    customAttributeUuid: 'customAttributes',
    eabSecretUuids: 'secrets',
    executionsUuids: 'executions',
    groupUuids: 'groups',
    keyUuid: 'keys',
    mappedUserUuid: 'users',
    notificationInstanceUuid: 'notificationInstances',
    notificationProfileUuid: 'notificationProfiles',
    ownerUuid: 'users',
    raProfileUuid: 'raProfiles',
    raProfileUuids: 'raProfiles',
    roleUuid: 'roles',
    rulesUuids: 'rules',
    signingCertificateUuid: 'certificates',
    sourceCertificateUuid: 'certificates',
    sourceVaultProfileUuid: 'vaultProfiles',
    tokenProfileUuid: 'tokenProfiles',
    triggerUuids: 'triggers',
    triggers: 'triggers',
    userUuid: 'users',
    vaultProfileUuid: 'vaultProfiles',
    defaultSigningProfileUuid: 'signingProfiles',
    // Found by hand: a polymorphic `workflow` subtype hides these two. The formatting connector may be waived (ROUTE_PATH_WAIVERS).
    timeQualityConfigurationUuid: 'timeQualityConfigurations',
    signatureFormattingConnectorUuid: 'connectors',
    groups: null,
    internalRules: null,
    ruleUuid: null,
    parentUuid: null,
    proxyUuid: null,
};

/** Fields typed by a sibling field that holds a `Resource` code (`objectUuid` + `resource`); an unknown code makes them probes-only. */
export const SIBLING_TYPED_FIELDS: Readonly<Record<string, string>> = { objectUuid: 'resource' };

/** Uuid-bearing fields whose resource differs between DTOs: a uuid under them may be any own object or a probe. */
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

export interface ListBodyRoute {
    method: BulkMethod;
    path: string;
    type: string | null;
    dto: string;
}

/**
 * Routes with a uuid path variable whose body is a top-level uuid list: each listed uuid is own with a ledger line of
 * `type`, or a probe. A top-level uuid list on any other route is refused.
 */
export const LIST_BODY_TYPES: readonly ListBodyRoute[] = [
    { method: 'PATCH', path: '/v1/roles/{id}/users', type: 'users', dto: 'List<String> userUuids (RoleManagementController.updateUsers)' },
    { method: 'PATCH', path: '/v1/users/{id}/roles', type: 'roles', dto: 'List<String> roleUuids (UserManagementController.updateRoles)' },
    { method: 'DELETE', path: '/v1/keys/{id}', type: 'keyItems', dto: 'List<String> keyItemUuids (CryptographicKeyController.deleteKey)' },
    { method: 'PATCH', path: '/v1/keys/{id}/destroy', type: 'keyItems', dto: 'List<String> keyItemUuids (destroyKey)' },
    { method: 'PATCH', path: '/v1/keys/{id}/disable', type: 'keyItems', dto: 'List<String> keyItemUuids (disableKey)' },
    { method: 'PATCH', path: '/v1/keys/{id}/enable', type: 'keyItems', dto: 'List<String> keyItemUuids (enableKey)' },
    { method: 'DELETE', path: '/v1/tokens/{id}/keys/{id}', type: 'keyItems', dto: 'List<String> keyItemUuids (deleteKey)' },
    { method: 'PATCH', path: '/v1/tokens/{id}/keys/{id}/destroy', type: 'keyItems', dto: 'List<String> keyItemUuids (destroyKey)' },
    { method: 'PATCH', path: '/v1/tokens/{id}/keys/{id}/disable', type: 'keyItems', dto: 'List<String> keyItemUuids (disableKey)' },
    { method: 'PATCH', path: '/v1/tokens/{id}/keys/{id}/enable', type: 'keyItems', dto: 'List<String> keyItemUuids (enableKey)' },
];

export interface NoHandlerProbe {
    method: 'POST' | 'DELETE' | 'PUT' | 'PATCH';
    path: string;
    proof: string;
}

/** (method, path) pairs of GET-only controllers: Spring answers 400 before any handler. Sent bodyless as the run's own identity. */
export const NO_HANDLER_PROBES: readonly NoHandlerProbe[] = [
    { method: 'POST', path: '/v1/statistics', proof: 'StatisticsController — @RequestMapping("/v1/statistics"), @GetMapping only' },
    { method: 'DELETE', path: '/v1/info', proof: 'InfoController — @RequestMapping("/v1"), @GetMapping("/info"), health GETs only' },
];

export function noHandlerProbe(method: string, apiPath: string): NoHandlerProbe | undefined {
    return NO_HANDLER_PROBES.find((p) => p.method === method && p.path === apiPath);
}

export interface MalformedUuidProbe {
    method: 'PUT' | 'DELETE';
    template: string;
    literals: readonly string[];
    proof: string;
}

/**
 * Non-uuid literal segments that core rejects with 422 before any lookup
 * or write (`SecuredUUID.fromString`). Never list name-like segments.
 */
export const MALFORMED_UUID_PROBES: readonly MalformedUuidProbe[] = [
    { method: 'PUT', template: '/v1/groups/{x}', literals: ['not-a-uuid'], proof: 'GroupControllerImpl editGroup → SecuredUUID.fromString(uuid)' },
    { method: 'DELETE', template: '/v1/groups/{x}', literals: ['not-a-uuid'], proof: 'GroupControllerImpl deleteGroup → SecuredUUID.fromString(uuid)' },
    { method: 'PUT', template: '/v1/credentials/{x}', literals: ['not-a-uuid'], proof: 'CredentialControllerImpl editCredential → SecuredUUID.fromString(uuid)' },
    { method: 'DELETE', template: '/v1/credentials/{x}', literals: ['not-a-uuid'], proof: 'CredentialControllerImpl deleteCredential → SecuredUUID.fromString(uuid)' },
];

export function malformedUuidProbe(method: string, apiPath: string): MalformedUuidProbe | undefined {
    return MALFORMED_UUID_PROBES.find((p) => p.method === method && p.literals.some((l) => p.template.replace('{x}', l) === apiPath));
}

export interface RouteFieldWaiver {
    method: BulkMethod;
    path: string;
    field: string;
    when: (body: Record<string, unknown>) => boolean;
    proof: string;
}

/**
 * Provider-rule `ruleUuid` waiver: `PATCH /v2/complianceProfiles/{own}/rules` with a `connectorUuid` names a catalogue rule, not an
 * inventory object; only the own profile is written.
 */
export const ROUTE_FIELD_WAIVERS: readonly RouteFieldWaiver[] = [
    {
        method: 'PATCH', path: '/v2/complianceProfiles/{id}/rules', field: 'ruleUuid',
        when: (body) => typeof body.connectorUuid === 'string' && IS_UUID.test(body.connectorUuid),
        proof: 'ComplianceProfileServiceImpl (v2): provider branch writes compliance_profile_rule rows of the path profile only',
    },
];

const ROUTE_WAIVER_RES = ROUTE_FIELD_WAIVERS.map((w) => ({ w, re: new RegExp(`^${w.path.replace(/\{id\}/g, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')}$`) }));

export function routeFieldWaivers(method: string, apiPath: string, body: unknown): ReadonlySet<string> {
    const out = new Set<string>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return out;
    for (const { w, re } of ROUTE_WAIVER_RES) {
        if (w.method === method && re.test(apiPath) && w.when(body as Record<string, unknown>)) out.add(w.field);
    }
    return out;
}

export const LIST_ELEMENT = '\u0000list';

export interface RoutePathWaiver {
    method: BulkMethod;
    path: string;
    keyPath: readonly string[];
    when: (body: Record<string, unknown>) => boolean;
    proof: string;
}

/**
 * Waivers of a nested reference field: the string at `keyPath` may name a
 * non-own object on this route. Core writes only the new profile version.
 */
export const ROUTE_PATH_WAIVERS: readonly RoutePathWaiver[] = [
    {
        method: 'POST', path: '/v1/signingProfiles', keyPath: ['workflow', 'signatureFormattingConnectorUuid'],
        when: (body) => isPlainObject(body.workflow) && (body.workflow.type === 'timestamping' || body.workflow.type === 'content_signing'),
        proof: 'SigningProfileServiceImpl: reads the connector entity, stores a reference and attribute values on the new profile only',
    },
    {
        method: 'POST', path: '/v1/tokens/{id}/tokenProfiles/{id}/tokenKeys/onboard', keyPath: ['keys', LIST_ELEMENT, 'keyPairMeta', LIST_ELEMENT, 'uuid'],
        when: (body) => Array.isArray(body.keys),
        proof: 'TokenKeyOnboardingServiceImpl: keyPairMeta is the connector metadata of a listed pair, sent back to the connector; core resolves no object by its uuid. ' +
            'An onboard into an existing key is matched by public-key fingerprint; the run onboards only pairs it generated on its own token moments before',
    },
];

const PATH_WAIVER_RES = ROUTE_PATH_WAIVERS.map((w) => ({ w, re: new RegExp(`^${w.path.replace(/\{id\}/g, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')}$`) }));

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function routePathWaivers(method: string, apiPath: string, body: unknown): ReadonlyArray<readonly string[]> {
    if (!isPlainObject(body)) return [];
    return PATH_WAIVER_RES.filter(({ w, re }) => w.method === method && re.test(apiPath) && w.when(body)).map(({ w }) => w.keyPath);
}

const LIST_BODY_RES = LIST_BODY_TYPES.map((r) => ({ r, re: new RegExp(`^${r.path.replace(/\{id\}/g, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')}$`) }));

export function listBodyRoute(method: string, apiPath: string): ListBodyRoute | undefined {
    return LIST_BODY_RES.find(({ r, re }) => r.method === method && re.test(apiPath))?.r;
}

/**
 * GET endpoints that persist something (validation results, chain downloads, token refresh, approval expiry, session
 * rows, …). Sent only for own objects or probes, unless `localStack`. Connector health and attribute-definition
 * reads are deliberately not listed: they change no object. Not own-scoped: any request to `/v1/approvals/*` makes core
 * expire every overdue approval of the platform (`ApprovalExpirationFilter`); accepted, core's hourly status task does the same.
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
    const segs = t.replace(/\{(id|parent)\}/g, PLACEHOLDER_UUID).split('/').filter(Boolean);
    const idTypes = t.split('/').filter(Boolean).flatMap((s, i) => (s === '{id}' ? [resourceTypeAt(segs, i)] : []));
    return { re: new RegExp(`^${body}/?$`), roles, idTypes };
});

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
 * The objects a side-effect GET names (`ids` must be own, `types[i]` their
 * ledger type, `parents` scope parents), or undefined for any other GET.
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
