/**
 * identities — who is calling: the shared admin test user, the dedicated second identity (rows that need it skip with
 * `secondIdentityBlocker`, and no wrong-password attempt is ever made), `callAs` through the guarded context, and `parseProfile`.
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

export const SECOND_IDENTITY_REQUEST = 'the identity-provider account of the tier\'s second test user: REG_RESTRICTED_USERNAME and REG_RESTRICTED_PASSWORD';

export function restrictedIdentity(env: NodeJS.ProcessEnv = process.env): Credentials | undefined {
    const { restrictedUsername: username, restrictedPassword: password } = settings(env);
    return username && password ? { username, password } : undefined;
}

/**
 * Why a row that needs the second identity cannot run, or undefined; its username must differ from the admin's: the suite disables,
 * re-roles and signs out that user.
 */
export function secondIdentityBlocker(adminUsername: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const dedicatedUser = restrictedIdentity(env);
    if (!dedicatedUser) {
        const { restrictedUsername, restrictedPassword } = settings(env);
        const missing = [!restrictedUsername && 'REG_RESTRICTED_USERNAME', !restrictedPassword && 'REG_RESTRICTED_PASSWORD'].filter(Boolean).join(' and ');
        return `[blocked: second identity] ${missing} not set (${SECOND_IDENTITY_REQUEST}; the password as a secret variable)`;
    }
    if (dedicatedUser.username.toLowerCase() === adminUsername.trim().toLowerCase()) {
        return 'REG_RESTRICTED_USERNAME equals the admin test user: the second identity must be a different account (the suite disables and re-roles it)';
    }
    return undefined;
}

/**
 * Why a `@needs:keycloak-local` row cannot run, or undefined: it needs a
 * proven local stack with an identity-provider sign-in (AUTH_MODE=local).
 */
export function keycloakLocalBlocker(authMode: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (!isLocalTier(env)) return '@needs:keycloak-local: a local stack (TIER_KIND=local) is required';
    if (authMode !== 'local') return `@needs:keycloak-local: the local stack signs in with AUTH_MODE=${authMode}; a Keycloak in the local compose (development-environment overlay, AUTH_MODE=local) is not set up`;
    return undefined;
}

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

export async function readProfile(api: APIRequestContext): Promise<Profile> {
    const res = await api.get('/api/v1/auth/profile');
    const text = await res.text();
    if (!res.ok()) throw new Error(`GET /api/v1/auth/profile → ${res.status()} ${text.slice(0, 300)}`);
    return parseProfile(JSON.parse(text));
}

export const isNotGrantableAction = (action: string): boolean => /^(any|none)$/i.test(action);

export async function assertNotCaller(api: APIRequestContext, targetUuid: string, what: string): Promise<void> {
    const me = await readProfile(api);
    if (me.uuid.toLowerCase() === targetUuid.toLowerCase()) throw new Error(`${what}: the target is the calling account itself (lockout guard)`);
}

export type CallMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CallOptions {
    data?: unknown;
    params?: Record<string, string>;
}

/**
 * One request with the given `authorization` header VALUE through the guarded context (`identityOverride`); `undefined` sends no identity
 * header. Never throws on a refusal status.
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

export async function callAs(api: GuardedApi, token: string | undefined, method: CallMethod, url: string, data?: unknown): Promise<ApiAnswer> {
    return callWithAuthorization(api, token === undefined ? undefined : `Bearer ${token}`, method, url, { data });
}

export const DOCUMENTATION_ADDRESS = '192.0.2.1';

export interface AnonymousTarget {
    base: string;
    headers: Record<string, string>;
}

/**
 * Where an anonymous read goes: BASE_URL on a shared tier; on a local stack the core's own port with an `X-Forwarded-For` from the
 * documentation range, so the caller is not loopback.
 */
export function anonymousTarget(env: NodeJS.ProcessEnv = process.env): AnonymousTarget {
    const core = settings(env).localCoreUrl?.replace(/\/+$/, '');
    if (isLocalTier(env) && core) return { base: core, headers: { 'X-Forwarded-For': DOCUMENTATION_ADDRESS, Accept: 'application/json' } };
    return { base: '', headers: { Accept: 'application/json' } };
}

/** Why an error body leaks internals (stack trace, Java exception class, source line, servlet default error page), or undefined. */
export function leaksInternals(text: string): string | undefined {
    return leakReason(text);
}

/**
 * Core replicas of the target (REG_CORE_REPLICAS, default 1); rows that assert an effect on the first request after a change need ONE
 * replica (token cache TTL).
 */
export function coreReplicas(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(settings(env).coreReplicas);
    return Number.isInteger(n) && n >= 1 ? n : 1;
}

export function replicaBlocker(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const n = coreReplicas(env);
    return n > 1 ? `${n} core replicas (REG_CORE_REPLICAS): a disabled user's token stays valid for the cache TTL on the other instances (DOC-C), so "refused on the next request" is not provable` : undefined;
}

/**
 * Why a UI-signed-in user does not hold the role the API set: under `SYNC_POLICY=sync-data` the auth service replaces roles with the
 * token's at every sign-in (core#2226).
 */
export function rolesAfterSignInProblem(profileRoleUuids: string[], expectedRoleUuids: string[]): string | undefined {
    const got = [...profileRoleUuids].sort();
    const want = [...expectedRoleUuids].sort();
    if (got.length === want.length && got.every((u, i) => u === want[i])) return undefined;
    return `The restricted user holds ${got.length} role(s) after the UI sign-in, the API barrier had set ${want.length} (other uuids): the auth service most likely runs SYNC_POLICY=sync-data and rewrote the roles at sign-in (DevOps request 4: the test account needs create-only; core#2226). This is a tier configuration problem, not an RBAC failure of the fixture.`;
}

/** After the UI sign-in: the user's own session holds exactly the roles the API set; a mismatch fails with the sync-policy message. */
export async function expectRolesAfterSignIn(page: Page, expectedRoleUuids: string[]): Promise<void> {
    const res = await page.request.get('/api/v1/auth/profile');
    expect(res.status(), 'the signed-in user\'s profile').toBe(200);
    const problem = rolesAfterSignInProblem(parseProfile(await res.json()).roles.map((r) => r.uuid), expectedRoleUuids);
    if (problem) throw new Error(problem);
}
