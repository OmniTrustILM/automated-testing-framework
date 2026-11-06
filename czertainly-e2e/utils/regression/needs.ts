/**
 * needs — what a row needs from the tier or the runner, decided from READS before the test creates anything.
 * `resolveNeed` answers `undefined` when met, else the skip reason; a failed
 * read is a test error, only "missing" skips. A skip is never coverage.
 */
import type { TestEnv } from '../env';
import { authorityConnectorName, existingRaProfile } from './config/authorities';
import { requiredCustomAttributes, UnfillableAttributeError } from './customAttributes';
import { findDiscoveryConnectors, generationGate } from './discovery/discoveryApi';
import { getPlatformTriggerGate } from './events/eventHistory';
import { smtpCatcherProblem, webhookReceiverProblem } from './events/notificationCatchers';
import { EVENT, type EventCode } from './events/eventVocabulary';
import { findNotificationConnector, type NotificationKind } from './events/notificationConnector';
import type { GuardedApi } from './guard/types';
import { openapiSource } from './inventory/openapiValidator';
import { fieldsOf, readCatalogue } from './inventory/searchApi';
import { readRunState } from './ledger/runState';
import { registrationDefaults } from './lifecycle/preRegistration';
import { noCryptoConnectorReason } from './platform/keyChain';
import { findCryptoConnector } from './platform/tokens';
import { CONNECTOR_SPECS, findRegisteredConnector, findVaultConnector, type ConnectorSpec } from './platform/connectorKinds';
import { apiJson } from './apiReads';
import { clusterProblem } from './kubernetesOwnObjects';
import { pickHealthyAuthority } from './ownRaProfiles';
import { keycloakLocalBlocker, secondIdentityBlocker } from './rbac/identities';
import { requireTool } from './requireTool';
import { timestampingNeedProblem } from '../timestamping/need';
import { DEFAULT_EJBCA_CONNECTOR, settings } from './run/settings';
import { NEEDS, type Needs } from './tags';

export interface NeedOptions {
    events?: readonly EventCode[];
    minFailedAttempts?: number;
    /** `required-attributes-fillable`: the resources whose required custom attributes the row fills (default certificates and RA profiles). */
    resources?: readonly string[];
}

export interface NeedContext {
    api: GuardedApi;
    env: TestEnv;
    options?: NeedOptions;
}

type Resolver = (context: NeedContext) => Promise<string | undefined>;

const isNotFound = (message: string): boolean => /^[A-Z]+ \S+ → 404\b/.test(message) || /REG_RA_PROFILE_NAME .* not found/.test(message);

async function runCaConnector(api: GuardedApi): Promise<{ connector: string; picked: boolean } | { skip: string }> {
    // Only "not there" is an unmet need (a gone run authority, a REG_RA_PROFILE_NAME that names nothing); any other error fails the test.
    try {
        return await readRunCaConnector(api);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!isNotFound(message)) throw e;
        return { skip: `needs a CA: the run CA could not be read (${message.split('\n')[0].slice(0, 200)})` };
    }
}

async function readRunCaConnector(api: GuardedApi): Promise<{ connector: string; picked: boolean } | { skip: string }> {
    const state = readRunState().raProfile;
    if (state) return { connector: await authorityConnectorName(api, state.authorityUuid), picked: false };
    const existing = await existingRaProfile(api);
    if (existing) return { connector: await authorityConnectorName(api, existing.authorityUuid), picked: false };
    const pick = await pickHealthyAuthority(api);
    return 'skip' in pick ? pick : { connector: pick.connectorName, picked: true };
}

/** The run CA resolves AND a healthy authority can be picked; asked here so a row that makes its own RA profile skips instead of failing. */
async function healthyCaProblem(api: GuardedApi): Promise<string | undefined> {
    const found = await runCaConnector(api);
    if ('skip' in found) return found.skip;
    if (found.picked) return undefined;
    const pick = await pickHealthyAuthority(api);
    return 'skip' in pick ? pick.skip : undefined;
}

