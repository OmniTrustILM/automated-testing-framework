/**
 * identities — who is calling (auth-rbac area, B2 / B3; phase-05 `identities.ts`).
 *
 * ADM  the shared admin test user: the `api` fixture and `loginAsSmokeUser`. It holds every resource, so it can never be
 *      refused (403): every 403 needs DED.
 * TMP  a throwaway ILM user the test creates for itself (`createOwnUser`): no identity-provider account, it can never
 *      sign in, so it is safe for state, role and membership rows and needs no second identity.
 * ANON no credentials: the `request` fixture for a GET, a credential-less guarded context for anything else
 *      (guard request GR-1, see the patches README).
 * DED  the dedicated second identity (decision Q2, DevOps request 2): one identity-provider account per shared tier,
 *      named by REG_RESTRICTED_USERNAME / REG_RESTRICTED_PASSWORD. Rows that need it skip with `secondIdentityBlocker`
 *      until it exists; the suite never makes a wrong-password attempt anywhere (a wrong password tests the IdP, not ILM,
 *      and could lock the shared account).
 *
 * `callAs` sends one request with another identity's bearer token through the GUARDED context (`identityOverride`, the
 * guard's switch for 401 / 403 negatives): every ownership rule still applies to what the request names.
 *
 * The profile of `GET /v1/auth/profile` is `UserProfileDetailDto` (interfaces, core `AuthServiceImpl.getAuthProfile`): the
 * user fields are TOP-LEVEL (`uuid`, `username`, `enabled`, `roles`) and the permissions sit under `permissions`
 * (`allowedListings`: resource codes; `allowedActions`: `[{ resource, actions }]`). The ledger text "user.username" /
 * "allowedListings" predates that read of the code; `parseProfile` accepts only the real shape and names the difference.
 */
import { APIRequestContext } from '@playwright/test';
import type { GuardedApi } from './guardedApi';
import { isLocalTier } from './tier';

export interface Credentials {
    username: string;
    password: string;
}

/** The DevOps request that provides DED (assets/devops-requests.md item 2, with the follow-ups of item 4). */
export const SECOND_IDENTITY_REQUEST =
    'DevOps request 2 (a dedicated test account per tier: REG_RESTRICTED_USERNAME / REG_RESTRICTED_PASSWORD, plus the SYNC_POLICY / createUnknownUsers answers of request 4)';

/** DED from the environment, or undefined when either variable is unset. */
export function restrictedIdentity(env: NodeJS.ProcessEnv = process.env): Credentials | undefined {
    const username = env.REG_RESTRICTED_USERNAME?.trim();
    const password = env.REG_RESTRICTED_PASSWORD;
    return username && password ? { username, password } : undefined;
}

/**
 * Why a row that needs the second identity cannot run, or undefined. The skip reason names the request. Guard of the
 * plan (auth-rbac §0): the DED username must differ from the admin's (case-insensitively) — the suite disables, re-roles
 * and signs out DED, never the admin.
 */
export function secondIdentityBlocker(adminUsername: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const ded = restrictedIdentity(env);
    if (!ded) return `[blocked: second identity] ${SECOND_IDENTITY_REQUEST} — set both variables once the account exists`;
    if (ded.username.toLowerCase() === adminUsername.trim().toLowerCase()) {
        return 'REG_RESTRICTED_USERNAME equals the admin test user: the second identity must be a different account (the suite disables and re-roles it)';
    }
    return undefined;
}

/**
 * Why a `@needs:keycloak-local` row cannot run, or undefined: it needs a local stack (TIER_KIND=local, proven) whose
 * sign-in is an identity-provider form (AUTH_MODE=local), i.e. Keycloak in the local compose (decision D3, the
 * development-environment overlay). A header-mode stack has no browser session and no token.
 */
export function keycloakLocalBlocker(authMode: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (!isLocalTier(env)) return '@needs:keycloak-local: a local stack (TIER_KIND=local) is required';
    if (authMode !== 'local') return `@needs:keycloak-local: the local stack signs in with AUTH_MODE=${authMode}; a Keycloak in the local compose (decision D3 overlay, AUTH_MODE=local) is not set up`;
    return undefined;
}

// ------------------------------------------------------------------ the profile

