/**
 * settings — the one typed reader of the environment variables the regression and API suites read.
 *
 * WHAT: `settings(env)` returns an object with one lazily evaluated member per variable (`settings(env).adcsConnector`,
 * `.composeProject`, ...). Each default is written here once; a member returns the raw text, a trimmed text or the default,
 * exactly as the module that used to read the variable did, and the modules keep their `env` seam (`env = process.env`)
 * and pass it in. Where two spellings of one variable exist (`LOCAL_COMPOSE_*` and `REG_LOCAL_COMPOSE_*`), the member reads
 * both and the first one set wins; `LOCAL_COMPOSE_*` is the documented spelling (the first of the two), `REG_LOCAL_COMPOSE_*` the alias.
 * WHY: a default written in three modules drifts, and a variable one module reads under a name another module ignores
 * (the container proof read only `REG_LOCAL_COMPOSE_PROJECT` while the stack helpers read both) makes a documented
 * setting work in one place only. `tests/unit/settings.spec.ts` diffs the names this file reads against `.env.example`, so
 * a new variable without documentation fails the unit run.
 * HOW: members are getters over `env`, so nothing is read until it is used and a test's injected `env` is honoured. The
 * variable names are the Testkube contract and do not change. The internal pins (`INTERNAL_PINS`) are written by the run
 * (`prepareRun`, the local proof), never set by a user. `utils/env.ts` (the smoke reader) is not touched. The switch
 * parsers (`parseFlag`) stay with their callers: a member returns the raw text of a switch.
 */

/** The unset default of each variable that has one, written once. */
export const DEFAULT_ADCS_CONNECTOR = 'MS-ADCS-NG-Connector';
export const DEFAULT_CREDENTIAL_CONNECTOR = 'Common-Credential-Connector';
export const DEFAULT_EJBCA_CONNECTOR = 'EJBCA-NG-Connector';
export const DEFAULT_PKCS11_CONNECTOR = 'PKCS11-Cryptography-Provider';

/** Variables the run writes for its own workers and children; they are not part of the user's configuration. */
export const INTERNAL_PINS = ['REG_TIER_ID', 'REG_ENV_FILE_PINNED', 'REG_LOCAL_CORE_MARKER', 'REG_PROOF_CERT', 'REG_UNIT_NO_DOCKER', 'API_RUN_ID'] as const;

const TOOL_VARIABLES = { openssl: 'REG_OPENSSL_BIN', sscep: 'REG_SSCEP_BIN', docker: 'REG_DOCKER_BIN', kubectl: 'REG_KUBECTL_BIN' } as const;

const nonEmpty = (value: string | undefined): string | undefined => {
    const t = value?.trim();
    return t ? t : undefined;
};

/** The first of the given variables that is set to a non-blank text (trimmed). */
const firstSet = (env: NodeJS.ProcessEnv, ...names: string[]): string | undefined => {
    for (const name of names) {
        const v = nonEmpty(env[name]);
        if (v) return v;
    }
    return undefined;
};

const list = (text: string): string[] => text.split(',').map((s) => s.trim()).filter(Boolean);