const notification = (kind: NotificationKind, label: string): Resolver => async ({ api }) => {
    const connector = await findNotificationConnector(api, kind);
    if (!connector) return `deploy gate: no connected ${label} notification connector registered on this tier (@needs:${label === 'e-mail' ? 'email' : 'webhook'}-provider)`;
    return connector.unhealthy ? `deploy gate: the ${label} notification connector ${connector.name} is not healthy (${connector.unhealthy})` : undefined;
};

const registered = (spec: ConnectorSpec, label: string, need: Needs): Resolver => async ({ api }) =>
    (await findRegisteredConnector(api, spec)) ? undefined : `deploy gate: no ${label} is registered on this tier (@needs:${need})`;

const tool = (name: Parameters<typeof requireTool>[0]): Resolver => async () => requireTool(name);

const RESOLVERS: Record<Needs, Resolver> = {
    ca: ({ api }) => healthyCaProblem(api),
    'ejbca-ng': async ({ api }) => {
        const found = await runCaConnector(api);
        if ('skip' in found) return found.skip;
        return found.connector === DEFAULT_EJBCA_CONNECTOR ? undefined : `needs ejbca-ng: the run RA profile is on ${found.connector || 'an unknown connector'}`;
    },
    pkcs11: async ({ api }) => {
        const wanted = settings().pkcs11Connector;
        const rows = await api.get('/api/v1/connectors');
        const connectors = rows.ok() ? ((await rows.json()) as Array<{ name?: string; status?: string }>) : [];
        return connectors.some((c) => c.name === wanted && c.status === 'connected') ? undefined : `no connected PKCS#11 cryptography connector (${wanted}) on this tier (REG_PKCS11_CONNECTOR)`;
    },
    'second-identity': async ({ env }) => secondIdentityBlocker(env.username),
    'keycloak-local': async ({ env }) => keycloakLocalBlocker(env.authMode),
    'crypto-v1': async ({ api }) => ((await findCryptoConnector(api, 1)) ? undefined : noCryptoConnectorReason(1)),
    'vault-connector': async ({ api }) =>
        (await findVaultConnector(api)) ? undefined : 'deploy gate: no connected HashiCorp Vault connector with a secret interface is registered on this tier (@needs:vault-connector)',
    timestamping: ({ api }) => timestampingNeedProblem(api),
    'ejbca-connector': registered(CONNECTOR_SPECS.ejbca, 'EJBCA-NG connector', 'ejbca-connector'),
    'adcs-connector': registered(CONNECTOR_SPECS['adcs-v2'], 'MS-ADCS-NG v2 connector', 'adcs-connector'),
    'crypto-v2': async ({ api }) => ((await findCryptoConnector(api, 2)) ? undefined : noCryptoConnectorReason(2)),
    'platform-triggers-free': ({ api, options }) => getPlatformTriggerGate(api, options?.events ?? Object.values(EVENT)),
    'metadata-field': async ({ api }) =>
        fieldsOf(await readCatalogue(api), 'meta').length ? undefined : 'the tier offers no metadata field for certificates (the row needs a metadata item the tier offers)',
    'scep-https': ({ api }) => scepHttpsProblem(api),
    'registration-settings': async ({ api, options }) => {
        const wanted = options?.minFailedAttempts ?? 1;
        const defaults = await registrationDefaults(api);
        if (defaults.defaultIssuanceWindowDays >= 1 && defaults.maxFailedAttempts >= wanted) return undefined;
        const why = defaults.maxFailedAttempts < wanted ? `needs maxFailedAttempts of at least ${wanted}` : 'needs a default issuance window of at least one day';
        return `registration settings on this tier (maxFailedAttempts ${defaults.maxFailedAttempts}, window ${defaults.defaultIssuanceWindowDays} days) cannot hold the registration of this row (${why})`;
    },
    'required-attributes-fillable': async ({ api, options }) => {
        for (const resource of options?.resources ?? ['certificates', 'raProfiles']) {
            // Only reads; "the suite cannot fill it" skips, a failed read fails the test.
            try {
                await requiredCustomAttributes(api, resource, 'probe');
            } catch (e) {
                if (!(e instanceof UnfillableAttributeError)) throw e;
                return `a required custom attribute of ${resource} cannot be filled by the suite (${e.message.slice(0, 120)})`;
            }
        }
        return undefined;
    },
    'bearer-token': async ({ env }) =>
        env.authMode === 'header' ? 'no bearer token on AUTH_MODE=header (a header-mode stack authenticates with the certificate header; @needs:keycloak-local)' : undefined,
    // The admin UI builds its utils client from the platform settings.
    'utils-service': async ({ api }) => {
        const settings = await apiJson<{ utils?: { utilsServiceUrl?: string } } | undefined>(api, 'GET', '/api/v1/settings/platform');
        return settings?.utils?.utilsServiceUrl?.trim() ? undefined : 'the platform settings configure no utils service (utils.utilsServiceUrl), so the form cannot parse a pasted CSR';
    },
    'openapi-document': async () => {
        const source = openapiSource();
        return 'skip' in source ? source.skip : undefined;
    },
    'v1-discovery': async ({ api }) => generationGate(await findDiscoveryConnectors(api), 'v1'),
    'v2-discovery': async ({ api }) => generationGate(await findDiscoveryConnectors(api), 'v2'),
    'email-provider': notification('EMAIL', 'e-mail'),
    'webhook-provider': notification('WEBHOOK', 'webhook'),
    'smtp-catcher': async () => smtpCatcherProblem(),
    'webhook-receiver': async () => webhookReceiverProblem(),
    // Decided in the spec: the test opens its own listener.
    'scan-target': async () => undefined,
    'connector-online': async () => undefined,
    openssl: tool('openssl'),
    sscep: tool('sscep'),
    docker: tool('docker'),
    cluster: async () => {
        // The cert-manager row needs a kubeconfig, namespace, auth secret, the tool and namespaced permissions.
        const { kubeconfig, cmNamespace: namespace, cmAuthSecret } = settings();
        if (!kubeconfig || !namespace || !cmAuthSecret) return '@needs:cluster — cert-manager flow needs KUBECONFIG, REG_CM_NAMESPACE and REG_CM_AUTH_SECRET (no cluster configured)';
        const missing = requireTool('kubectl');
        if (missing) return `@needs:cluster — ${missing}`;
        const problem = clusterProblem(namespace);
        return problem ? `@needs:cluster — ${problem}` : undefined;
    },
};

