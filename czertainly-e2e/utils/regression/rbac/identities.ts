/**
 * identities — who is calling.
 *
 * WHAT: who is calling: the shared admin test user (the `api` fixture), throwaway own users that never sign in, no
 *       credentials, and the dedicated second identity (REG_RESTRICTED_USERNAME / REG_RESTRICTED_PASSWORD; rows that need it skip
 *       with `secondIdentityBlocker`, and no wrong-password attempt is ever made). `callAs` sends one request with another identity's
 *       token through the GUARDED context; `parseProfile` reads `GET /v1/auth/profile` (user fields top level, permissions below).
 * WHY: Permission rows need the admin, a throwaway user and a dedicated second identity, and must never guess a password.
 * HOW: `callAs` sends one request with another identity's token through the guarded context, `parseProfile` reads the profile, and a
 * missing second identity is a named skip.
 */
import { APIRequestContext, expect, Page } from '@playwright/test';
import { ApiAnswer, answerOf } from '../apiReads';
import type { GuardedApi } from '../guard/types';
import { leakReason } from '../errorContract';
import { isLocalTier } from '../tier/kind';
import { settings } from '../run/settings';
import type { JsonObject } from '../json';
import { rowsOf } from '../json';

export interface Credentials {
    username: string;
    password: string;
}

/** The tier setup that provides DED (assets/devops-requests.md item 2, with the follow-ups of item 4). */
export const SECOND_IDENTITY_REQUEST =
    'DevOps request 2 (a dedicated test account per tier: REG_RESTRICTED_USERNAME / REG_RESTRICTED_PASSWORD, plus the SYNC_POLICY / createUnknownUsers answers of request 4)';

/** DED from the environment, or undefined when either variable is unset. */
export function restrictedIdentity(env: NodeJS.ProcessEnv = process.env): Credentials | undefined {
    const { restrictedUsername: username, restrictedPassword: password } = settings(env);
    return username && password ? { username, password } : undefined;
}

/**
 * Why a row that needs the second identity cannot run, or undefined. The skip reason names the request. Guard of the
 * Guard: the DED username must differ from the admin's (case-insensitively) — the suite disables, re-roles
 * and signs out DED, never the admin.
 */
export function secondIdentityBlocker(adminUsername: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const dedicatedUser = restrictedIdentity(env);
    if (!dedicatedUser) return `[blocked: second identity] ${SECOND_IDENTITY_REQUEST} — set both variables once the account exists`;
    if (dedicatedUser.username.toLowerCase() === adminUsername.trim().toLowerCase()) {
        return 'REG_RESTRICTED_USERNAME equals the admin test user: the second identity must be a different account (the suite disables and re-roles it)';
    }
    return undefined;
}

/**
 * Why a `@needs:keycloak-local` row cannot run, or undefined: it needs a local stack (TIER_KIND=local, proven) whose
 * sign-in is an identity-provider form (AUTH_MODE=local), i.e. Keycloak in the local compose (the
 * development-environment overlay). A header-mode stack has no browser session and no token.
 */
export function keycloakLocalBlocker(authMode: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (!isLocalTier(env)) return '@needs:keycloak-local: a local stack (TIER_KIND=local) is required';
    if (authMode !== 'local') return `@needs:keycloak-local: the local stack signs in with AUTH_MODE=${authMode}; a Keycloak in the local compose (development-environment overlay, AUTH_MODE=local) is not set up`;
    return undefined;
}

// ------------------------------------------------------------------ the profile

interface ResourceActions {
    resource: string;
    actions: string[];
}

export interface Profile {
    uuid: string;
    username: string;
    enabled: boolean | undefined;
    roles: Array<{ uuid: string; name: string }>;
    allowedListings: string[];
    allowedActions: ResourceActions[];
}

