/**
 * resourceTypes — the registry of every ledger resource type the regression and API suites can create.
 *
 * WHAT: one entry per ledger type with everything the safety layers need to know about it: the step the teardown deletes it
 * in and the module whose handler deletes it, how its ownership is proven (a live read of the object's own name, or the
 * ledger line alone for an id-named type), how the non-interference snapshot sees it (a resource definition, an explicit
 * gap, or the type that covers it), and the path an own delete is allowed on, if any.
 *
 * WHY: a new type used to be added by hand to a delete-order table, a handler map, a live-read table, an id-named list, a
 * snapshot resource list and a gap list, and nothing proved that the lists agreed. Now a type is added here once; the tables
 * the teardown (`teardown/runTeardown.ts`), the ownership check (`ledger/ownership.ts`), the snapshot
 * (`teardown/snapshotModel.ts`) and `ownCrud.ts` use are derived from it, and `tests/unit/resourceTypes.spec.ts` checks that
 * every entry is complete. The guard's own tables (`guard/routes.ts`, `guard/allowLists.ts`) stay literal and deny-by-default;
 * a unit test checks that every type they name is a type of this registry.
 *
 * HOW: data only (no I/O, no handler code: a handler module is named by a key that `runTeardown` maps to an import). The
 * ARRAY ORDER is the delete order: entries are grouped by teardown step and, inside a step, deleted in the listed order
 * (dependants before what they depend on; the reference graph core enforces is `REFERENCED_BY` in runTeardown).
 */
import { TIMESTAMPING_REGISTRY_ENTRIES } from '../timestamping/resourceTypes';
import {
    certMarker, discoveryMarker, enabledMarker, foreignKeyRows, keyItemsDelta, keyMarksFromDetail, keyWindowCuts, keyWrapperOf, ResourceDef,
} from './teardown/snapshotModel';

/** The module that exports the `teardownHandlers` of a type (runTeardown maps each key to its import). */
export type HandlerModule = 'core' | 'lifecycle' | 'workflow' | 'notification' | 'protocols' | 'platform' | 'inventory' | 'scheduler' | 'timestamping';

/**
 * How the live object of a named type is read before anything is done to it. `{uuid}` and `{parent}` stand for the object's
 * uuid and its parent's uuid. The live name that must carry the run prefix is `nameField` (default `name`).
 */
export type LiveReadSpec =
    /** `GET <url>`. */
    | { kind: 'detail'; url: string; nameField?: string }
    /** `GET <url>` under the parent named by the ledger line (`parents.<parent>`); no parent on the line: not readable. */
    | { kind: 'parent'; parent: string; url: string; nameField?: string }
    /** As `parent`, but a line without the parent finds it by reading `listUrl` (`listParentField` of the row with this uuid). */
    | { kind: 'parent-or-list'; parent: string; listUrl: string; listParentField: string; url: string };

/** Ownership of a type: a live read of the object's name, or the ledger line alone (the platform names the object by an id). */
export type Ownership = LiveReadSpec | { kind: 'id-named' };

/**
 * How the non-interference snapshot sees a type: `def` (how to read and mark it; the ledger type is the entry's `type`),
 * `gap` (not snapshotted, and why) or `coveredBy` (not snapshotted because another resource's snapshot covers it).
 */
export type SnapshotEntry = { def: Omit<ResourceDef, 'type'> } | { gap: string } | { coveredBy: string };

export interface ResourceTypeEntry {
    /** The ledger type: one spelling everywhere. */
    type: string;
    teardown: { step: number; handler: HandlerModule };
    ownership: Ownership;
    snapshot: SnapshotEntry;
    /** The collection path `deleteOwn` may delete on (a delete that is itself the behaviour under test). */
    ownDeletePath?: string;
}

/** The label of each teardown step (what the step removes and why it sits where it does). */
export const TEARDOWN_STEPS: ReadonlyArray<{ step: number; label: string }> = [
    { step: 1, label: 'pending approvals of own certificates (reject through the override path)' },
    { step: 2, label: 'object-level event associations on own objects' },
    {
        step: 3,
        label: 'discoveries (their new certificates become derived lines first); timestamping block: Basic credentials → TSP profiles ' +
            '(activation removed, credential secrets awaited) → signing profiles (signing records emptied) → time-quality configurations',
    },
    { step: 4, label: 'certificates, own and derived (own RA profiles ungated from own approval profiles first: PRE_STEPS)' },
    { step: 5, label: 'keys' },
    { step: 6, label: 'key items (gone with their key; a remaining item is reported)' },
    { step: 7, label: 'protocol profiles (deactivate, disable, delete); ACME accounts go with their profile' },
    { step: 8, label: 'triggers → rules → conditions → actions → executions' },
    { step: 9, label: 'notification profiles → instances' },
    { step: 10, label: 'compliance profiles (own RA associations removed first) → RA profiles → authorities → credentials → connectors this run registered' },
    { step: 11, label: 'token profiles → tokens' },
    { step: 12, label: 'users (removed from their roles first) → roles → groups → custom attributes → OID entries' },
    { step: 13, label: 'entities, locations, vault secrets → profiles → vaults, approval profiles (compliance profiles go in step 10, before the RA profiles)' },
    { step: 14, label: 'scheduled jobs (@local only)' },
];