export interface ResourceActions {
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

type Json = Record<string, any>;

/** Parse `GET /v1/auth/profile`; throws naming the missing part when the body is not a `UserProfileDetailDto`. */
export function parseProfile(body: unknown): Profile {
    const b = body as Json | undefined;
    if (!b || typeof b !== 'object') throw new Error('the profile is not a JSON object');
    if (typeof b.username !== 'string' || !b.username) throw new Error('the profile has no top-level `username` (UserProfileDetailDto; the ledger text "user.username" is the pre-2.x shape)');
    const perms = b.permissions as Json | undefined;
    if (!perms || !Array.isArray(perms.allowedListings) || !Array.isArray(perms.allowedActions)) {
        throw new Error('the profile has no `permissions.allowedListings` / `permissions.allowedActions`');
    }
    return {
        uuid: String(b.uuid),
        username: b.username,
        enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
        roles: Array.isArray(b.roles) ? b.roles.map((r: Json) => ({ uuid: String(r.uuid), name: String(r.name) })) : [],
        allowedListings: perms.allowedListings.map(String),
        allowedActions: perms.allowedActions.map((a: Json) => ({ resource: String(a.resource), actions: (a.actions ?? []).map(String) })),
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

/** The L-disable lockout guard (plan §0): a state-changing call never targets the account that makes it. */
export async function assertNotCaller(api: APIRequestContext, targetUuid: string, what: string): Promise<void> {
    const me = await readProfile(api);
    if (me.uuid.toLowerCase() === targetUuid.toLowerCase()) throw new Error(`${what}: the target is the calling account itself (lockout guard)`);
}

// ------------------------------------------------------------------ one request with another identity

export interface Answered {
    status: number;
    contentType: string;
    text: string;
    json: any;
    elapsedMs: number;
}

/** Parse a body as JSON when it is, else undefined (a 401 may carry no body). */
function jsonOrUndefined(text: string): any {
    if (!text.trim()) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

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
export async function callWithAuthorization(api: GuardedApi, authorization: string | undefined, method: CallMethod, url: string, opts: CallOptions = {}): Promise<Answered> {
    const started = Date.now();
    const res = await api.fetch(url, {
        method,
        headers: { accept: 'application/json', ...(authorization === undefined ? {} : { authorization }) },
        ...(authorization === undefined ? {} : { identityOverride: true }),
        ...(opts.data === undefined ? {} : { data: opts.data }),
        ...(opts.params === undefined ? {} : { params: opts.params }),
        failOnStatusCode: false,
    });
    const text = await res.text();
    return { status: res.status(), contentType: res.headers()['content-type'] ?? '', text, json: jsonOrUndefined(text), elapsedMs: Date.now() - started };
}

/** One request as the identity that owns `token` (`Bearer <token>`); `undefined`: the context's own identity. */
export async function callAs(api: GuardedApi, token: string | undefined, method: CallMethod, url: string, data?: unknown): Promise<Answered> {
    return callWithAuthorization(api, token === undefined ? undefined : `Bearer ${token}`, method, url, { data });
}

/** The 403 body contract (auth-rbac G2): problem+json, `code: ACCESS_DENIED`, `message` = `Access Denied. Required '<Action>' permission for '<Resource>'`. */
export function accessDeniedMessage(action: string, resource: string): string {
    return `Access Denied. Required '${action}' permission for '${resource}'`;
}

/** The lock widget of a 403 (FE `getLockWidgetObject`): title for code ACCESS_DENIED, text = the server's message, hint in a tooltip. */
export const LOCK_TITLE = 'Access Denied';
export const LOCK_HINT = 'Please contact your admin to get access';

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
 * (auth-rbac A10, `PlatformAuthenticationFilter`), and in header mode the dev proxy adds the admin certificate to every
 * /api call, so the call goes to the core's own port (REG_LOCAL_CORE_URL) with an `X-Forwarded-For` from the
 * documentation range (core reads that header first: `AuthHelper.java:304-326`), which makes the caller not loopback.
 */
export function anonymousTarget(env: NodeJS.ProcessEnv = process.env): AnonymousTarget {
    const core = env.REG_LOCAL_CORE_URL?.replace(/\/+$/, '');
    if (isLocalTier(env) && core) return { base: core, headers: { 'X-Forwarded-For': DOCUMENTATION_ADDRESS, Accept: 'application/json' } };
    return { base: '', headers: { Accept: 'application/json' } };
}

/**
 * Why an error body leaks internals, or undefined: a stack trace, a Java exception class, a source line, or the servlet
 * container's default error page (auth-rbac G1: a refusal answers 401 and nothing else about the implementation).
 */
export function leaksInternals(text: string): string | undefined {
    if (/Whitelabel/i.test(text)) return 'the Whitelabel error page';
    if (/\n\s+at\s+[\w.$<>]+\(/.test(text) || /\bat\s+[\w.$]+\([\w.]+\.java:\d+\)/.test(text)) return 'a stack trace';
    if (/\b[a-z][\w]*(?:\.[a-z][\w]*)+\.[A-Z]\w*(?:Exception|Error)\b/.test(text)) return 'a Java exception class';
    if (/\.java:\d+/.test(text)) return 'a source file reference';
    return undefined;
}

/**
 * Core replicas of the target (REG_CORE_REPLICAS, default 1). Rows that assert an effect "on the first request after the
 * change" (API-AUTH-06 / 37, REG-AUTH-07) need ONE replica: with more, a disabled user's token stays valid for the cache
 * TTL on the instances that did not process the change (documented, caching.md; rules B5).
 */
export function coreReplicas(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(env.REG_CORE_REPLICAS ?? '1');
    return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Why a "next request" row cannot run on this tier (more than one core replica), or undefined. */
export function replicaBlocker(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const n = coreReplicas(env);
    return n > 1 ? `${n} core replicas (REG_CORE_REPLICAS): a disabled user's token stays valid for the cache TTL on the other instances (auth-rbac B5, DOC-C), so "refused on the next request" is not provable` : undefined;
}

// ------------------------------------------------------------------ roles after a UI sign-in (Fable F6)

/**
 * Why a UI-signed-in DED does not hold the role the API barrier set — the sync policy, not RBAC. Under `SYNC_POLICY=sync-data`
 * the auth service replaces a user's roles with the token's `roles` at every sign-in (auth-rbac A7; core#2226: "an assigned
 * role is removed after the user logs in"), so a fixture that was in force through the API is gone once DED signs in through the
 * browser. The row must fail with THIS message, never as a permission failure of the fixture. `undefined`: the roles agree.
 */
export function rolesAfterSignInProblem(profileRoleUuids: string[], expectedRoleUuids: string[]): string | undefined {
    const got = [...profileRoleUuids].sort();
    const want = [...expectedRoleUuids].sort();
    if (got.length === want.length && got.every((u, i) => u === want[i])) return undefined;
    return `DED holds ${got.length} role(s) after the UI sign-in, the API barrier had set ${want.length} (other uuids): the auth service most likely runs SYNC_POLICY=sync-data and rewrote the roles at sign-in (DevOps request 4: the test account needs create-only; core#2226). This is a tier configuration problem, not an RBAC failure of the fixture.`;
}