/** Parse `GET /v1/auth/profile`; throws naming the missing part when the body is not a `UserProfileDetailDto`. */
export function parseProfile(body: unknown): Profile {
    const b = body as JsonObject | undefined;
    if (!b || typeof b !== 'object') throw new Error('the profile is not a JSON object');
    if (typeof b.username !== 'string' || !b.username) throw new Error('the profile has no top-level `username` (UserProfileDetailDto; the ledger text "user.username" is the pre-2.x shape)');
    const perms = b.permissions as JsonObject | undefined;
    if (!perms || !Array.isArray(perms.allowedListings) || !Array.isArray(perms.allowedActions)) {
        throw new Error('the profile has no `permissions.allowedListings` / `permissions.allowedActions`');
    }
    return {
        uuid: String(b.uuid),
        username: b.username,
        enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
        roles: Array.isArray(b.roles) ? b.roles.map((r: JsonObject) => ({ uuid: String(r.uuid), name: String(r.name) })) : [],
        allowedListings: perms.allowedListings.map(String),
        allowedActions: rowsOf(perms.allowedActions).map((a) => ({ resource: String(a.resource), actions: ((a.actions ?? []) as unknown[]).map(String) })),
    };
}

/** The signed-in user's profile (GET, read-only). */
export async function readProfile(api: APIRequestContext): Promise<Profile> {
    const res = await api.get('/api/v1/auth/profile');
    const text = await res.text();
    if (!res.ok()) throw new Error(`GET /api/v1/auth/profile → ${res.status()} ${text.slice(0, 300)}`);
    return parseProfile(JSON.parse(text));
}

/** True when an action code is one the platform never grants (`ANY` / `NONE`, any case). */
export const isNotGrantableAction = (action: string): boolean => /^(any|none)$/i.test(action);

/** The L-disable lockout guard: a state-changing call never targets the account that makes it. */
export async function assertNotCaller(api: APIRequestContext, targetUuid: string, what: string): Promise<void> {
    const me = await readProfile(api);
    if (me.uuid.toLowerCase() === targetUuid.toLowerCase()) throw new Error(`${what}: the target is the calling account itself (lockout guard)`);
}

// ------------------------------------------------------------------ one request with another identity

export type CallMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CallOptions {
    data?: unknown;
    /** Query parameters (an `access_token` in the query string is a PT-03 variant). */
    params?: Record<string, string>;
}

/**
 * One request with the given `authorization` header VALUE (e.g. `Bearer <token>`, `Basic <x>`), through the guarded
 * context: `identityOverride` replaces the context's own credentials for this request only. `undefined` sends no
 * identity header (the context's own credentials, or none on a credential-less context). Never throws on a refusal
 * status; the caller asserts it.
 */
export async function callWithAuthorization(api: GuardedApi, authorization: string | undefined, method: CallMethod, url: string, opts: CallOptions = {}): Promise<ApiAnswer> {
    const started = Date.now();
    const res = await api.fetch(url, {
        method,
        headers: { accept: 'application/json', ...(authorization === undefined ? {} : { authorization }) },
        ...(authorization === undefined ? {} : { identityOverride: true }),
        ...(opts.data === undefined ? {} : { data: opts.data }),
        ...(opts.params === undefined ? {} : { params: opts.params }),
        failOnStatusCode: false,
    });
    return answerOf(res, started);
}

/** One request as the identity that owns `token` (`Bearer <token>`); `undefined`: the context's own identity. */
export async function callAs(api: GuardedApi, token: string | undefined, method: CallMethod, url: string, data?: unknown): Promise<ApiAnswer> {
    return callWithAuthorization(api, token === undefined ? undefined : `Bearer ${token}`, method, url, { data });
}

// ------------------------------------------------------------------ anonymous reads (API-AUTH-01)

/** An RFC 5737 documentation-range address: never loopback, never a real caller. */
export const DOCUMENTATION_ADDRESS = '192.0.2.1';

export interface AnonymousTarget {
    /** The URL prefix: '' = relative to the config's baseURL (a shared tier); else the core's own origin (a local stack). */
    base: string;
    /** Headers of an anonymous request. */
    headers: Record<string, string>;
}