/** Keeps the entry literal types (so `ownDeletePath` yields the union of deletable types) and checks the shape. */
function defineResourceTypes<const T extends readonly ResourceTypeEntry[]>(entries: T): T {
    return entries;
}

const detail = (url: string, nameField?: string): LiveReadSpec => ({ kind: 'detail', url, ...(nameField ? { nameField } : {}) });
const idNamed: Ownership = { kind: 'id-named' };

export const RESOURCE_REGISTRY = defineResourceTypes([
    // ---- step 1-2: approvals and event associations (the ledger line alone proves them own)
    {
        type: 'approvals', teardown: { step: 1, handler: 'lifecycle' }, ownership: idNamed,
        snapshot: { gap: 'requests of certificates; their decisions are covered by the certificate state marker' },
    },
    {
        type: 'eventAssociations', teardown: { step: 2, handler: 'workflow' }, ownership: idNamed,
        snapshot: { coveredBy: 'platformEvents: the platform-level association map is compared as one canonical JSON; an object-level association goes with its object' },
    },
    // ---- step 3-6: discoveries, certificates, keys, key items
    {
        type: 'discoveries', teardown: { step: 3, handler: 'core' }, ownership: detail('/api/v1/discoveries/{uuid}'),
        snapshot: {
            def: {
                read: 'search', path: '/api/v1/discoveries/list', itemsKey: 'discoveries', large: true,
                name: (i) => i.name ?? '', marker: discoveryMarker, detail: (u) => `/api/v1/discoveries/${u}`, detailMarker: discoveryMarker,
            },
        },
    },
    // The timestamping block's four types, in delete order after `discoveries` (utils/timestamping/resourceTypes.ts); the
    // handlers are in utils/timestamping/teardown.ts, every type is @local only.
    ...TIMESTAMPING_REGISTRY_ENTRIES,
    {
        type: 'certificates', teardown: { step: 4, handler: 'core' }, ownership: detail('/api/v1/certificates/{uuid}', 'commonName'),
        snapshot: {
            def: {
                read: 'search', path: '/api/v1/certificates', itemsKey: 'certificates', body: { includeArchived: true }, large: true,
                name: (i) => i.commonName ?? '', marker: certMarker, detail: (u) => `/api/v1/certificates/${u}`, detailMarker: certMarker,
            },
        },
    },
    {
        // One row per key ITEM (its name is the item's); grouped by wrapper, marked by keyMarksFromRows / keyMarksFromDetail.
        // KeyDetailDto.creationTime (interfaces model/core/cryptography/key/KeyDetailDto.java:26-28) proves a key new.
        type: 'keys', ownDeletePath: '/api/v1/keys', teardown: { step: 5, handler: 'core' }, ownership: detail('/api/v1/keys/{uuid}'),
        snapshot: {
            def: {
                read: 'search', path: '/api/v1/keys', itemsKey: 'cryptographicKeys', large: true, detailCreated: (d) => (typeof d?.creationTime === 'string' ? d.creationTime : undefined),
                name: (i) => i.name ?? '', uuid: keyWrapperOf, detail: (u) => `/api/v1/keys/${u}`, detailMark: keyMarksFromDetail,
                foreign: foreignKeyRows, windowCuts: keyWindowCuts, delta: keyItemsDelta,
            },
        },
    },
    {
        // A key item under its parent key (ledger `parents.key`; no parent → not readable → missing).
        // `GET /v1/keys/{uuid}/items/{keyItemUuid}` (interfaces CryptographicKeyController.java:140) only reads
        // (core CryptographicKeyServiceImpl.java:421-432); KeyItemDetailDto extends NameAndUuidDto: `name` is the key's name.
        type: 'keyItems', teardown: { step: 6, handler: 'core' }, ownership: { kind: 'parent', parent: 'key', url: '/api/v1/keys/{parent}/items/{uuid}' },
        snapshot: { coveredBy: 'keys: a key search lists one row per key item, so the keys total counts them' },
    },
    // ---- step 7: protocol profiles
    {
        type: 'acmeProfiles', teardown: { step: 7, handler: 'core' }, ownership: detail('/api/v1/acmeProfiles/{uuid}'),
        snapshot: { def: { read: 'list', path: '/api/v1/acmeProfiles', name: (i) => i.name, marker: enabledMarker } },
    },
    {
        type: 'acmeAccounts', teardown: { step: 7, handler: 'core' }, ownership: idNamed,
        snapshot: { gap: 'no name to tell own from foreign; an account changes only through its own ACME client or its profile' },
    },
    {
        type: 'scepProfiles', teardown: { step: 7, handler: 'protocols' }, ownership: detail('/api/v1/scepProfiles/{uuid}'),
        snapshot: { def: { read: 'list', path: '/api/v1/scepProfiles', name: (i) => i.name, marker: enabledMarker } },
    },
    {
        type: 'cmpProfiles', teardown: { step: 7, handler: 'protocols' }, ownership: detail('/api/v1/cmpProfiles/{uuid}'),
        snapshot: { def: { read: 'list', path: '/api/v1/cmpProfiles', name: (i) => i.name, marker: enabledMarker } },
    },
    // ---- step 8: workflows (triggers → rules → conditions → actions → executions)
    {
        type: 'triggers', teardown: { step: 8, handler: 'workflow' }, ownership: detail('/api/v1/workflows/triggers/{uuid}'),
        ownDeletePath: '/api/v1/workflows/triggers',
        snapshot: { def: { read: 'list', path: '/api/v1/workflows/triggers', name: (i) => i.name, marker: (i) => `ignore=${i.ignoreTrigger}` } },
    },
    {
        type: 'rules', teardown: { step: 8, handler: 'workflow' }, ownership: detail('/api/v1/workflows/rules/{uuid}'),
        ownDeletePath: '/api/v1/workflows/rules',
        snapshot: { def: { read: 'list', path: '/api/v1/workflows/rules', name: (i) => i.name } },
    },
    {
        type: 'conditions', teardown: { step: 8, handler: 'workflow' }, ownership: detail('/api/v1/workflows/conditions/{uuid}'),
        ownDeletePath: '/api/v1/workflows/conditions',
        snapshot: { def: { read: 'list', path: '/api/v1/workflows/conditions', name: (i) => i.name } },
    },
    {
        type: 'actions', teardown: { step: 8, handler: 'workflow' }, ownership: detail('/api/v1/workflows/actions/{uuid}'),
        ownDeletePath: '/api/v1/workflows/actions',
        snapshot: { def: { read: 'list', path: '/api/v1/workflows/actions', name: (i) => i.name } },
    },
    {
        type: 'executions', teardown: { step: 8, handler: 'workflow' }, ownership: detail('/api/v1/workflows/executions/{uuid}'),
        ownDeletePath: '/api/v1/workflows/executions',
        snapshot: { def: { read: 'list', path: '/api/v1/workflows/executions', name: (i) => i.name } },
    },
    // ---- step 9: notifications
    {
        type: 'notificationProfiles', teardown: { step: 9, handler: 'notification' }, ownership: detail('/api/v1/notificationProfiles/{uuid}'),
        ownDeletePath: '/api/v1/notificationProfiles',
        snapshot: { def: { read: 'paged', path: '/api/v1/notificationProfiles', itemsKey: 'notificationProfiles', name: (i) => i.name, marker: (i) => `v${i.version}` } },
    },
    {
        type: 'notificationInstances', teardown: { step: 9, handler: 'notification' }, ownership: detail('/api/v1/notificationInstances/{uuid}'),
        ownDeletePath: '/api/v1/notificationInstances',
        snapshot: { def: { read: 'list', path: '/api/v1/notificationInstances', name: (i) => i.name } },
    },
    // ---- step 10: compliance profiles, RA profiles, authorities, credentials, connectors
    {
        type: 'complianceProfiles', teardown: { step: 10, handler: 'platform' }, ownership: detail('/api/v1/complianceProfiles/{uuid}'),
        snapshot: { def: { read: 'list', path: '/api/v1/complianceProfiles', name: (i) => i.name } },
    },
    {
        type: 'raProfiles', teardown: { step: 10, handler: 'core' }, ownership: detail('/api/v1/raProfiles/{uuid}'),
        snapshot: { def: { read: 'list', path: '/api/v1/raProfiles', name: (i) => i.name, marker: enabledMarker } },
    },
    {
        type: 'authorities', teardown: { step: 10, handler: 'core' }, ownership: detail('/api/v1/authorities/{uuid}'),
        snapshot: { def: { read: 'list', path: '/api/v1/authorities', name: (i) => i.name } },
    },
    {
        type: 'credentials', ownDeletePath: '/api/v1/credentials', teardown: { step: 10, handler: 'core' }, ownership: detail('/api/v1/credentials/{uuid}'),
        snapshot: { def: { read: 'list', path: '/api/v1/credentials', name: (i) => i.name, marker: enabledMarker } },
    },
    {
        type: 'connectors', teardown: { step: 10, handler: 'core' }, ownership: detail('/api/v1/connectors/{uuid}'),
        snapshot: { def: { read: 'list', path: '/api/v1/connectors', name: (i) => i.name } },
    },
    // ---- step 11: token profiles, tokens
    {
        type: 'tokenProfiles', teardown: { step: 11, handler: 'core' },
        ownership: { kind: 'parent-or-list', parent: 'token', listUrl: '/api/v1/tokenProfiles', listParentField: 'tokenInstanceUuid', url: '/api/v1/tokens/{parent}/tokenProfiles/{uuid}' },
        snapshot: { gap: 'listed per token; a token change is covered by the tokens total' },
    },
    {
        type: 'tokens', teardown: { step: 11, handler: 'core' }, ownership: detail('/api/v1/tokens/{uuid}'),
        snapshot: { def: { read: 'list', path: '/api/v1/tokens', name: (i) => i.name } },
    },
    // ---- step 12: users, roles, groups, custom attributes, OID entries
    {
        type: 'users', ownDeletePath: '/api/v1/users', teardown: { step: 12, handler: 'core' }, ownership: detail('/api/v1/users/{uuid}', 'username'),
        snapshot: { def: { read: 'list', path: '/api/v1/users', name: (i) => i.username, marker: enabledMarker } },
    },
    {
        type: 'roles', ownDeletePath: '/api/v1/roles', teardown: { step: 12, handler: 'core' }, ownership: detail('/api/v1/roles/{uuid}'),
        snapshot: { def: { read: 'list', path: '/api/v1/roles', name: (i) => i.name } },
    },
    {
        type: 'groups', ownDeletePath: '/api/v1/groups', teardown: { step: 12, handler: 'core' }, ownership: detail('/api/v1/groups/{uuid}'),
        snapshot: { def: { read: 'list', path: '/api/v1/groups', name: (i) => i.name } },
    },
    {
        type: 'customAttributes', teardown: { step: 12, handler: 'core' }, ownership: detail('/api/v1/attributes/custom/{uuid}'),
        snapshot: { def: { read: 'list', path: '/api/v1/attributes/custom', name: (i) => i.name, marker: enabledMarker } },
    },
    {
        type: 'oidEntries', teardown: { step: 12, handler: 'inventory' }, ownership: idNamed,
        snapshot: { gap: 'list endpoint is a search keyed by OID (platform settings rows are @local)' },
    },
    // ---- step 13: entities, locations, secrets, vault profiles, vault instances, approval profiles
    {
        type: 'entities', teardown: { step: 13, handler: 'platform' }, ownership: detail('/api/v1/entities/{uuid}'),
        snapshot: { def: { read: 'searchAll', path: '/api/v1/entities/list', itemsKey: 'entities', name: (i) => i.name } },
    },
    {
        type: 'locations', teardown: { step: 13, handler: 'platform' }, ownership: { kind: 'parent', parent: 'entity', url: '/api/v1/entities/{parent}/locations/{uuid}' },
        snapshot: { def: { read: 'searchAll', path: '/api/v1/locations', itemsKey: 'locations', name: (i) => i.name, marker: enabledMarker } },
    },
    {
        type: 'secrets', teardown: { step: 13, handler: 'platform' }, ownership: detail('/api/v1/secrets/{uuid}'),
        snapshot: { def: { read: 'searchAll', path: '/api/v1/secrets', itemsKey: 'items', name: (i) => i.name, marker: (i) => `${i.state}|enabled=${i.enabled}` } },
    },
    {
        type: 'vaultProfiles', teardown: { step: 13, handler: 'platform' }, ownership: { kind: 'parent', parent: 'vault', url: '/api/v1/vaults/{parent}/vaultProfiles/{uuid}' },
        snapshot: { def: { read: 'searchAll', path: '/api/v1/vaultProfiles/list', itemsKey: 'items', name: (i) => i.name, marker: enabledMarker } },
    },
    {
        type: 'vaultInstances', teardown: { step: 13, handler: 'platform' }, ownership: detail('/api/v1/vaults/{uuid}'),
        snapshot: { def: { read: 'searchAll', path: '/api/v1/vaults/list', itemsKey: 'items', name: (i) => i.name } },
    },
    {
        type: 'approvalProfiles', teardown: { step: 13, handler: 'lifecycle' }, ownership: detail('/api/v1/approvalProfiles/{uuid}'),
        snapshot: { def: { read: 'paged', path: '/api/v1/approvalProfiles', itemsKey: 'approvalProfiles', name: (i) => i.name, marker: enabledMarker } },
    },
    // ---- step 14: scheduled jobs (@local only)
    {
        type: 'scheduledJobs', teardown: { step: 14, handler: 'scheduler' }, ownership: idNamed,
        snapshot: { def: { read: 'paged', path: '/api/v1/scheduler/jobs', itemsKey: 'scheduledJobs', name: (i) => i.jobName, marker: enabledMarker } },
    },
]);

