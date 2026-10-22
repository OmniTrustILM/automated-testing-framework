/**
 * regressionFixtures — the spec-facing fixtures of the REG-* and API-* suites, on top of the smoke-sized fixtures/testFixtures.ts.
 *
 * WHAT: `test` is `testFixtures.test` plus seven fixtures, and `expect` is re-exported with it:
 *   - `needs`: `needs.require('ca', 'second-identity')`, or one method per need (`needs.ca()`, `needs.secondIdentity()`,
 *     `needs.v2Discovery()`; `needs.platformTriggersFree(EVENT.registered)`, `needs.registrationSettings({ minFailedAttempts: 3 })` and
 *     `needs.requiredAttributesFillable('raProfiles')` take what the row depends on): resolves what the test needs from READS and skips the
 *     test with the named reason of the first unmet need. The needs a test declares in `testMeta({ needs })` are resolved by an automatic
 *     fixture before any `own` or page call.
 *   - `own`: the own-object creators and ledger steps bound to the test's ledger id (`own.group('g1')`, `own.record('groups', answer)`,
 *     `own.recordNamed(cn, note)`, `own.deleted('groups', ref)`; utils/regression/ownObjects.ts).
 *   - `live`: `await live('roles', ref)` runs the live own-object check and returns the `LiveOwn` handle that page actions take.
 *   - `signedIn`: the admin page after the sign-in (the sign-in and sign-out specs keep their explicit logins).
 *   - `regressionEnv`: the typed reader of the REG_* / API_* settings.
 *   - `localApi`: the guarded API of a `@local` row on a proven local stack (the guard's `localStack` option).
 *   - `workerApi` (worker scope): the guarded API of the admin identity for a worker-scoped fixture, built through the same guard factory
 *     as `api` and kept for the worker; a worker fixture never builds a raw context.
 * WHY: a spec used to repeat the same choreography by hand: sign in inside the test, a `const SPEC` next to its `testMeta` id, the
 *      record-then-assert block after every submit, a skip decided differently in every file, a hand-built local-stack context in
 *      `beforeEach`. Each of these is a place where a safety step could be forgotten; here the step is the fixture's job.
 * HOW: fixtures are test-scoped and lazy: a test that does not name one never builds it. `testFixtures.ts` stays unchanged for the
 *      smoke suite, which must not load more than before. Every name is registered in the spec lint (utils/regression/specLint/rules.ts
 *      and bindings.ts) so that `test.use({ … })` cannot replace it and a mutation through `localApi` is judged like one through `api`.
 */
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { ledgerSpecOf, loginAsSmokeUser, test as testFixtures } from './testFixtures';
import { loadEnv, type TestEnv } from '../utils/env';
import { minLifetimeForTest } from '../utils/auth/accessToken';
import { getAuthenticatedApiContext } from '../utils/auth/apiContext';
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

/** A worker's guarded context is built once and kept for the worker: its token must outlive a long stretch of tests. */
export const WORKER_API_MIN_LIFETIME_MS = 600_000;

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
 * the token request and is disposed right after the grant.
 */
export async function withWorkerApi(grantContext: APIRequestContext, env: TestEnv, use: (api: GuardedApi) => Promise<void>): Promise<void> {
    const api = guardApi(await getAuthenticatedApiContext(grantContext, env, { minLifetimeMs: WORKER_API_MIN_LIFETIME_MS }));
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