export function settings(env: NodeJS.ProcessEnv = process.env) {
    return {
        // ------------------------------------------------------------------ the run
        /** REG_RUN_ID as set (the run id itself is `runId()`). */
        get runId(): string | undefined { return env.REG_RUN_ID || undefined; },
        /** REG_RUN_ID_REUSE: the raw text of the switch. */
        get runIdReuse(): string | undefined { return env.REG_RUN_ID_REUSE; },
        /** REG_STATE_DIR as set; the default location is chosen by `regressionStateDir`. */
        get stateDir(): string | undefined { return env.REG_STATE_DIR; },
        get envFile(): string | undefined { return env.REG_ENV_FILE || undefined; },
        get apiEnvFile(): string | undefined { return env.API_ENV_FILE || undefined; },
        /** API_RUN_ID: the id the API template reads; the run writes it from REG_RUN_ID. */
        get apiRunId(): string | undefined { return env.API_RUN_ID; },
        /** API_DELETE_OWN: the raw text of the switch (default on; off for a hand-set run id). */
        get deleteOwn(): string | undefined { return env.API_DELETE_OWN; },
        /** API_TEARDOWN_DRY_RUN: the raw text of the switch. */
        get teardownDryRun(): string | undefined { return env.API_TEARDOWN_DRY_RUN; },
        /** REG_KEPT_STRICT: the raw text of the switch. */
        get keptStrict(): string | undefined { return env.REG_KEPT_STRICT; },
        /** REG_NET_TOLERANCE: the raw text (a non-negative integer, default 0). */
        get netTolerance(): string | undefined { return env.REG_NET_TOLERANCE; },
        /** REG_PHASE: `B` runs the migrated-connector rows only. */
        get phase(): string | undefined { return env.REG_PHASE; },
        /** REG_BUILD: `sb41` or `main` / `baseline`; unset: the build marker of the tier decides. */
        get build(): string | undefined { return env.REG_BUILD; },
        /**
         * REG_UNIT_NO_DOCKER=1 (set by the unit config): the real docker CLI is never run. The process value counts too, so an injected
         * `env` cannot lift it.
         */
        get unitNoDocker(): boolean { return env.REG_UNIT_NO_DOCKER === '1' || process.env.REG_UNIT_NO_DOCKER === '1'; },

        // ------------------------------------------------------------------ the tier
        get baseUrl(): string | undefined { return env.BASE_URL; },
        /** AUTH_MODE: `local`, `oidc` or `header` (default `local`). */
        get authMode(): string { return env.AUTH_MODE ?? 'local'; },
        get authClientCert(): string | undefined { return env.AUTH_CLIENT_CERT; },
        /** TIER_KIND as set (`local`; anything else is a shared tier). */
        get tierKind(): string | undefined { return env.TIER_KIND; },
        /** REG_TIER_ID: the tier identity frozen at config load (an internal pin). */
        get tierId(): string | undefined { return env.REG_TIER_ID; },
        /** TIER_LOCAL_HOSTS: extra hosts accepted as a local stack (comma list, raw). */
        get tierLocalHosts(): string { return env.TIER_LOCAL_HOSTS ?? ''; },
        /** REG_LOCAL_CORE_URL: the local core's base URL (TIER_KIND=local). */
        get localCoreUrl(): string | undefined { return env.REG_LOCAL_CORE_URL; },
        /** REG_LOCAL_CORE_MARKER: the core build marker the local proof read (an internal pin). */
        get localCoreMarker(): string | undefined { return env.REG_LOCAL_CORE_MARKER; },
        /** REG_RA_PROFILE_NAME: an existing RA profile used as an issue-only parent (local stack only). */
        get raProfileName(): string | undefined { return env.REG_RA_PROFILE_NAME || undefined; },
        /** REG_CORE_REPLICAS: the raw text (default 1). */
        get coreReplicas(): string { return env.REG_CORE_REPLICAS ?? '1'; },
        get restrictedUsername(): string | undefined { return nonEmpty(env.REG_RESTRICTED_USERNAME); },
        get restrictedPassword(): string | undefined { return env.REG_RESTRICTED_PASSWORD; },
        /** REG_USER_PASSWORD: the identity-provider password of the user REG-CFG-09 creates. */
        get userPassword(): string | undefined { return env.REG_USER_PASSWORD; },

        // ------------------------------------------------------------------ connectors
        get adcsConnector(): string { return env.REG_ADCS_CONNECTOR ?? DEFAULT_ADCS_CONNECTOR; },
        get adcsSourceAuthority(): string | undefined { return env.REG_ADCS_SOURCE_AUTHORITY; },
        get adcsTemplate(): string | undefined { return env.REG_ADCS_TEMPLATE || undefined; },
        /** REG_CREDENTIAL_CONNECTOR as set (trimmed); `credentialConnector` adds the default. */
        get credentialConnectorOverride(): string | undefined { return nonEmpty(env.REG_CREDENTIAL_CONNECTOR); },
        get credentialConnector(): string { return nonEmpty(env.REG_CREDENTIAL_CONNECTOR) ?? DEFAULT_CREDENTIAL_CONNECTOR; },
        /** REG_REQUIRED_CONNECTORS: the raw text (comma list). */
        get requiredConnectors(): string | undefined { return env.REG_REQUIRED_CONNECTORS; },
        /** REG_BLOCKED_CONNECTORS: the raw text (`name:reason;...`). */
        get blockedConnectors(): string | undefined { return env.REG_BLOCKED_CONNECTORS; },
        get gateConnector(): string | undefined { return env.REG_GATE_CONNECTOR || undefined; },
        /** The CA connectors in order: REG_CA_CONNECTORS (comma list), else ADCS, EJBCA-NG, PyADCS. */
        get caConnectors(): string[] { return [...new Set(list(env.REG_CA_CONNECTORS ?? `${env.REG_ADCS_CONNECTOR ?? DEFAULT_ADCS_CONNECTOR},${DEFAULT_EJBCA_CONNECTOR},PyADCS-Connector`))]; },
        /** The CAs whose issued SAN set must equal the CSR's. */
        get exactSanConnectors(): string[] { return list(env.REG_EXACT_SAN_CONNECTORS ?? DEFAULT_EJBCA_CONNECTOR); },
        get pkcs11Connector(): string { return env.REG_PKCS11_CONNECTOR || DEFAULT_PKCS11_CONNECTOR; },
        get discoveryV1Connector(): string | undefined { return nonEmpty(env.REG_DISCOVERY_V1_CONNECTOR); },
        get discoveryV2Connector(): string | undefined { return nonEmpty(env.REG_DISCOVERY_V2_CONNECTOR); },
        get softProvider(): string | undefined { return env.REG_SOFT_PROVIDER || undefined; },
        get secretConnector(): string | undefined { return env.REG_SECRET_CONNECTOR || undefined; },
        /** The software cryptography connector named for an interface version (REG_CRYPTO_CONNECTOR_V1 / _V2), or undefined. */
        cryptoConnector(version: 1 | 2): string | undefined { return (version === 1 ? env.REG_CRYPTO_CONNECTOR_V1 : env.REG_CRYPTO_CONNECTOR_V2) || undefined; },

        // ------------------------------------------------------------------ local stack and runner tools
        /** The compose file: LOCAL_COMPOSE_FILE, else its alias REG_LOCAL_COMPOSE_FILE (the first set wins). */
        get composeFile(): string | undefined { return firstSet(env, 'LOCAL_COMPOSE_FILE', 'REG_LOCAL_COMPOSE_FILE'); },
        get composeFileTarget(): string | undefined { return env.LOCAL_COMPOSE_FILE_TARGET; },
        /** The compose project: LOCAL_COMPOSE_PROJECT, else its alias REG_LOCAL_COMPOSE_PROJECT (the first set wins). */
        get composeProject(): string | undefined { return firstSet(env, 'LOCAL_COMPOSE_PROJECT', 'REG_LOCAL_COMPOSE_PROJECT'); },
        /** The compose service names (core: LOCAL_SERVICE_CORE, else its alias REG_LOCAL_SERVICE_CORE). */
        get services(): { core: string; rabbitmq: string; db: string; auth: string; scheduler: string } {
            return {
                core: firstSet(env, 'LOCAL_SERVICE_CORE', 'REG_LOCAL_SERVICE_CORE') ?? 'core',
                rabbitmq: env.LOCAL_SERVICE_RABBITMQ ?? 'rabbitmq',
                db: env.LOCAL_SERVICE_DB ?? 'db',
                auth: env.LOCAL_SERVICE_AUTH ?? 'auth',
                scheduler: env.LOCAL_SERVICE_SCHEDULER ?? 'scheduler',
            };
        },
        get upgradeFromTag(): string | undefined { return env.REG_UPGRADE_FROM_TAG; },
        /** REG_DOCKER_BIN as set; `dockerBin` in requireTool applies the unit-test rules and the default. */
        get dockerBinOverride(): string | undefined { return env.REG_DOCKER_BIN || undefined; },
        get kubectlBin(): string { return env.REG_KUBECTL_BIN || 'kubectl'; },
        /**
         * The binary of a runner tool (`REG_OPENSSL_BIN`, `REG_SSCEP_BIN`, `REG_DOCKER_BIN`, `REG_KUBECTL_BIN`), else the tool's own name.
         */
        toolBin(tool: 'openssl' | 'sscep' | 'docker' | 'kubectl'): string { return env[TOOL_VARIABLES[tool]] ?? tool; },

        // ------------------------------------------------------------------ hosts of the runner
        /** REG_SCAN_HOST: the name the discovery connector dials for the runner-hosted TLS targets (trimmed; empty = none). */
        get scanHost(): string { return (env.REG_SCAN_HOST ?? '').trim(); },
        get scanBind(): string { return (env.REG_SCAN_BIND ?? '0.0.0.0').trim() || '0.0.0.0'; },
        get smtpCatcherUrl(): string { return (env.REG_SMTP_CATCHER_URL ?? '').trim(); },
        get webhookHost(): string { return (env.REG_WEBHOOK_HOST ?? '').trim(); },
        get webhookBind(): string { return (env.REG_WEBHOOK_BIND ?? '0.0.0.0').trim() || '0.0.0.0'; },
        get stubBindHost(): string { return env.REG_STUB_BIND_HOST || '127.0.0.1'; },
        get stubAdvertisedHost(): string { return env.REG_STUB_ADVERTISED_HOST || 'host.docker.internal'; },

        // ------------------------------------------------------------------ release checks and optional inputs
        get openapiFile(): string | undefined { return env.REG_OPENAPI_FILE; },
        get expectedCoreVersion(): string | undefined { return env.REG_EXPECTED_CORE_VERSION || undefined; },
        get expectedFeVersion(): string | undefined { return env.REG_EXPECTED_FE_VERSION || undefined; },
        get strictVersions(): boolean { return env.REG_STRICT_VERSIONS === 'true'; },
        get kubeconfig(): string | undefined { return env.KUBECONFIG; },
        get cmNamespace(): string { return env.REG_CM_NAMESPACE ?? ''; },
        get cmAuthSecret(): string | undefined { return env.REG_CM_AUTH_SECRET; },
        get cmCaBundleSecret(): string | undefined { return env.REG_CM_CA_BUNDLE_SECRET || undefined; },
        get cmApiUrl(): string | undefined { return env.REG_CM_API_URL; },
    };
}

/** The settings of one environment (the type of `settings(env)`). */
export type Settings = ReturnType<typeof settings>;
