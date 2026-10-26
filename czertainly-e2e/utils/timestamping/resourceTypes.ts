/**
 * resourceTypes — data-only descriptor of the four ledger types the timestamping block adds: `tspProfiles`,
 * `signingProfiles`, `timeQualityConfigurations`, `tspBasicCredentials`.
 *
 * WHAT: one entry per type with everything the framework needs to know about it besides the handler code: how its live
 * object is read (detail URL, the field that must carry the run prefix), which ledger types are deleted before / after
 * it, the reference pairs core enforces (each with a file:line citation and what core refuses), and the module that
 * holds its teardown handler. Core read: `integration/spring-boot-4.1` @ 569e853c563a (paths under
 * src/main/java/com/otilm/core/ unless a migration is named; migrations under src/main/resources/db/migration/).
 * WHY: runTeardown keeps three parallel tables (HANDLER_MODULES, DELETE_ORDER + REFERENCED_BY) and ownership.ts a
 * fourth (LIVE_READS). The refactor replaces them with one registry (`utils/regression/resourceTypes.ts`: type →
 * teardown step, handler module, ownership kind, snapshot definition). This file is shaped so each entry maps 1:1 onto
 * one registry entry (`liveRead` → the ownership kind `named` + its read, `handlerModule` → handler module,
 * `deleteAfter` / `referencedBy` → the teardown step); the registry spreads `TIMESTAMPING_REGISTRY_ENTRIES` below.
 * HOW: plain data, no imports from the framework. tests/unit/timestampingTeardown.spec.ts checks the descriptor against
 * the handler module (every type has a handler, the handler reads the same detail URL) and against the integrated
 * DELETE_ORDER (every `referencedBy` pair is satisfied; `deleteAfter` / `deleteBefore` agree with the pairs).
 *
 * Direction of a pair `{ a, b }`: core refuses to delete `a` while an object of type `b` still references it, so `b` is
 * deleted before `a`. `deleteAfter` of a type lists the types it is deleted AFTER (they go first); `deleteBefore` lists
 * the types it is deleted BEFORE (it goes first). Both derive from `referencedBy`; the test keeps them in step.
 * Each pair is listed once, in the entry of its `b` side (the type that holds the reference).
 *
 * WHERE THE FRAMEWORK USES IT (until the registry exists):
 *   1. DELETE_ORDER (runTeardown.ts): the four types join step 3 after `discoveries` (no renumbering), so they go before
 *      step 4 `certificates` and step 5 `keys` (a signing profile pins its certificate, token profile and time-quality
 *      configuration). The order inside the step is load-bearing: tspBasicCredentials first (before the profile that owns
 *      them and before `users`, a later step), then tspProfiles (it removes the activation and, holding the default
 *      signing profile, goes before it), then signingProfiles, then timeQualityConfigurations (refused while any signing
 *      profile references it). Within `signingProfiles` the teardown deletes the newest line first (planTeardown), so a
 *      signing profile that names another one as its timestamp source (content-signing canary) must be RECORDED after
 *      the one it names.
 *   2. The handler module: the registry entries below name it by the key `timestamping`, which runTeardown imports.
 *   3. LIVE_READS (ledger/ownership.ts): one entry per type with the `liveRead` below.
 *   4. REFERENCED_BY (runTeardown.ts): spreads `TIMESTAMPING_REFERENCED_BY`.
 */

type Parents = Record<string, string | string[]> | undefined;

export interface TimestampingReference {
    /** The type core refuses to delete ... */
    a: string;
    /** ... while an object of this type still references it (so `b` is deleted first). */
    b: string;
    /** `<file:lines>` and what core refuses. A refusal that exists only as a database constraint says so. */
    core: string;
}

export interface TimestampingResourceType {
    type: string;
    liveRead: {
        /** Detail URL of the live object; undefined when a parent-scoped route has no parent (the object then reads as missing). */
        detailUrl: (uuid: string, parents?: Parents) => string | undefined;
        /** Field of the detail body that must carry the run prefix. */
        nameField: string;
    };
    /** Types this type is deleted AFTER (they reference it, or its handler needs them gone). */
    deleteAfter: string[];
    /** Types this type is deleted BEFORE (it references them). */
    deleteBefore: string[];
    /** Pairs where this type is `b`: it holds the reference, `a` cannot be deleted before it. */
    referencedBy: TimestampingReference[];
    /** Module (relative to utils/regression) whose `teardownHandlers` export removes the type. */
    handlerModule: string;
}

