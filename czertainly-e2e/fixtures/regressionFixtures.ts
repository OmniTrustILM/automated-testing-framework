/**
 * regressionFixtures — the fixtures of the REG-* and API-* specs, on top of fixtures/testFixtures.ts.
 *
 * Adds to `test`:
 *   - needs: skips the test, with the reason, when the tier lacks something it needs (a CA, a second user, …)
 *   - own: creates the test's own objects and records them in the run ledger
 *   - live: checks that an object belongs to this run before a page acts on it
 *   - signedIn, regressionEnv: the signed-in admin page and the REG_* / API_* settings
 *   - localApi: the guarded API for a `@local` row on a proven local stack (throws elsewhere); workerApi: the guarded
 *     admin API for worker-scoped fixtures
 *
 * Every fixture name is registered in the spec lint, so a spec cannot replace it.
 */
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { ledgerSpecOf, loginAsSmokeUser, test as testFixtures } from './testFixtures';
import { loadEnv, type TestEnv } from '../utils/env';
import { minLifetimeForTest } from '../utils/auth/accessToken';
import { getAuthenticatedApiContext, openAuthenticatedApiContext } from '../utils/auth/apiContext';
import { renewingContext } from '../utils/auth/renewingContext';
import { guardApi } from '../utils/regression/guard/createGuard';
import type { GuardedApi } from '../utils/regression/guard/types';
import { LiveOwn } from '../utils/regression/ledger/liveOwn';
import type { EventCode } from '../utils/regression/events/eventVocabulary';
import { declaredNeedsOf, resolveNeeds, type NeedOptions } from '../utils/regression/needs';
import { ownObjects, type OwnObjects } from '../utils/regression/ownObjects';
import { settings } from '../utils/regression/run/settings';
import { hasLocalProof } from '../utils/regression/tier/localProof';
import { isLocalTier } from '../utils/regression/tier/kind';
import { NEEDS, type Needs } from '../utils/regression/tags';

export { expect, ledgerSpecOf, loginAsSmokeUser } from './testFixtures';
export { LiveOwn };

/** `second-identity` → `secondIdentity`: the method name of a need. */
type CamelCase<S extends string> = S extends `${infer A}-${infer B}` ? `${A}${Capitalize<CamelCase<B>>}` : S;

/** The needs whose check depends on the row: their method takes the row's option instead of nothing. */
type OptionNeeds = 'platform-triggers-free' | 'registration-settings' | 'required-attributes-fillable';

/** The `needs` fixture: `require(...)`, one no-argument method per need and three methods that take what the row depends on. */
export type NeedsApi = { [N in Exclude<Needs, OptionNeeds> as CamelCase<N>]: () => Promise<void> } & {
    /** Resolves the needs from reads; skips the test with the named reason of the first unmet one. */
    require(...wanted: Needs[]): Promise<void>;
    /** No platform-level trigger listens on any of these events (default: every event). */
    platformTriggersFree(...events: EventCode[]): Promise<void>;
    /** The platform's registration settings can hold the row's registration (`minFailedAttempts`: the table's need, default 1). */
    registrationSettings(options?: { minFailedAttempts?: number }): Promise<void>;
    /** Every required custom attribute of these resources is one the suite can fill (default certificates and RA profiles). */
    requiredAttributesFillable(...resources: string[]): Promise<void>;
};

/** The typed REG_* / API_* settings (utils/regression/run/settings.ts). */
export type RegressionEnv = ReturnType<typeof settings>;

/** The fixtures of the worker: one guarded API context for the fixtures that build something once per worker. */
export interface RegressionWorkerFixtures {
    workerApi: GuardedApi;
}

/**
 * A worker's guarded context is kept for the whole worker, which outlives one access token (a hook before a group and a hook after it
 * are minutes apart): the context renews itself when its token has less than this left (utils/auth/renewingContext.ts).
 */
export const WORKER_API_RENEW_MARGIN_MS = 120_000;

export interface RegressionFixtures {
    needs: NeedsApi;
    /** Automatic: resolves the needs the test declared before any other regression fixture is built. */
    declaredNeeds: void;
    own: OwnObjects;
    live: <Type extends string>(type: Type, ref: { uuid: string; name?: string }) => Promise<LiveOwn<Type>>;
    signedIn: Page;
    regressionEnv: RegressionEnv;
    localApi: GuardedApi;
}

const camel = (need: string): string => need.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * The `needs` API of one test: every unmet need ends the test as a skip with its reason (the test body never runs on). `guardedApi`
 * builds the context the resolvers read through, on the first need only: a test that declares none never signs in to the API.
 */
export function needsApi(guardedApi: () => Promise<GuardedApi>, env: TestEnv, skip: (reason: string) => void): NeedsApi {
    const requireWith = async (wanted: readonly Needs[], options?: NeedOptions): Promise<void> => {
        const reason = wanted.length ? await resolveNeeds(wanted, { api: await guardedApi(), env, options }) : undefined;
        if (reason !== undefined) skip(reason);
    };
    const require = (...wanted: Needs[]): Promise<void> => requireWith(wanted);
    const bound = Object.fromEntries(NEEDS.map((need) => [camel(need), () => require(need)]));
    return {
        ...bound,
        require,
        platformTriggersFree: (...events: EventCode[]) => requireWith(['platform-triggers-free'], events.length ? { events } : undefined),
        registrationSettings: (options) => requireWith(['registration-settings'], options),
        requiredAttributesFillable: (...resources: string[]) => requireWith(['required-attributes-fillable'], resources.length ? { resources } : undefined),
    } as NeedsApi;
}

