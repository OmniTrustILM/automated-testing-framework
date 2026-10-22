/**
 * listingTables — the listings the contract specs run the oracles on.
 *
 * WHAT: The listings the contract specs run the oracles on (keys, discoveries, audit logs), with the property fields of each
 *       and their verified DTO member, the expected catalogue facts, and the listings that refuse a sort.
 * WHY: Each listing needs its fields with the verified DTO member and the expected catalogue facts.
 * HOW: Tables for keys, discoveries and audit logs, plus the listings that refuse a sort, each field carrying the component that proves its mapping.
 */
import { elementsOf, member, nested } from './values';
import { CatalogueExpectations } from './catalogueContract';
import { ListingSpec } from './listing';

// ====================================================================================================================
// 11. The listings: field tables (each DTO mapping read in core / interfaces; file:line in `evidence`)
// ====================================================================================================================

const KEY_ITEM = 'core CryptographicKeyItem.mapToSummaryDto (dao/entity/CryptographicKeyItem.java) → interfaces KeyItemDto';
const DISCOVERY_ROW = 'core DiscoveryDtoMapper.toListDto (:91-104) → interfaces DiscoveryListDto';
const AUDIT_ROW = 'core AuditLog.mapToDto (dao/entity/AuditLog.java) → interfaces AuditLogDto, LogRecord records';

/** `POST /api/v1/keys`: the rows are KEY ITEMS (`cryptographicKeys[]`, CryptographicKeyServiceImpl.java). */
export const KEYS: ListingSpec = {
    name: 'keys',
    searchUrl: '/api/v1/keys',
    catalogueUrl: '/api/v1/keys/search',
    rowsMember: 'cryptographicKeys',
    rowKey: (r) => String(r.uuid),
    configurable: true,
    refusalLabel: 'Key',
    maxWalkRows: 1000,
    fields: [
        { id: 'CKI_NAME', type: 'string', kind: 'string', shape: 'text', get: member('name'), sortable: true, sort: 'text', evidence: `${KEY_ITEM}: name; FilterField.java` },
        { id: 'CKI_TYPE', type: 'list', kind: 'list', shape: 'code', get: member('type'), sortable: true, sort: 'structure', evidence: `${KEY_ITEM}: type (code); FilterField.java` },
        { id: 'CKI_FORMAT', type: 'list', kind: 'list', shape: 'code', get: member('format'), sortable: true, sort: 'structure', evidence: `${KEY_ITEM}: format; FilterField.java` },
        { id: 'CKI_STATE', type: 'list', kind: 'list', shape: 'code', get: member('state'), sortable: true, sort: 'structure', evidence: `${KEY_ITEM}: state; FilterField.java` },
        { id: 'CKI_CRYPTOGRAPHIC_ALGORITHM', type: 'list', kind: 'list', shape: 'code', get: member('keyAlgorithm'), sortable: true, sort: 'structure', evidence: `${KEY_ITEM}: keyAlgorithm; FilterField.java` },
        // KeyUsage is a BitMaskEnum: EMPTY = bit mask 0 (FilterPredicatesBuilder.java), EQUALS = the bit is set; not sortable (SearchHelper.isBitMaskField :336-340).
        { id: 'CKI_USAGE', type: 'list', kind: 'list', shape: 'code', get: member('usage'), sortable: false, sort: 'none', evidence: `${KEY_ITEM}: usage (KeyUsage codes of the bit mask); FilterField.java` },
        { id: 'CKI_LENGTH', type: 'number', kind: 'number', shape: 'number', get: member('length'), sortable: true, sort: 'number', evidence: `${KEY_ITEM}: length (nullable Integer); FilterField.java` },
        { id: 'CKI_ENABLED', type: 'boolean', kind: 'boolean', shape: 'boolean', get: member('enabled'), sortable: true, sort: 'boolean', evidence: `${KEY_ITEM}: enabled (primitive; the column is primitive too, CryptographicKeyItem.java); FilterField.java` },
        { id: 'CKI_CREATED', type: 'datetime', kind: 'date', shape: 'datetime', get: member('creationTime'), sortable: true, sort: 'datetime', evidence: `${KEY_ITEM}: creationTime = the key's created; FilterField.java "the key's created, not the item's"` },
        { id: 'CK_TOKEN_PROFILE', type: 'list', kind: 'list', shape: 'code', get: member('tokenProfileName'), sortable: true, sort: 'text', evidence: `${KEY_ITEM}: tokenProfileName; FilterField.java` },
        { id: 'CK_TOKEN_INSTANCE', type: 'list', kind: 'list', shape: 'code', get: member('tokenInstanceName'), sortable: true, sort: 'text', evidence: `${KEY_ITEM}: tokenInstanceName; FilterField.java` },
        { id: 'CK_GROUP', type: 'list', kind: 'collection', shape: 'code', get: elementsOf(['groups'], 'name'), sortable: true, sort: 'minMaxText', evidence: `${KEY_ITEM}: groups[].name; FilterField.java (a collection join: COUNT_*)` },
        { id: 'CK_OWNER', type: 'list', kind: 'list', shape: 'code', get: member('owner'), sortable: true, sort: 'text', evidence: `${KEY_ITEM}: owner = ownerUsername; FilterField.java` },
    ],
};