const HANDLER_MODULE = '../timestamping/teardown';

/** The first value of a ledger parent (a uuid or a list of them). */
const parentOf = (parents: Parents, key: string): string | undefined => {
    const v = parents?.[key];
    return Array.isArray(v) ? v[0] : v;
};

export const TIMESTAMPING_RESOURCE_TYPES: readonly TimestampingResourceType[] = [
    {
        // Recorded by the specs (40-tsp-errors) for a Basic credential added to the run's own TSP profile; ledger parents { tspProfile }.
        // The route is scoped by the TSP profile (interfaces TspProfileBasicCredentialController: /v1/tspProfiles/{tsp}/basicCredentials/{uuid}).
        // The detail (TspBasicCredentialDto) names the credential by `username`: it must carry the run prefix for the guard.
        // Its vault secret has no ledger line: the handler deletes it explicitly (deleteInVaults=true) only when core's queue left it and its live
        // name matches exactly `tsp-basic-<own TSP profile uuid>-<own run-prefixed username>-<8 hex>`, read live in the same step (teardown.ts header).
        type: 'tspBasicCredentials',
        liveRead: {
            detailUrl: (uuid, parents) => (parentOf(parents, 'tspProfile') ? `/api/v1/tspProfiles/${parentOf(parents, 'tspProfile')}/basicCredentials/${uuid}` : undefined),
            nameField: 'username',
        },
        deleteAfter: [],
        deleteBefore: ['tspProfiles', 'users', 'vaultProfiles'],
        referencedBy: [
            {
                a: 'tspProfiles', b: 'tspBasicCredentials',
                core: 'handler order: core removes the credential rows WITH the TSP profile (service/impl/TspProfileServiceImpl.java:474 deleteSecretsForProfile + cascade dao/entity/signing/TspProfile.java:47) and refuses nothing, but the credential route is scoped by the profile (service/impl/TspProfileBasicCredentialServiceImpl.java:168-179 delete), so deleting it first is the only way its own delete is proven; a credential found gone with its profile is reported as such (goneWith)',
            },
            {
                a: 'users', b: 'tspBasicCredentials',
                core: 'handler order only: a credential maps a TSP username to an ILM user by uuid (V202606020900__tsp_profile_authentication.sql:15, no foreign key) and core\'s user delete checks nothing; the credential goes first so it never maps to a deleted user',
            },
            {
                a: 'vaultProfiles', b: 'tspBasicCredentials',
                core: 'service/impl/VaultProfileServiceImpl.java:212-225 deleteVaultProfile: "Cannot delete vault profile … set as source for secrets" while the credential\'s secret is left (service/impl/TspProfileBasicCredentialServiceImpl.java:168-179 delete queues the secret delete asynchronously: SecretServiceImpl.java:626-640)',
            },
        ],
        handlerModule: HANDLER_MODULE,
    },
    {
        // The vault secrets behind its Basic credentials have no ledger line: the handler deletes one explicitly (deleteInVaults=true) only when
        // core's queue left it and its live name starts with `tsp-basic-<this TSP profile's uuid>-` and matches the exact secret-name shape (teardown.ts header).
        type: 'tspProfiles',
        liveRead: { detailUrl: (uuid) => `/api/v1/tspProfiles/${uuid}`, nameField: 'name' },
        deleteAfter: ['tspBasicCredentials'],
        deleteBefore: ['signingProfiles', 'vaultProfiles'],
        referencedBy: [
            {
                a: 'signingProfiles', b: 'tspProfiles',
                core: 'service/impl/SigningProfileServiceImpl.java:619-632 deleteSigningProfile: "Cannot delete Signing Profile: used as default signing profile by TSP Profiles" (db fk_tsp_default_signing_profile ON DELETE RESTRICT, V202605051246__signing.sql:61)',
            },
            {
                a: 'vaultProfiles', b: 'tspProfiles',
                core: 'service/impl/TspProfileServiceImpl.java:457-478 deleteTspProfile + service/impl/TspProfileBasicCredentialServiceImpl.java:182-194 deleteSecretsForProfile (the vault secrets behind the Basic credentials are removed ASYNCHRONOUSLY: service/impl/SecretServiceImpl.java:626-640 deleteSecret queues the action) and service/impl/VaultProfileServiceImpl.java:212-225 deleteVaultProfile: "Cannot delete vault profile … set as source for secrets" while one is left; no app check for the profile itself (db fk_tsp_profile_vault_profile, V202606020900__tsp_profile_authentication.sql:22, answers HTTP 500, ExceptionHandlingAdvice.java:702-710)',
            },
        ],
        handlerModule: HANDLER_MODULE,
    },
    {
        type: 'signingProfiles',
        liveRead: { detailUrl: (uuid) => `/api/v1/signingProfiles/${uuid}`, nameField: 'name' },
        deleteAfter: ['tspProfiles'],
        deleteBefore: ['timeQualityConfigurations', 'tokenProfiles', 'certificates', 'raProfiles', 'connectors'],
        referencedBy: [
            {
                a: 'timeQualityConfigurations', b: 'signingProfiles',
                core: 'service/impl/TimeQualityConfigurationServiceImpl.java:299-312 deleteTimeQualityConfiguration: "Cannot delete Time Quality Configuration: associated with Signing Profiles" (db signing_profile.time_quality_config_uuid ON DELETE RESTRICT, V202605051246__signing.sql:12)',
            },
            {
                a: 'tokenProfiles', b: 'signingProfiles',
                core: 'service/writer/TokenProfileWriter.java:195-216 validateNoDependentObjects: "Cannot delete Token Profile … dependent Signing Profile(s)" (latest AND superseded versions; db signing_profile_version.token_profile_uuid ON DELETE RESTRICT, V202605051246__signing.sql:30)',
            },
            {
                a: 'certificates', b: 'signingProfiles',
                core: 'db only: signing_profile_version.certificate_uuid ON DELETE RESTRICT (V202605051246__signing.sql:31); service/impl/CertificateServiceImpl.java:882-915 deleteCertificate has no check, so the refused delete answers HTTP 500 (ExceptionHandlingAdvice.java:702-710)',
            },
            {
                a: 'raProfiles', b: 'signingProfiles',
                core: 'db only: signing_profile_version.ra_profile_uuid ON DELETE RESTRICT (V202605051246__signing.sql:32); service/impl/RaProfileServiceImpl.java:893-911 deleteRaProfileInt checks no signing profile, HTTP 500',
            },
            {
                a: 'connectors', b: 'signingProfiles',
                core: 'db only: signing_profile_version.delegated_signer_connector_uuid / signature_formatter_connector_uuid ON DELETE RESTRICT (V202605051246__signing.sql:34,37); service/v2/impl/ConnectorServiceImpl.java:848-930 deleteConnector lists dependent credentials, authorities, entities, tokens, vaults, notification instances, compliance profiles and live discovery runs but no signing profile, so HTTP 500',
            },
        ],
        handlerModule: HANDLER_MODULE,
    },
    {
        type: 'timeQualityConfigurations',
        liveRead: { detailUrl: (uuid) => `/api/v1/timeQualityConfigurations/${uuid}`, nameField: 'name' },
        deleteAfter: ['signingProfiles'],
        deleteBefore: [],
        referencedBy: [],
        handlerModule: HANDLER_MODULE,
    },
];