/**
 * Why a test may not take `localApi`, or undefined: a proven local stack and a `@local` row (which `describeLocalOnly` guards in the spec).
 */
export function localApiProblem(tagsOfTest: readonly string[]): string | undefined {
    if (!isLocalTier()) return 'only a local stack (TIER_KIND=local) may take it';
    if (!hasLocalProof()) return 'this run holds no authenticated local-backend proof (API-GEN-33, guard row)';
    if (!tagsOfTest.includes('@local')) return 'only a @local row (testMeta({ local: true }) with describeLocalOnly(test)) may take it';
    return undefined;
}

/**
 * The body of the `localApi` fixture: refuses (throws, `use` never called) unless the test may take it, then hands over the local-stack
 * guard and disposes it. A function of its own so that the refusal can be tested without running a failing test.
 */
export async function withLocalApi(
    request: APIRequestContext, env: TestEnv, testInfo: Pick<TestInfo, 'tags' | 'timeout'>, use: (api: GuardedApi) => Promise<void>,
): Promise<void> {
    const problem = localApiProblem(testInfo.tags);
    if (problem) throw new Error(`localApi: ${problem}`);
    const api = guardApi(await getAuthenticatedApiContext(request, env, { minLifetimeMs: minLifetimeForTest(testInfo.timeout) }), { localStack: true });
    try {
        await use(api);
    } finally {
        await api.dispose();
    }
}

/**
 * The body of the `workerApi` fixture: the authenticated context of the admin identity, wrapped in the guard (`guardApi`, the same
 * factory as the test-scoped `api`; a raw context is never handed to a fixture), disposed when the worker ends. `grantContext` only sends
 * the token request; it stays open while the worker lives, because the context renews its token (a new grant) when less than
 * WORKER_API_RENEW_MARGIN_MS of it is left. `localStack: true` is for a block that runs on a proven local stack only: it refuses (throws,
 * `use` never called) unless the tier is local and holds the local-backend proof, and gives the guard its `localStack` option.
 */
export async function withWorkerApi(
    grantContext: APIRequestContext, env: TestEnv, use: (api: GuardedApi) => Promise<void>,
    options: { localStack?: boolean; renewMarginMs?: number; now?: () => number } = {},
): Promise<void> {
    if (options.localStack) {
        if (!isLocalTier()) throw new Error('workerApi: only a local stack (TIER_KIND=local) may take the local-stack guard');
        if (!hasLocalProof()) throw new Error('workerApi: this run holds no authenticated local-backend proof (API-GEN-33, guard row)');
    }
    const margin = options.renewMarginMs ?? WORKER_API_RENEW_MARGIN_MS;
    const context = renewingContext(
        () => openAuthenticatedApiContext(grantContext, env, { minLifetimeMs: margin }),
        { marginMs: margin, ...(options.now ? { now: options.now } : {}) },
    );
    const api = guardApi(context, options.localStack ? { localStack: true } : {});
    try {
        await use(api);
    } finally {
        await api.dispose();
    }
}

export const test = testFixtures.extend<RegressionFixtures, RegressionWorkerFixtures>({
    workerApi: [async ({ playwright }, use) => {
        const grantContext = await playwright.request.newContext({ ignoreHTTPSErrors: true });
        try {
            await withWorkerApi(grantContext, loadEnv(), use);
        } finally {
            await grantContext.dispose();
        }
    }, { scope: 'worker' }],
    regressionEnv: async ({}, use) => use(settings()),
    needs: async ({ request, env }, use, testInfo) => {
        let api: GuardedApi | undefined;
        const guardedApi = async (): Promise<GuardedApi> => (api ??= guardApi(await getAuthenticatedApiContext(request, env, { minLifetimeMs: minLifetimeForTest(testInfo.timeout) })));
        try {
            await use(needsApi(guardedApi, env, (reason) => testInfo.skip(true, reason)));
        } finally {
            await api?.dispose();
        }
    },
    declaredNeeds: [async ({ needs }, use, testInfo) => {
        // The tags of the test are the declaration: resolved from reads, before `own`, `live`, `signedIn` or any page call.
        const wanted = declaredNeedsOf(testInfo.tags);
        if (wanted.length) await needs.require(...wanted);
        await use();
    }, { auto: true }],
    own: async ({ api, declaredNeeds: _declared }, use, testInfo) => use(ownObjects(api, ledgerSpecOf(testInfo), (reason) => testInfo.skip(true, reason))),
    live: async ({ api, declaredNeeds: _declared }, use) => use((type, ref) => LiveOwn.prove(api, type, ref, 'live')),
    signedIn: async ({ page, env, declaredNeeds: _declared }, use) => {
        await loginAsSmokeUser(page, env);
        await use(page);
    },
    localApi: async ({ request, env }, use, testInfo) => withLocalApi(request, env, testInfo, use),
});