/** `POST /api/v1/discoveries/list` (DiscoveryServiceImpl.java). */
export const DISCOVERIES: ListingSpec = {
    name: 'discoveries',
    searchUrl: '/api/v1/discoveries/list',
    catalogueUrl: '/api/v1/discoveries/search',
    rowsMember: 'discoveries',
    rowKey: (r) => String(r.uuid),
    configurable: true,
    refusalLabel: 'Discovery',
    maxWalkRows: 1000,
    fields: [
        { id: 'DISCOVERY_NAME', type: 'string', kind: 'string', shape: 'text', get: member('name'), sortable: true, sort: 'text', evidence: `${DISCOVERY_ROW}: name; FilterField.java` },
        { id: 'DISCOVERY_START_TIME', type: 'datetime', kind: 'date', shape: 'datetime', get: member('startTime'), sortable: true, sort: 'datetime', evidence: `${DISCOVERY_ROW}: startTime (nullable); FilterField.java` },
        { id: 'DISCOVERY_END_TIME', type: 'datetime', kind: 'date', shape: 'datetime', get: member('endTime'), sortable: true, sort: 'datetime', evidence: `${DISCOVERY_ROW}: endTime (nullable); FilterField.java` },
        { id: 'DISCOVERY_STATUS', type: 'list', kind: 'list', shape: 'code', get: member('status'), sortable: true, sort: 'structure', evidence: `${DISCOVERY_ROW}: status (code); FilterField.java` },
        { id: 'DISCOVERY_TOTAL_CERT_DISCOVERED', type: 'number', kind: 'number', shape: 'number', get: member('totalCertificatesDiscovered'), sortable: true, sort: 'number', evidence: `${DISCOVERY_ROW}: totalCertificatesDiscovered (nullable Integer); FilterField.java` },
        { id: 'DISCOVERY_CONNECTOR_NAME', type: 'list', kind: 'list', shape: 'code', get: member('connectorName'), sortable: true, sort: 'text', evidence: `${DISCOVERY_ROW}: connectorName; FilterField.java` },
        { id: 'DISCOVERY_KIND', type: 'string', kind: 'string', shape: 'text', get: member('kind'), sortable: true, sort: 'text', evidence: `${DISCOVERY_ROW}: kind (absent for a v2 run: JsonInclude NON_NULL); FilterField.java` },
    ],
};

/**
 * `POST /api/v1/auditLogs` (AuditLogServiceImpl.java): rows `items[]`, newest first (id desc), NO sort (any sort is refused).
 * The enum columns are stored by name and filtered by CODE (FilterPredicatesBuilder.findEnumByCustomValue :1167-1173).
 */