/**
 * Classic sscep cannot drive SCEP over https; the URL is known only after an activation (a write), so the ACME directory URL of the run RA
 * profile is read instead. Without it the need is met and the rig checks the reported SCEP URL.
 */
async function scepHttpsProblem(api: GuardedApi): Promise<string | undefined> {
    const state = readRunState();
    const ra = state.raProfile;
    if (!ra || state.acmeActivatedOn !== ra.uuid) return undefined;
    let directoryUrl: unknown;
    try {
        directoryUrl = (await apiJson<{ directoryUrl?: unknown }>(api, 'GET', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/acme`)).directoryUrl;
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (isNotFound(message)) return undefined;
        throw e;
    }
    return typeof directoryUrl === 'string' && /^https:/i.test(directoryUrl)
        ? 'the protocol URLs the server reports are https: classic sscep speaks plain HTTP only (needs an http endpoint or a TLS-capable sscep build)'
        : undefined;
}

export function resolveNeed(need: Needs, context: NeedContext): Promise<string | undefined> {
    const resolver = RESOLVERS[need];
    return resolver(context);
}

export async function resolveNeeds(wanted: readonly Needs[], context: NeedContext): Promise<string | undefined> {
    for (const need of new Set(wanted)) {
        const reason = await resolveNeed(need, context);
        if (reason !== undefined) return reason;
    }
    return undefined;
}

/** The needs a test declared in its `@needs:<x>` tags, in tag order; an unknown tag is an error. */
export function declaredNeedsOf(tagsOfTest: readonly string[]): Needs[] {
    const found: Needs[] = [];
    for (const tag of tagsOfTest) {
        const m = /^@needs:(.+)$/.exec(tag);
        if (!m) continue;
        if (!(NEEDS as readonly string[]).includes(m[1])) throw new Error(`a test declares ${tag}, which is not one of ${NEEDS.join(', ')}`);
        found.push(m[1] as Needs);
    }
    return found;
}