/**
 * Releases that are NOT deletes and therefore not ordering pairs. A TSP profile cannot be deleted while a signing profile
 * is ACTIVATED on it (SigningProfileServiceImpl `signing_profile.tsp_profile_uuid`); the tspProfiles handler releases it
 * with `PATCH /v1/signingProfiles/{uuid}/protocols/tsp/deactivate` (SigningProfileServiceImpl.java:770-777) and proves it
 * with `GET …/protocols/tsp` (`available: false`). Listing it as a pair {a: tspProfiles, b: signingProfiles} would
 * contradict the pair above (signingProfiles ← tspProfiles): the two references form a cycle that only the deactivation breaks.
 */
export const TIMESTAMPING_RELEASES: ReadonlyArray<{ a: string; b: string; by: string; core: string }> = [
    {
        a: 'tspProfiles', b: 'signingProfiles', by: 'PATCH /v1/signingProfiles/{uuid}/protocols/tsp/deactivate (in the tspProfiles and signingProfiles handlers)',
        core: 'service/impl/TspProfileServiceImpl.java:457-470 deleteTspProfile: "Cannot delete TSP Profile: associated with Signing Profiles" (db fk_signing_profile_tsp_profile ON DELETE RESTRICT, V202605051246__signing.sql:56)',
    },
];

