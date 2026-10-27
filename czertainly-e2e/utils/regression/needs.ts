/**
 * needs — what a row needs from the tier or the runner, decided from READS before the test creates anything.
 *
 * WHAT: `resolveNeed(need, context)` answers `undefined` when one `Needs` value (the catalogue of utils/regression/tags.ts) is met,
 * else the named reason the test skips with. `declaredNeedsOf(tags)` reads the `@needs:<x>` tags of a test; `resolveNeeds` answers the
 * first unmet need of a list. The resolvers wrap what the specs used to decide one by one: helpers that return `T | { skip }`,
 * take a skip callback, throw `RaProfileSourceMissing`, or answer a blocker text.
 * WHY: every spec used to re-decide how a precondition skips (a callback, a union result, a caught throw, a hand-written
 * `test.skip`), and a skip that came after the first create left objects behind for a test that never ran. With one resolver per
 * need the order is by construction: the `needs` fixture of fixtures/regressionFixtures.ts resolves what the test declared before any
 * `own` or page call, and a skip is never coverage (the reason names the deploy gate).
 * HOW: a resolver only reads (GET through the guarded context, the environment, a tool's `--version`); it never creates. A read
 * that fails (a status that is not 2xx, a network error) is an error of the test, not an unmet need: only the tier's answer that the
 * thing is missing skips. Three needs take an option of the call, because what they check depends on the row: the events a row
 * watches (`platform-triggers-free`), the failed attempts a registration table needs (`registration-settings`) and the resources
 * whose required custom attributes the row fills (`required-attributes-fillable`); a need declared by tag uses the defaults. Needs
 * that only the test body can decide (`scan-target`: the test opens its own listener; `connector-online`: the connector row
 * under test) are met here and keep their own check in the spec.
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

/** What a call may tell the three needs that depend on the row (see the module header); every member has a default. */
export interface NeedOptions {
    /** `platform-triggers-free`: the events the row watches (default: every event of the vocabulary). */
    events?: readonly EventCode[];
    /** `registration-settings`: the least `maxFailedAttempts` the row needs (default 1). */
    minFailedAttempts?: number;
    /**
     * `required-attributes-fillable`: the resources whose required custom attributes the row fills (default certificates and RA profiles).
     */
    resources?: readonly string[];
}

/** What a resolver may read: the guarded context (reads only are made), the validated environment and the options of the call. */
export interface NeedContext {
    api: GuardedApi;
    env: TestEnv;
    options?: NeedOptions;
}

type Resolver = (context: NeedContext) => Promise<string | undefined>;

/** An API read that answered 404, or the helper's own "names nothing" assertion for REG_RA_PROFILE_NAME. */
const isNotFound = (message: string): boolean => /^[A-Z]+ \S+ → 404\b/.test(message) || /REG_RA_PROFILE_NAME .* not found/.test(message);

/** The tier's CA connector name behind the run RA profile: the run state's, else the one the run would pick (reads only). */
async function runCaConnector(api: GuardedApi): Promise<{ connector: string; picked: boolean } | { skip: string }> {
    // Only "not there" is an unmet need: a run authority that is gone (answer 404) or a REG_RA_PROFILE_NAME that names nothing. Any other
    // error (401, 5xx, network, a coding error) is a failure of the test, not a missing CA.
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

/**
 * The run CA resolves AND a healthy authority can be picked: the run RA profile can exist while `pickHealthyAuthority` finds none (a row
 * that makes its own RA profile would then fail instead of skipping), so the picker is asked here, before the row writes anything.
 */
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

/** A connector the tier must have registered (any state: a dead one is the row's finding, not a skip), found by what it offers. */
const registered = (spec: ConnectorSpec, label: string, need: Needs): Resolver => async ({ api }) =>
    (await findRegisteredConnector(api, spec)) ? undefined : `deploy gate: no ${label} is registered on this tier (@needs:${need})`;

const tool = (name: Parameters<typeof requireTool>[0]): Resolver => async () => requireTool(name);

/** One resolver per need; the record type makes a new `Needs` value fail to compile until it has one. */
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
            // Definitions are only read; "the suite cannot fill it" is the one error that skips, a failed read fails the test.
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
    // The admin UI builds its utils client from the platform settings and parses a pasted CSR only through that service.
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
    // The test opens its own runner-hosted TLS listener, and the connector row under test is the one it reads: their checks stay in the
    // spec.
    'scan-target': async () => undefined,
    'connector-online': async () => undefined,
    openssl: tool('openssl'),
    sscep: tool('sscep'),
    docker: tool('docker'),
    cluster: async () => {
        // What the cert-manager row asks for: a kubeconfig, the namespace and the auth secret, then the tool and the namespaced
        // permissions.
        const { kubeconfig, cmNamespace: namespace, cmAuthSecret } = settings();
        if (!kubeconfig || !namespace || !cmAuthSecret) return '@needs:cluster — cert-manager flow needs KUBECONFIG, REG_CM_NAMESPACE and REG_CM_AUTH_SECRET (no cluster configured)';
        const missing = requireTool('kubectl');
        if (missing) return `@needs:cluster — ${missing}`;
        const problem = clusterProblem(namespace);
        return problem ? `@needs:cluster — ${problem}` : undefined;
    },
};

/**
 * SCEP over https cannot be driven by classic sscep. The URL core reports for a protocol is known only after an activation, which is a
 * write; the one read that shows it earlier is the ACME directory URL of the run RA profile when the run already activated ACME on it
 * (core builds every protocol URL from the same address). Without that, the need cannot tell and is met: the rig keeps its check of the
 * reported SCEP URL as the last word. A 404 means the run RA profile is gone (no URL to read); any other failed read fails the test.
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

/** `undefined` when the need is met, else the reason the test skips with. Only reads. */
export function resolveNeed(need: Needs, context: NeedContext): Promise<string | undefined> {
    const resolver = RESOLVERS[need];
    return resolver(context);
}

/** The first unmet need of the list, in order (`undefined` when all are met); each resolver runs once. */
export async function resolveNeeds(wanted: readonly Needs[], context: NeedContext): Promise<string | undefined> {
    for (const need of new Set(wanted)) {
        const reason = await resolveNeed(need, context);
        if (reason !== undefined) return reason;
    }
    return undefined;
}

/**
 * The needs a test declared: its `@needs:<x>` tags (`testMeta({ needs })`), in tag order; a tag that is not in the catalogue is an error.
 */
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
