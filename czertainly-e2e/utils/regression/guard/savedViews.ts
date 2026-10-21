/**
 * Saved views: `POST /v1/listViews` is an allow-listed create (ledger type `savedViews`, id-named); `PUT` and
 * `DELETE /v1/listViews/{own}` were already own-target routes (TARGET_TYPES `listViews` → savedViews).
 *
 * Core (interfaces ListViewController.java:34-80; core ListViewServiceImpl.java:124-183): a view belongs to the logged-in
 * user and one resource; create / edit / delete act on the caller's own views only (another user's view answers 404,
 * :257-267). The one write on OTHER rows: a view saved with `defaultView: true` clears the default flag of every other
 * view of the same user and resource (ListViewWriter.java:30-43 → ListViewRepository.java:32-37 `clearDefaultExcept`).
 *
 * The body shape a saved view needs (ListViewRequestDto / ListViewUpdateRequestDto): a JSON object with `name` (a string
 * carrying the run prefix `<run id>-`, so the teardown can prove the live view own), `resource` (create only: a
 * Resource code string), `columns` (a list), `filters` (a list or null), `sort` (an object or null) and `defaultView`
 * (a boolean); no other key. Uuids inside it follow the guard's body rules unchanged (own or a probe; nothing new is
 * waived: column / filter `attributeDefinitionUuids` are READ_ONLY and ignored by core, and stay own-or-probe).
 * `defaultView: true` is sent on a shared tier only while no OTHER view of that user and resource is a default unless it
 * is an own `savedViews` line of this run (read live: `GET /v1/listViews?resource=…`, a read, ListViewServiceImpl.java:93-122).
 */
import { UUID } from './uuids';
import { isPlainObject } from './targets';
import type { BodyView } from './bodies';

export const SAVED_VIEW_CREATE = '/v1/listViews';
export const SAVED_VIEW_TARGET = new RegExp(`^/v1/listViews/(${UUID})$`);

/**
 * Every code of the `Resource` enum (interfaces model/core/auth/Resource.java, 67 entries at 2b7962c7); core reads the
 * view's `resource` with `Resource.findByCode` (:238-245), an exact, case-sensitive match. Re-derive with the interfaces.
 */
const RESOURCE_CODES: ReadonlySet<string> = new Set([
    'ANY', 'NONE', 'acmeAccounts', 'acmeAuthorizations', 'acmeChallenges', 'acmeOrders', 'acmeProfiles', 'actions',
    'approvalProfiles', 'approvals', 'attributes', 'auditLogs', 'authenticationProviders', 'authorities', 'cboms',
    'certificateRequests', 'certificates', 'cmpProfiles', 'cmpTransactions', 'comments', 'complianceGroups',
    'complianceProfiles', 'complianceRules', 'conditions', 'connectors', 'credentials', 'cryptoAssets',
    'customAttributes', 'dashboard', 'discoveries', 'endEntityProfiles', 'entities', 'executions', 'globalMetadata',
    'groups', 'jobs', 'keyItems', 'keys', 'listViews', 'locations', 'notificationInstances', 'notificationProfiles',
    'notifications', 'oids', 'platformEnums', 'proxies', 'raProfiles', 'resourceEvents', 'resources', 'roles',
    'rules', 'scepProfiles', 'searchFilters', 'secrets', 'settings', 'signingProfiles', 'signingRecords',
    'timeQualityConfigurations', 'tokenProfiles', 'tokens', 'triggers', 'trustedCertificates',
    'tspProfileBasicCredentials', 'tspProfiles', 'users', 'vaultProfiles', 'vaults',
]);

const CREATE_KEYS = new Set(['name', 'resource', 'columns', 'filters', 'sort', 'defaultView']);
const UPDATE_KEYS = new Set(['name', 'columns', 'filters', 'sort', 'defaultView']);

/** Why a saved-view create / update body has the wrong shape, or undefined. */
export function savedViewBodyProblem(view: BodyView, mode: 'create' | 'update', runId: string): string | undefined {
    const where = `${mode === 'create' ? 'POST /v1/listViews' : 'PUT /v1/listViews/{own}'} (saved view)`;
    if (view.kind !== 'json' || !isPlainObject(view.value)) return `${where}: the body must be a JSON object`;
    const body = view.value;
    const allowed = mode === 'create' ? CREATE_KEYS : UPDATE_KEYS;
    const extra = Object.keys(body).filter((k) => !allowed.has(k));
    if (extra.length) return `${where}: a key the saved view does not have (${extra.slice(0, 3).map((k) => JSON.stringify(k.slice(0, 24))).join(', ')})`;
    if (typeof body.name !== 'string' || !body.name.startsWith(`${runId}-`)) return `${where}: "name" must carry the run prefix ${runId}-`;
    if (mode === 'create' && (typeof body.resource !== 'string' || !RESOURCE_CODES.has(body.resource))) return `${where}: "resource" must be a Resource code`;
    if (body.columns !== undefined && !Array.isArray(body.columns)) return `${where}: "columns" must be a list`;
    if (body.filters !== undefined && body.filters !== null && !Array.isArray(body.filters)) return `${where}: "filters" must be a list or null`;
    if (body.sort !== undefined && body.sort !== null && !isPlainObject(body.sort)) return `${where}: "sort" must be an object or null`;
    if (body.defaultView !== undefined && typeof body.defaultView !== 'boolean') return `${where}: "defaultView" must be a boolean`;
    return undefined;
}

/** A row of `GET /v1/listViews` (ListViewDto) as far as the default check reads it. */
export interface ViewRow {
    uuid: string;
    resource: string;
    defaultView: boolean;
}

/** The rows of a `GET /v1/listViews` answer, or undefined when it is not a list of view rows. */
export function viewRowsOf(body: unknown): ViewRow[] | undefined {
    if (!Array.isArray(body)) return undefined;
    const rows: ViewRow[] = [];
    for (const r of body) {
        if (!isPlainObject(r) || typeof r.uuid !== 'string' || typeof r.resource !== 'string' || typeof r.defaultView !== 'boolean') return undefined;
        rows.push({ uuid: r.uuid.toLowerCase(), resource: r.resource, defaultView: r.defaultView });
    }
    return rows;
}

/**
 * The OTHER default views of `resource` (not `target`) whose default flag a `defaultView: true` save would clear and
 * that are not own (`isOwnView`): empty = the save touches no pre-existing view.
 */
export function foreignDefaultViews(rows: readonly ViewRow[], resource: string, target: string | undefined, isOwnView: (uuid: string) => boolean): string[] {
    return rows.filter((r) => r.resource === resource && r.defaultView && r.uuid !== target && !isOwnView(r.uuid)).map((r) => r.uuid);
}
