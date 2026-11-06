/**
 * settings — the one typed reader of the REG_* and API_* settings: lazily read members, defaults written once, a test's injected `env`
 * honoured; a unit test diffs the names against `.env.example`.
 * The variable names are the Testkube contract and do not change.
 */

export const DEFAULT_ADCS_CONNECTOR = 'MS-ADCS-NG-Connector';
export const DEFAULT_CREDENTIAL_CONNECTOR = 'Common-Credential-Connector';
export const DEFAULT_EJBCA_CONNECTOR = 'EJBCA-NG-Connector';
export const DEFAULT_PKCS11_CONNECTOR = 'PKCS11-Cryptography-Provider';

export const INTERNAL_PINS = ['REG_TIER_ID', 'REG_ENV_FILE_PINNED', 'REG_LOCAL_CORE_MARKER', 'REG_PROOF_CERT', 'REG_UNIT_NO_DOCKER', 'API_RUN_ID'] as const;

const TOOL_VARIABLES = { openssl: 'REG_OPENSSL_BIN', sscep: 'REG_SSCEP_BIN', docker: 'REG_DOCKER_BIN', kubectl: 'REG_KUBECTL_BIN' } as const;

const nonEmpty = (value: string | undefined): string | undefined => {
    const t = value?.trim();
    return t ? t : undefined;
};

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
        get runId(): string | undefined { return env.REG_RUN_ID || undefined; },
        get runIdReuse(): string | undefined { return env.REG_RUN_ID_REUSE; },
        get stateDir(): string | undefined { return env.REG_STATE_DIR; },
        get envFile(): string | undefined { return env.REG_ENV_FILE || undefined; },
        get apiEnvFile(): string | undefined { return env.API_ENV_FILE || undefined; },
        get apiRunId(): string | undefined { return env.API_RUN_ID; },
        get deleteOwn(): string | undefined { return env.API_DELETE_OWN; },
        get teardownDryRun(): string | undefined { return env.API_TEARDOWN_DRY_RUN; },
        get keptStrict(): string | undefined { return env.REG_KEPT_STRICT; },
        get netTolerance(): string | undefined { return env.REG_NET_TOLERANCE; },
        get phase(): string | undefined { return env.REG_PHASE; },
        get build(): string | undefined { return env.REG_BUILD; },
        /**
         * REG_UNIT_NO_DOCKER=1 (unit config): the real docker CLI is never run;
         * the process value counts too, so an injected `env` cannot lift it.
         */
        get unitNoDocker(): boolean { return env.REG_UNIT_NO_DOCKER === '1' || process.env.REG_UNIT_NO_DOCKER === '1'; },

        get baseUrl(): string | undefined { return env.BASE_URL; },
        get authMode(): string { return env.AUTH_MODE ?? 'local'; },
        get authClientCert(): string | undefined { return env.AUTH_CLIENT_CERT; },
        get tierKind(): string | undefined { return env.TIER_KIND; },
        get tierId(): string | undefined { return env.REG_TIER_ID; },
        get tierLocalHosts(): string { return env.TIER_LOCAL_HOSTS ?? ''; },
        get localCoreUrl(): string | undefined { return env.REG_LOCAL_CORE_URL; },
        get localCoreMarker(): string | undefined { return env.REG_LOCAL_CORE_MARKER; },
        get raProfileName(): string | undefined { return env.REG_RA_PROFILE_NAME || undefined; },
        get coreReplicas(): string { return env.REG_CORE_REPLICAS ?? '1'; },
        get restrictedUsername(): string | undefined { return nonEmpty(env.REG_RESTRICTED_USERNAME); },
        get restrictedPassword(): string | undefined { return env.REG_RESTRICTED_PASSWORD; },
        get userPassword(): string | undefined { return env.REG_USER_PASSWORD; },

        get adcsConnector(): string { return env.REG_ADCS_CONNECTOR ?? DEFAULT_ADCS_CONNECTOR; },
        get adcsSourceAuthority(): string | undefined { return env.REG_ADCS_SOURCE_AUTHORITY; },
        get adcsTemplate(): string | undefined { return env.REG_ADCS_TEMPLATE || undefined; },
        get credentialConnectorOverride(): string | undefined { return nonEmpty(env.REG_CREDENTIAL_CONNECTOR); },
        get credentialConnector(): string { return nonEmpty(env.REG_CREDENTIAL_CONNECTOR) ?? DEFAULT_CREDENTIAL_CONNECTOR; },
        get requiredConnectors(): string | undefined { return env.REG_REQUIRED_CONNECTORS; },
        get blockedConnectors(): string | undefined { return env.REG_BLOCKED_CONNECTORS; },
        get gateConnector(): string | undefined { return env.REG_GATE_CONNECTOR || undefined; },
        get caConnectors(): string[] { return [...new Set(list(env.REG_CA_CONNECTORS ?? `${env.REG_ADCS_CONNECTOR ?? DEFAULT_ADCS_CONNECTOR},${DEFAULT_EJBCA_CONNECTOR},PyADCS-Connector`))]; },
        get exactSanConnectors(): string[] { return list(env.REG_EXACT_SAN_CONNECTORS ?? DEFAULT_EJBCA_CONNECTOR); },
        get pkcs11Connector(): string { return env.REG_PKCS11_CONNECTOR || DEFAULT_PKCS11_CONNECTOR; },
        get discoveryV1Connector(): string | undefined { return nonEmpty(env.REG_DISCOVERY_V1_CONNECTOR); },
        get discoveryV2Connector(): string | undefined { return nonEmpty(env.REG_DISCOVERY_V2_CONNECTOR); },
        get softProvider(): string | undefined { return env.REG_SOFT_PROVIDER || undefined; },
        get secretConnector(): string | undefined { return env.REG_SECRET_CONNECTOR || undefined; },
        cryptoConnector(version: 1 | 2): string | undefined { return (version === 1 ? env.REG_CRYPTO_CONNECTOR_V1 : env.REG_CRYPTO_CONNECTOR_V2) || undefined; },

        get composeFile(): string | undefined { return firstSet(env, 'LOCAL_COMPOSE_FILE', 'REG_LOCAL_COMPOSE_FILE'); },
        get composeFileTarget(): string | undefined { return env.LOCAL_COMPOSE_FILE_TARGET; },
        get composeProject(): string | undefined { return firstSet(env, 'LOCAL_COMPOSE_PROJECT', 'REG_LOCAL_COMPOSE_PROJECT'); },
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
        get dockerBinOverride(): string | undefined { return env.REG_DOCKER_BIN || undefined; },
        get kubectlBin(): string { return env.REG_KUBECTL_BIN || 'kubectl'; },
        toolBin(tool: 'openssl' | 'sscep' | 'docker' | 'kubectl'): string { return env[TOOL_VARIABLES[tool]] ?? tool; },

        get scanHost(): string { return (env.REG_SCAN_HOST ?? '').trim(); },
        get scanBind(): string { return (env.REG_SCAN_BIND ?? '0.0.0.0').trim() || '0.0.0.0'; },
        get smtpCatcherUrl(): string { return (env.REG_SMTP_CATCHER_URL ?? '').trim(); },
        get webhookHost(): string { return (env.REG_WEBHOOK_HOST ?? '').trim(); },
        get webhookBind(): string { return (env.REG_WEBHOOK_BIND ?? '0.0.0.0').trim() || '0.0.0.0'; },
        get stubBindHost(): string { return env.REG_STUB_BIND_HOST || '127.0.0.1'; },
        get stubAdvertisedHost(): string { return env.REG_STUB_ADVERTISED_HOST || 'host.docker.internal'; },

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

export type Settings = ReturnType<typeof settings>;