/** The ledger types of the registry. */
export type RegisteredType = (typeof RESOURCE_REGISTRY)[number]['type'];

/** The types `deleteOwn` may delete (those with an `ownDeletePath`). */
export type OwnDeletableType = Extract<(typeof RESOURCE_REGISTRY)[number], { ownDeletePath: string }>['type'];

/** Gaps of the snapshot that belong to no ledger type (platform-level state and a part of a resource). */
export const EXTRA_SNAPSHOT_GAPS: Readonly<Record<string, string>> = {
    platformSettings: 'settings other than event associations are changed only by @local rows',
    scheduledJobsUser: 'user jobs are covered by the scheduledJobs total and enabled marker; only system jobs are compared field by field',
};

// ------------------------------------------------------------------ the tables derived from the registry (pure)

/** The delete order: steps ascending, each with the types of the step in registry order. */
export function deleteOrderOf(registry: readonly ResourceTypeEntry[] = RESOURCE_REGISTRY): Array<{ step: number; label: string; types: string[] }> {
    return TEARDOWN_STEPS.map(({ step, label }) => ({ step, label, types: registry.filter((e) => e.teardown.step === step).map((e) => e.type) }));
}

/** The handler module of every type. */
export function handlerModulesOf(registry: readonly ResourceTypeEntry[] = RESOURCE_REGISTRY): Record<string, HandlerModule> {
    return Object.fromEntries(registry.map((e) => [e.type, e.teardown.handler]));
}