/**
 * Where an anonymous (no credentials) read goes. Shared tier: BASE_URL, no extra header (the ingress sets the real
 * client address). Local stack: a request with no credentials from a LOOPBACK address is the `localhost` system user
 * (`PlatformAuthenticationFilter`), and in header mode the dev proxy adds the admin certificate to every
 * /api call, so the call goes to the core's own port (REG_LOCAL_CORE_URL) with an `X-Forwarded-For` from the
 * documentation range (core reads that header first: `AuthHelper.java`), which makes the caller not loopback.
 */
export function anonymousTarget(env: NodeJS.ProcessEnv = process.env): AnonymousTarget {
    const core = settings(env).localCoreUrl?.replace(/\/+$/, '');
    if (isLocalTier(env) && core) return { base: core, headers: { 'X-Forwarded-For': DOCUMENTATION_ADDRESS, Accept: 'application/json' } };
    return { base: '', headers: { Accept: 'application/json' } };
}

/**
 * Why an error body leaks internals, or undefined: a stack trace, a Java exception class, a source line, or the servlet
 * container's default error page (auth-rbac G1: a refusal answers 401 and nothing else about the implementation).
 */
export function leaksInternals(text: string): string | undefined {
    return leakReason(text);
}

/**
 * Core replicas of the target (REG_CORE_REPLICAS, default 1). Rows that assert an effect "on the first request after the
 * change" (API-AUTH-06 / 37, REG-AUTH-07) need ONE replica: with more, a disabled user's token stays valid for the cache
 * TTL on the instances that did not process the change (documented, caching.md).
 */
export function coreReplicas(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(settings(env).coreReplicas);
    return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Why a "next request" row cannot run on this tier (more than one core replica), or undefined. */
export function replicaBlocker(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const n = coreReplicas(env);
    return n > 1 ? `${n} core replicas (REG_CORE_REPLICAS): a disabled user's token stays valid for the cache TTL on the other instances (DOC-C), so "refused on the next request" is not provable` : undefined;
}

// ------------------------------------------------------------------ roles after a UI sign-in

/**
 * Why a UI-signed-in DED does not hold the role the API barrier set — the sync policy, not RBAC. Under `SYNC_POLICY=sync-data`
 * the auth service replaces a user's roles with the token's `roles` at every sign-in (core#2226: "an assigned
 * role is removed after the user logs in"), so a fixture that was in force through the API is gone once DED signs in through the
 * browser. The row must fail with THIS message, never as a permission failure of the fixture. `undefined`: the roles agree.
 */
export function rolesAfterSignInProblem(profileRoleUuids: string[], expectedRoleUuids: string[]): string | undefined {
    const got = [...profileRoleUuids].sort();
    const want = [...expectedRoleUuids].sort();
    if (got.length === want.length && got.every((u, i) => u === want[i])) return undefined;
    return `The restricted user holds ${got.length} role(s) after the UI sign-in, the API barrier had set ${want.length} (other uuids): the auth service most likely runs SYNC_POLICY=sync-data and rewrote the roles at sign-in (DevOps request 4: the test account needs create-only; core#2226). This is a tier configuration problem, not an RBAC failure of the fixture.`;
}

/**
 * After the UI sign-in: the signed-in user's own session (`page.request`, a read) holds exactly the roles the API set; a
 * mismatch fails with the sync-policy message of `rolesAfterSignInProblem`, never later as an RBAC failure of the fixture.
 */
export async function expectRolesAfterSignIn(page: Page, expectedRoleUuids: string[]): Promise<void> {
    const res = await page.request.get('/api/v1/auth/profile');
    expect(res.status(), 'the signed-in user\'s profile').toBe(200);
    const problem = rolesAfterSignInProblem(parseProfile(await res.json()).roles.map((r) => r.uuid), expectedRoleUuids);
    if (problem) throw new Error(problem);
}