export const AUDIT_LOGS: ListingSpec = {
    name: 'auditLogs',
    searchUrl: '/api/v1/auditLogs',
    catalogueUrl: '/api/v1/auditLogs/search',
    rowsMember: 'items',
    rowKey: (r) => String(r.id),
    configurable: false,
    refusalLabel: 'Audit logs',
    maxWalkRows: 1000,
    fields: [
        { id: 'AUDIT_LOG_TIMESTAMP', type: 'datetime', kind: 'date', shape: 'datetime', get: member('timestamp'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: timestamp; FilterField.java` },
        { id: 'AUDIT_LOG_MODULE', type: 'list', kind: 'list', shape: 'code', get: member('module'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: module; FilterField.java` },
        { id: 'AUDIT_LOG_ACTOR_TYPE', type: 'list', kind: 'list', shape: 'code', get: nested('actor', 'type'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: actor.type (AuditLog.fromLogRecord :155); FilterField.java` },
        { id: 'AUDIT_LOG_ACTOR_NAME', type: 'string', kind: 'string', shape: 'text', get: nested('actor', 'name'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: actor.name; FilterField.java` },
        { id: 'AUDIT_LOG_ACTOR_AUTH_METHOD', type: 'list', kind: 'list', shape: 'code', get: nested('actor', 'authMethod'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: actor.authMethod; FilterField.java` },
        { id: 'AUDIT_LOG_RESOURCE', type: 'list', kind: 'list', shape: 'code', get: nested('resource', 'type'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: resource.type; FilterField.java` },
        { id: 'AUDIT_LOG_AFFILIATED_RESOURCE', type: 'list', kind: 'list', shape: 'code', get: nested('affiliatedResource', 'type'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: affiliatedResource.type; FilterField.java` },
        { id: 'AUDIT_LOG_OPERATION', type: 'list', kind: 'list', shape: 'code', get: member('operation'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: operation; FilterField.java` },
        { id: 'AUDIT_LOG_OPERATION_RESULT', type: 'list', kind: 'list', shape: 'code', get: member('operationResult'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: operationResult; FilterField.java` },
        { id: 'AUDIT_LOG_SOURCE_IP_ADDRESS', type: 'string', kind: 'string', shape: 'text', get: nested('source', 'ipAddress'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: source.ipAddress (JSON path logRecord.source.ipAddress); FilterField.java` },
        { id: 'AUDIT_LOG_SOURCE_PATH', type: 'string', kind: 'string', shape: 'text', get: nested('source', 'path'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: source.path (JSON path); FilterField.java` },
        { id: 'AUDIT_LOG_MESSAGE', type: 'string', kind: 'string', shape: 'text', get: member('message'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: message; FilterField.java` },
        { id: 'AUDIT_LOG_RESOURCE_UUID', type: 'string', kind: 'jsonArray', shape: 'code', get: elementsOf(['resource', 'objects'], 'uuid'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: resource.objects[].uuid (JSON array path; EQUALS = array contains, EMPTY = [] / [null] / null, FilterPredicatesBuilder.java, :1151-1156); FilterField.java` },
        { id: 'AUDIT_LOG_RESOURCE_NAME', type: 'string', kind: 'jsonArray', shape: 'code', get: elementsOf(['resource', 'objects'], 'name'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: resource.objects[].name; FilterField.java` },
        { id: 'AUDIT_LOG_AFFILIATED_RESOURCE_UUID', type: 'string', kind: 'jsonArray', shape: 'code', get: elementsOf(['affiliatedResource', 'objects'], 'uuid'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: affiliatedResource.objects[].uuid; FilterField.java` },
        { id: 'AUDIT_LOG_AFFILIATED_RESOURCE_NAME', type: 'string', kind: 'jsonArray', shape: 'code', get: elementsOf(['affiliatedResource', 'objects'], 'name'), sortable: false, sort: 'none', evidence: `${AUDIT_ROW}: affiliatedResource.objects[].name; FilterField.java` },
    ],
};

/** The catalogue expectations of a listing derived from its field table (the known fields must be published exactly so). */
export function expectationsOf(spec: ListingSpec, onlyProperty = false): CatalogueExpectations {
    return {
        configurable: spec.configurable,
        onlyProperty,
        known: Object.fromEntries(spec.fields.map((x) => [x.id, { type: x.type, kind: x.kind, sortable: x.sortable }])),
    };
}

/** The searchable-fields catalogues of every resource with one (`GET <listing>/search`; interfaces core/web/*Controller.java). */
export interface CatalogueRow {
    name: string;
    url: string;
    /** SearchHelper.CONFIGURABLE_COLUMN_RESOURCES. */
    configurable: boolean;
    /** The listing table, when the area owns its oracles (keys, discoveries, audit logs). */
    listing?: ListingSpec;
    onlyProperty?: boolean;
    /** Not named in the ledger row of API-GEN-12 (an extra resource with a catalogue). */
    extra?: boolean;
}

export const CATALOGUES: readonly CatalogueRow[] = [
    { name: 'keys', url: KEYS.catalogueUrl, configurable: true, listing: KEYS },
    { name: 'discoveries', url: DISCOVERIES.catalogueUrl, configurable: true, listing: DISCOVERIES },
    { name: 'auditLogs', url: AUDIT_LOGS.catalogueUrl, configurable: false, listing: AUDIT_LOGS, onlyProperty: true },
    { name: 'oids', url: '/api/v1/oids/search', configurable: false },
    { name: 'locations', url: '/api/v1/locations/search', configurable: false },
    { name: 'secrets', url: '/api/v1/secrets/search', configurable: true },
    { name: 'connectorsV2', url: '/api/v2/connectors/search', configurable: true },
    { name: 'signingRecords', url: '/api/v1/signingRecords/search', configurable: true },
    { name: 'vaults', url: '/api/v1/vaults/search', configurable: false },
    { name: 'vaultProfiles', url: '/api/v1/vaultProfiles/search', configurable: false },
    { name: 'signingProfiles', url: '/api/v1/signingProfiles/search', configurable: false },
    { name: 'tspProfiles', url: '/api/v1/tspProfiles/search', configurable: false },
    { name: 'cryptoAssets', url: '/api/v1/cryptoAssets/search', configurable: true },
    { name: 'entities', url: '/api/v1/entities/search', configurable: false },
    { name: 'certificates', url: '/api/v1/certificates/search', configurable: true },
    { name: 'cboms', url: '/api/v1/cboms/search', configurable: true, extra: true },
    { name: 'timeQualityConfigurations', url: '/api/v1/timeQualityConfigurations/search', configurable: false, extra: true },
];

/** The listings that refuse ANY sort (Resource not in CONFIGURABLE_COLUMN_RESOURCES): `POST <url>` and the label of the refusal text. */
export const SORT_REFUSING_LISTINGS: ReadonlyArray<{ name: string; url: string; label: string; evidence: string }> = [
    { name: 'auditLogs', url: AUDIT_LOGS.searchUrl, label: 'Audit logs', evidence: 'AuditLogServiceImpl.java; Resource.AUDIT_LOG "Audit logs" (Resource.java)' },
    { name: 'oids', url: '/api/v1/oids/list', label: 'OID', evidence: 'CustomOidEntryServiceImpl.java; Resource.OID "OID" (Resource.java); OID is not in SearchHelper.CONFIGURABLE_COLUMN_RESOURCES' },
    { name: 'locations', url: '/api/v1/locations', label: 'Location', evidence: 'LocationServiceImpl.java; Resource.LOCATION "Location" (Resource.java)' },
    { name: 'entities', url: '/api/v1/entities/list', label: 'Entity', evidence: 'EntityInstanceServiceImpl.java; Resource.ENTITY "Entity" (Resource.java)' },
    { name: 'vaults', url: '/api/v1/vaults/list', label: 'Vault', evidence: 'VaultInstanceServiceImpl.java; Resource.VAULT "Vault" (Resource.java)' },
    { name: 'vaultProfiles', url: '/api/v1/vaultProfiles/list', label: 'Vault Profile', evidence: 'VaultProfileServiceImpl.java; Resource.VAULT_PROFILE "Vault Profile" (Resource.java)' },
];
