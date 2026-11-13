/**
 * resourceTypes — data-only descriptor of the ledger types the timestamping block adds: how each live object is read, the reference pairs
 * core enforces and its teardown handler.
 * The order inside DELETE_ORDER step 3 is load-bearing (checked by tests/unit/timestampingTeardown.spec.ts); a signing profile that names
 * another as its timestamp source must be RECORDED after it.
 */

type Parents = Record<string, string | string[]> | undefined;

export interface TimestampingReference {
    /** Core refuses to delete this type ... */
    a: string;
    /** ... while an object of this type still references it (so `b` is deleted first). */
    b: string;
    core: string;
}

export interface TimestampingResourceType {
    type: string;
    liveRead: {
        /** Undefined when a parent-scoped route has no parent (the object then reads as missing). */
        detailUrl: (uuid: string, parents?: Parents) => string | undefined;
        nameField: string;
    };
    deleteAfter: string[];
    deleteBefore: string[];
    referencedBy: TimestampingReference[];
    handlerModule: string;
}

const HANDLER_MODULE = '../timestamping/teardown';

const parentOf = (parents: Parents, key: string): string | undefined => {
    const v = parents?.[key];
    return Array.isArray(v) ? v[0] : v;
};

export const TIMESTAMPING_RESOURCE_TYPES: readonly TimestampingResourceType[] = [
    {
        // Recorded by the specs for a Basic credential of the run's own TSP profile. Its vault secret has no ledger line: the handler
        // deletes it only when its live name matches the own-secret shape (teardown.ts).
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
        // The vault secrets behind its Basic credentials have no ledger line: the handler deletes one only when its live name matches the
        // own-secret shape (teardown.ts).
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
 * Releases that are not deletes: a TSP profile cannot be deleted while a signing profile is ACTIVATED on it, so the handler deactivates it
 * first. A pair would form a cycle with the one above.
 */
export const TIMESTAMPING_RELEASES: ReadonlyArray<{ a: string; b: string; by: string; core: string }> = [
    {
        a: 'tspProfiles', b: 'signingProfiles', by: 'PATCH /v1/signingProfiles/{uuid}/protocols/tsp/deactivate (in the tspProfiles and signingProfiles handlers)',
        core: 'service/impl/TspProfileServiceImpl.java:457-470 deleteTspProfile: "Cannot delete TSP Profile: associated with Signing Profiles" (db fk_signing_profile_tsp_profile ON DELETE RESTRICT, V202605051246__signing.sql:56)',
    },
];

/**
 * Deletes core does NOT refuse over a timestamping object: a Basic credential maps a TSP username to an ILM user by uuid only, and
 * credential rows go with their TSP profile.
 */
export const TIMESTAMPING_NOT_REFERENCED: ReadonlyArray<{ a: string; b: string; core: string }> = [
    { a: 'users', b: 'tspProfiles', core: 'dao/entity/signing/TspProfileBasicCredential mapped_user_uuid has no foreign key (V202606020900__tsp_profile_authentication.sql:12-20); UserManagementServiceImpl / RoleManagementServiceImpl delete read no TSP data' },
    { a: 'roles', b: 'tspProfiles', core: 'same as users: a role is never named by a TSP profile or credential' },
];

export const TIMESTAMPING_REFERENCED_BY: ReadonlyArray<TimestampingReference> = TIMESTAMPING_RESOURCE_TYPES.flatMap((r) => r.referencedBy);

export const TIMESTAMPING_HANDLER_MODULES: Readonly<Record<string, string>> = Object.fromEntries(
    TIMESTAMPING_RESOURCE_TYPES.map((r) => [r.type, r.handlerModule]),
);

export const TIMESTAMPING_DELETE_STEP_TYPES: readonly string[] = ['tspBasicCredentials', 'tspProfiles', 'signingProfiles', 'timeQualityConfigurations'];

/**
 * The four types in the shape of the type registry, in delete order, with URL
 * templates as plain strings; `handler: 'timestamping'` is the registry's key.
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