/**
 * Deletes core does NOT refuse over a timestamping object. The existing handlers (users, roles) need no change:
 * a Basic credential maps a TSP username to an ILM user by uuid only (no foreign key, no check in the user or role
 * delete), and the credential rows go with their TSP profile (cascade + orphanRemoval, dao/entity/signing/TspProfile.java:47).
 */
export const TIMESTAMPING_NOT_REFERENCED: ReadonlyArray<{ a: string; b: string; core: string }> = [
    { a: 'users', b: 'tspProfiles', core: 'dao/entity/signing/TspProfileBasicCredential mapped_user_uuid has no foreign key (V202606020900__tsp_profile_authentication.sql:12-20); UserManagementServiceImpl / RoleManagementServiceImpl delete read no TSP data' },
    { a: 'roles', b: 'tspProfiles', core: 'same as users: a role is never named by a TSP profile or credential' },
];

/** Every pair of the entries, for runTeardown's REFERENCED_BY (spread as-is). */
export const TIMESTAMPING_REFERENCED_BY: ReadonlyArray<TimestampingReference> = TIMESTAMPING_RESOURCE_TYPES.flatMap((r) => r.referencedBy);

/** The descriptor's module path per type (data; the registry names the module by its key `timestamping`, which runTeardown imports). */
export const TIMESTAMPING_HANDLER_MODULES: Readonly<Record<string, string>> = Object.fromEntries(
    TIMESTAMPING_RESOURCE_TYPES.map((r) => [r.type, r.handlerModule]),
);

/** Types of the block in the delete order within their step (step 3, after `discoveries`). */
export const TIMESTAMPING_DELETE_STEP_TYPES: readonly string[] = ['tspBasicCredentials', 'tspProfiles', 'signingProfiles', 'timeQualityConfigurations'];

/**
 * The four types in the shape of the type registry (utils/regression/resourceTypes.ts): one entry per type, in delete
 * order, with URL templates as plain strings (`{uuid}`, and `{parent}` for the parent-scoped Basic credential), so the
 * registry can spread them after `discoveries`. `handler: 'timestamping'` is the registry's key for
 * '../timestamping/teardown'. tests/unit/timestampingTeardown.spec.ts keeps every template equal to the descriptor's
 * live read above.
 */
export const TIMESTAMPING_REGISTRY_ENTRIES = [
    {
        type: 'tspBasicCredentials',
        teardown: { step: 3, handler: 'timestamping' },
        ownership: { kind: 'parent', parent: 'tspProfile', url: '/api/v1/tspProfiles/{parent}/basicCredentials/{uuid}', nameField: 'username' },
        snapshot: { gap: 'timestamping block: its own run has no snapshot, and the regression snapshot does not list this resource (the guard and the ledger prove ownership)' },
    },
    {
        type: 'tspProfiles',
        teardown: { step: 3, handler: 'timestamping' },
        ownership: { kind: 'detail', url: '/api/v1/tspProfiles/{uuid}' },
        snapshot: { gap: 'timestamping block: its own run has no snapshot, and the regression snapshot does not list this resource (the guard and the ledger prove ownership)' },
    },
    {
        type: 'signingProfiles',
        teardown: { step: 3, handler: 'timestamping' },
        ownership: { kind: 'detail', url: '/api/v1/signingProfiles/{uuid}' },
        snapshot: { gap: 'timestamping block: its own run has no snapshot, and the regression snapshot does not list this resource (the guard and the ledger prove ownership)' },
    },
    {
        type: 'timeQualityConfigurations',
        teardown: { step: 3, handler: 'timestamping' },
        ownership: { kind: 'detail', url: '/api/v1/timeQualityConfigurations/{uuid}' },
        snapshot: { gap: 'timestamping block: its own run has no snapshot, and the regression snapshot does not list this resource (the guard and the ledger prove ownership)' },
    },
] as const;