/** The types whose ownership rests on the ledger line alone. */
export function idNamedTypesOf(registry: readonly ResourceTypeEntry[] = RESOURCE_REGISTRY): Set<string> {
    return new Set(registry.filter((e) => e.ownership.kind === 'id-named').map((e) => e.type));
}

/** The live-read specification of every named type. */
export function liveReadSpecsOf(registry: readonly ResourceTypeEntry[] = RESOURCE_REGISTRY): Record<string, LiveReadSpec> {
    const out: Record<string, LiveReadSpec> = {};
    for (const e of registry) if (e.ownership.kind !== 'id-named') out[e.type] = e.ownership;
    return out;
}

/** The snapshot resource definitions, in registry order. */
export function snapshotDefinitionsOf(registry: readonly ResourceTypeEntry[] = RESOURCE_REGISTRY): ResourceDef[] {
    const out: ResourceDef[] = [];
    for (const e of registry) if ('def' in e.snapshot) out.push({ type: e.type, ...e.snapshot.def });
    return out;
}

/** What the snapshot does not cover, and why. */
export function snapshotGapsOf(registry: readonly ResourceTypeEntry[] = RESOURCE_REGISTRY): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of registry) if ('gap' in e.snapshot) out[e.type] = e.snapshot.gap;
    return { ...out, ...EXTRA_SNAPSHOT_GAPS };
}

/** The collection path `deleteOwn` may delete on, per deletable type. */
export function ownDeletePathsOf(registry: readonly ResourceTypeEntry[] = RESOURCE_REGISTRY): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of registry) if (e.ownDeletePath) out[e.type] = e.ownDeletePath;
    return out;
}

// ------------------------------------------------------------------ the derived tables the safety layers read

/** The snapshot resource definitions (registry order). */
export const SNAPSHOT_RESOURCES: ResourceDef[] = snapshotDefinitionsOf();

/** What the snapshot does not cover, and why (an explicit gap list instead of a silent one). */
export const SNAPSHOT_GAPS: Readonly<Record<string, string>> = snapshotGapsOf();
