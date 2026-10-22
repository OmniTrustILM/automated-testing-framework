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
 * HOW: a resolver only reads (GET through the guarded context, the environment, a tool's `--version`); it never creates. Needs
 * that only the test body can decide (`scan-target`: the test opens its own listener; `connector-online`: the connector row
 * under test) are met here and keep their own check in the spec.
 */
import type { TestEnv } from '../env';
import { authorityConnectorName, existingRaProfile } from './config/authorities';
import { findDiscoveryConnectors, generationGate } from './discovery/discoveryApi';
import { smtpCatcherProblem, webhookReceiverProblem } from './events/notificationCatchers';
import { findNotificationConnector, type NotificationKind } from './events/notificationConnector';
import type { GuardedApi } from './guard/types';
import { readRunState } from './ledger/runState';
import { clusterProblem } from './kubernetesOwnObjects';
import { pickHealthyAuthority } from './ownRaProfiles';
import { keycloakLocalBlocker, secondIdentityBlocker } from './rbac/identities';
import { requireTool } from './requireTool';
import { DEFAULT_EJBCA_CONNECTOR, settings } from './run/settings';
import { NEEDS, type Needs } from './tags';

/** What a resolver may read: the guarded context (reads only are made) and the validated environment. */
export interface NeedContext {
    api: GuardedApi;
    env: TestEnv;
}

type Resolver = (context: NeedContext) => Promise<string | undefined>;

/** An API read that answered 404, or the helper's own "names nothing" assertion for REG_RA_PROFILE_NAME. */
const isNotFound = (message: string): boolean => /^[A-Z]+ \S+ → 404\b/.test(message) || /REG_RA_PROFILE_NAME .* not found/.test(message);

/** The tier's CA connector name behind the run RA profile: the run state's, else the one the run would pick (reads only). */
async function runCaConnector(api: GuardedApi): Promise<{ connector: string } | { skip: string }> {
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

async function readRunCaConnector(api: GuardedApi): Promise<{ connector: string } | { skip: string }> {
    const state = readRunState().raProfile;
    if (state) return { connector: await authorityConnectorName(api, state.authorityUuid) };
    const existing = await existingRaProfile(api);
    if (existing) return { connector: await authorityConnectorName(api, existing.authorityUuid) };
    const pick = await pickHealthyAuthority(api);
    return 'skip' in pick ? pick : { connector: pick.connectorName };
}

const notification = (kind: NotificationKind, label: string): Resolver => async ({ api }) => {
    const connector = await findNotificationConnector(api, kind);
    if (!connector) return `deploy gate: no connected ${label} notification connector registered on this tier (@needs:${label === 'e-mail' ? 'email' : 'webhook'}-provider)`;
    return connector.unhealthy ? `deploy gate: the ${label} notification connector ${connector.name} is not healthy (${connector.unhealthy})` : undefined;
};

const tool = (name: Parameters<typeof requireTool>[0]): Resolver => async () => requireTool(name);

/** One resolver per need; the record type makes a new `Needs` value fail to compile until it has one. */
const RESOLVERS: Record<Needs, Resolver> = {
    ca: async ({ api }) => {
        const found = await runCaConnector(api);
        return 'skip' in found ? found.skip : undefined;
    },
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
    'v1-discovery': async ({ api }) => generationGate(await findDiscoveryConnectors(api), 'v1'),
    'v2-discovery': async ({ api }) => generationGate(await findDiscoveryConnectors(api), 'v2'),
    'email-provider': notification('EMAIL', 'e-mail'),
    'webhook-provider': notification('WEBHOOK', 'webhook'),
    'smtp-catcher': async () => smtpCatcherProblem(),
    'webhook-receiver': async () => webhookReceiverProblem(),
    // The test opens its own runner-hosted TLS listener, and the connector row under test is the one it reads: their checks stay in the spec.
    'scan-target': async () => undefined,
    'connector-online': async () => undefined,
    openssl: tool('openssl'),
    sscep: tool('sscep'),
    docker: tool('docker'),
    cluster: async () => {
        // What the cert-manager row asks for: a kubeconfig, the namespace and the auth secret, then the tool and the namespaced permissions.
        const { kubeconfig, cmNamespace: namespace, cmAuthSecret } = settings();
        if (!kubeconfig || !namespace || !cmAuthSecret) return '@needs:cluster — cert-manager flow needs KUBECONFIG, REG_CM_NAMESPACE and REG_CM_AUTH_SECRET (no cluster configured)';
        const missing = requireTool('kubectl');
        if (missing) return `@needs:cluster — ${missing}`;
        const problem = clusterProblem(namespace);
        return problem ? `@needs:cluster — ${problem}` : undefined;
    },
};

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

/** The needs a test declared: its `@needs:<x>` tags (`testMeta({ needs })`), in tag order; a tag that is not in the catalogue is an error. */
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
