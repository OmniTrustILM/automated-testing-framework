import { test as base, Page, APIRequestContext, request as playwrightRequest, expect } from '@playwright/test';
import { loadEnv, TestEnv } from '../utils/env';
import { LoginPage } from '../pages/LoginPage';
import { Logger } from '../utils/Logger';
import { guardApi, GuardedApi, GuardOptions } from '../utils/regression/guardedApi';
import * as fs from 'fs';
import * as path from 'path';
import { currentRunId, regressionStateDir } from '../utils/regression/runId';
import { isLocalTier, isLoopbackHost, isPrivateAddress } from '../utils/regression/tier';
import { restrictedIdentity, type Credentials } from '../utils/regression/identities';

const logger = new Logger('TestFixtures');

export { expect };

/**
 * Direct API authentication via Keycloak (Resource Owner Password Credentials flow).
 * Returns an APIRequestContext authorized with the Bearer token.
 */
export async function getAuthenticatedApiContext(request: APIRequestContext, env: TestEnv): Promise<APIRequestContext> {
  if (env.authMode === 'header') {
    // Local development stack: no identity provider. The dev proxy injects the certificate on /api; when the
    // suite talks to core directly, AUTH_CLIENT_CERT (URL-encoded Base64 certificate) is sent the same way.
    const cert = process.env.AUTH_CLIENT_CERT;
    logger.info(`AUTH_MODE=header: ${cert ? 'sending ssl-client-cert' : 'relying on the dev proxy'} for API calls`);
    return await playwrightRequest.newContext({
      baseURL: env.baseUrl,
      extraHTTPHeaders: { Accept: 'application/json', ...(cert ? { 'ssl-client-cert': cert } : {}) },
      ignoreHTTPSErrors: true,
    });
  }
  const authBase = env.authBaseUrl ? env.authBaseUrl.replace(/\/$/, '') : `${env.baseUrl.replace(/\/$/, '')}/kc`;
  const tokenUrl = `${authBase}/realms/${env.authRealm}/protocol/openid-connect/token`;

  if (!env.clientSecret) {
    logger.error('SMOKE_CLIENT_SECRET is missing, but it is required for API authentication via Keycloak.');
    throw new Error('SMOKE_CLIENT_SECRET is missing, but it is required for API authentication via Keycloak.');
  }

  logger.debug(`Fetching access token from: ${tokenUrl} for user: ${env.username}`);

  const response = await request.post(tokenUrl, {
    form: {
      grant_type: 'password',
      client_id: env.authClientId,
      client_secret: env.clientSecret,
      username: env.username,
      password: env.password,
    }
  });

  if (!response.ok()) {
    const errorBody = await response.text();
    logger.error(`Failed to get access token! Status: ${response.status()} ${response.statusText()}`);
    throw new Error(`Failed to get access token! Status: ${response.status()} ${response.statusText()} \nBody: ${errorBody}`);
  }

  const tokenData = await response.json();
  const accessToken = tokenData.access_token;

  if (!accessToken) {
    logger.error('Keycloak response did not contain access_token!');
    throw new Error('Keycloak response did not contain access_token!');
  }

  logger.info('Successfully obtained access token via API.');

  return await playwrightRequest.newContext({
    baseURL: env.baseUrl,
    extraHTTPHeaders: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
    ignoreHTTPSErrors: true
  });
}

// ------------------------------------------------------------------ the second identity (guard-integration pass, GD-02 / GD-03)

// DED (REG_RESTRICTED_USERNAME / REG_RESTRICTED_PASSWORD) and its credentials shape come from the auth area's
// identities.ts (merge 2026-10-15: replaces the self-contained copy the guard pass carried).
export { restrictedIdentity };
export type { Credentials };

// ------------------------------------------------------------------ access tokens (GD-02: auth GR-2 + inventory GR-I5)

/**
 * An access token a spec may hold without being able to print it (GD-02 limit 1): `String(token)`, `JSON.stringify`
 * and a template literal give `[token]`; `bearer()` is the only way to the raw string (the `authorization` header value
 * of `callAs` / `callWithAuthorization` / `identityOverride`, or an argument of jwtTools); `claims()` decodes the
 * payload without verifying anything.
 */
export interface AccessToken {
  bearer(): string;
  claims(): Record<string, unknown>;
  /** `exp` in milliseconds (0 when unreadable). */
  readonly expiresAt: number;
  toString(): string;
  toJSON(): string;
}

const REDACTED = '[token]';

/** The payload of a compact JWT, or {} when unreadable (never verified: only used for `exp` and the claims a spec asserts). */
function claimsOf(token: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `exp` of a compact JWT in milliseconds, 0 when unreadable. */
export function expiryOf(token: string): number {
  const exp = claimsOf(token).exp;
  return typeof exp === 'number' ? exp * 1000 : 0;
}

/** The opaque wrapper of a raw token (GD-02 limit 1). */
export function opaqueToken(raw: string): AccessToken {
  const token: AccessToken = {
    bearer: () => raw,
    claims: () => claimsOf(raw),
    expiresAt: expiryOf(raw),
    toString: () => REDACTED,
    toJSON: () => REDACTED,
  };
  // The raw string is reachable through `bearer()` only: not an own enumerable property, not inspectable.
  Object.defineProperty(token, Symbol.for('nodejs.util.inspect.custom'), { value: () => REDACTED, enumerable: false });
  return Object.freeze(token);
}

/** A token endpoint refused the grant (or answered without a token) once for an identity in this process. */
export class TokenGrantFailed extends Error {
  constructor(readonly identity: string, readonly detail: string, readonly cached: boolean) {
    super(`token grant for identity "${identity}" ${cached ? 'failed earlier in this process' : 'failed'} (${detail}); not retried: a repeated failed ` +
      'password grant can lock the account at the identity provider (REG_RESTRICTED_* / SMOKE_* must be fixed first)');
    this.name = 'TokenGrantFailed';
  }
}

/** The skip reason of a spec that takes `restrictedToken` after the grant failed once (coordinator addition, F4). */
export const RESTRICTED_TOKEN_UNAVAILABLE =
  'restricted identity unavailable: token grant failed once — check REG_RESTRICTED_*; not retried to avoid an account lockout';
/** The skip reason of a spec that takes `adminToken` after the admin grant failed once. */
export const ADMIN_TOKEN_UNAVAILABLE = 'admin token unavailable: token grant failed once — check SMOKE_USERNAME / SMOKE_PASSWORD / SMOKE_CLIENT_SECRET; not retried';

/** Reuse a token until this long before it expires. */
export const TOKEN_REUSE_MARGIN_MS = 60_000;

/** Per process: a cached token per identity and base URL (GD-02 u1), and the identities whose grant failed (limit 2). */
const tokenCache = new Map<string, AccessToken>();
const tokenFailures = new Map<string, string>();

/**
 * Review F2: the failure memory must outlive the worker (Playwright restarts a worker after a failed test; the logout and
 * non-interference projects run in workers of their own), so it is also persisted in REG_STATE_DIR as
 * `<run id>.token-failures.json`, keyed by `<base URL>|<username>`. The key is written BEFORE the grant is sent (a worker
 * that dies mid-grant, or a request that times out after it left, leaves the key behind = failed) and removed on
 * success. A connection refusal (the request never left) is not a grant failure: nothing is remembered.
 */
export const tokenFailureFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(regressionStateDir(env), `${currentRunId(env)}.token-failures.json`);

function readTokenFailures(env: NodeJS.ProcessEnv): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenFailureFile(env), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeTokenFailures(env: NodeJS.ProcessEnv, map: Record<string, string>): void {
  const file = tokenFailureFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
}

function rememberTokenFailure(key: string, detail: string, env: NodeJS.ProcessEnv): void {
  tokenFailures.set(key, detail);
  writeTokenFailures(env, { ...readTokenFailures(env), [key]: detail });
}

function forgetTokenFailure(key: string, env: NodeJS.ProcessEnv): void {
  tokenFailures.delete(key);
  const map = readTokenFailures(env);
  if (Object.hasOwn(map, key)) {
    delete map[key];
    if (Object.keys(map).length) writeTokenFailures(env, map);
    else fs.rmSync(tokenFailureFile(env), { force: true });
  }
}

/** The remembered failure of a key: this process first, then the run's file (another worker's memory). */
const rememberedTokenFailure = (key: string, env: NodeJS.ProcessEnv): string | undefined => tokenFailures.get(key) ?? readTokenFailures(env)[key];

/** Node error codes of a request that never left (the identity provider was not reached): not a grant failure. */
const NOT_REACHED = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|EADDRNOTAVAIL/;

/** Unit tests only: forget every cached token and failure (the process's and the run's file). */
export function resetTokenCacheForUnitTests(env: NodeJS.ProcessEnv = process.env): void {
  tokenCache.clear();
  tokenFailures.clear();
  fs.rmSync(tokenFailureFile(env), { force: true });
}

export interface TokenGrantOptions {
  /** The clock (unit tests). */
  now?: () => number;
  /** The environment the run id and REG_STATE_DIR are read from (unit tests). */
  env?: NodeJS.ProcessEnv;
  /** The grant request timeout (default 30 s; unit tests shorten it). A timeout after the request left is a failure. */
  timeoutMs?: number;
}

/**
 * Guard request GD-02 (auth GR-2 + inventory GR-I5): the access token of an identity — the same Keycloak password grant
 * `getAuthenticatedApiContext` makes for the admin user, returned as an opaque AccessToken (API-AUTH-02 / 03 decode and
 * alter it through `bearer()` + jwtTools; the DED rows send it as `Bearer` with `identityOverride`). One grant per
 * identity per validity window (reused until 60 s before `exp`); a FAILED grant is remembered for the process and
 * every later call throws TokenGrantFailed WITHOUT a request (limit 2: a wrong or rotated password would otherwise be
 * retried once per test and lock a shared account). Never logs the token or the secret (limit 4); never makes a
 * wrong-password attempt on purpose (the credentials are the identity's own).
 */
export async function fetchAccessToken(request: APIRequestContext, env: TestEnv, creds: Credentials, opts: TokenGrantOptions = {}): Promise<AccessToken> {
  const key = `${env.baseUrl}|${creds.username}`;
  const penv = opts.env ?? process.env;
  const failed = rememberedTokenFailure(key, penv);
  if (failed !== undefined) throw new TokenGrantFailed(creds.username, failed, true);
  const now = opts.now ?? Date.now;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - now() > TOKEN_REUSE_MARGIN_MS) return cached;
  if (!env.clientSecret) throw new Error('SMOKE_CLIENT_SECRET is missing, but it is required for API authentication via Keycloak.');
  const authBase = env.authBaseUrl ? env.authBaseUrl.replace(/\/$/, '') : `${env.baseUrl.replace(/\/$/, '')}/kc`;
  // F2: the attempt is on record before the request leaves (an unfinished attempt counts as failed for the run).
  rememberTokenFailure(key, 'grant attempt not finished (worker died or the request timed out after it left)', penv);
  let response: Awaited<ReturnType<APIRequestContext['post']>>;
  try {
    response = await request.post(`${authBase}/realms/${env.authRealm}/protocol/openid-connect/token`, {
      form: { grant_type: 'password', client_id: env.authClientId, client_secret: env.clientSecret, username: creds.username, password: creds.password },
      timeout: opts.timeoutMs ?? 30_000,
    });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    if (NOT_REACHED.test(message)) {
      // The identity provider was not reached: no grant was made, nothing to remember (not a lockout risk).
      forgetTokenFailure(key, penv);
      throw e;
    }
    // The detail keeps the error class only (never the URL of the identity provider or a call log).
    const detail = `request error after it left (${message.split(/Call log|https?:\/\//)[0].replace(/\s+/g, ' ').trim().slice(0, 80)})`;
    rememberTokenFailure(key, detail, penv);
    logger.error(`Failed to get an access token for an identity (${detail}); not retried in this run`);
    throw new TokenGrantFailed(creds.username, detail, false);
  }
  if (!response.ok()) {
    const detail = `status ${response.status()}`;
    rememberTokenFailure(key, detail, penv);
    logger.error(`Failed to get an access token for an identity (${detail}); not retried in this run`);
    throw new TokenGrantFailed(creds.username, detail, false);
  }
  const accessToken = ((await response.json()) as { access_token?: unknown }).access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    rememberTokenFailure(key, 'no access_token in the answer', penv);
    throw new TokenGrantFailed(creds.username, 'no access_token in the answer', false);
  }
  forgetTokenFailure(key, penv);
  const token = opaqueToken(accessToken);
  tokenCache.set(key, token);
  logger.info('Successfully obtained an access token for an identity.');
  return token;
}

/**
 * The token of an identity for a fixture: the token, or the skip reason when its grant failed once in this process
 * (the fixture skips the test with it instead of failing; coordinator addition F4).
 */
export async function tokenOrSkip(request: APIRequestContext, env: TestEnv, creds: Credentials, reason: string, opts: TokenGrantOptions = {}): Promise<{ token?: AccessToken; skip?: string }> {
  try {
    return { token: await fetchAccessToken(request, env, creds, opts) };
  } catch (e) {
    if (e instanceof TokenGrantFailed) return { skip: reason };
    throw e;
  }
}

// ------------------------------------------------------------------ the anonymous context (GD-01: auth GR-1)

/** An RFC 5737 documentation-range address: never loopback, never a real caller. */
export const DOCUMENTATION_ADDRESS = '192.0.2.1';

/**
 * GD-01 limit 2: the `X-Forwarded-For` an anonymous request carries, or undefined. A request with no credentials from a
 * LOOPBACK address authenticates as the `localhost` system user (core PlatformAuthenticationFilter.java:57, :142-152;
 * the address is read from `X-Forwarded-For` first, AuthHelper.java:304-326). So whenever BASE_URL's host is a
 * loopback / private LITERAL (also a shared tier reached through a port-forward) or the tier is local, the context
 * presents the documentation address; never to a public host. Context-level (`extraHTTPHeaders`): the guard's own
 * header rule still refuses a per-request `x-forwarded-for`.
 */
export function anonymousForwardedFor(baseUrl: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let host = '';
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
  return isLocalTier(env) || isLoopbackHost(host) || isPrivateAddress(host) ? DOCUMENTATION_ADDRESS : undefined;
}

/** The headers of the anonymous context (GD-01): JSON accept, no credentials, the forwarded-for rule above. */
export function anonymousHeaders(baseUrl: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const xff = anonymousForwardedFor(baseUrl, env);
  return { Accept: 'application/json', ...(xff ? { 'X-Forwarded-For': xff } : {}) };
}

/**
 * Fixtures:
 * - `env`: the validated test environment (strict, see utils/env.ts).
 * - `api`: the authenticated API context of the REG-* / API-* specs, wrapped in the own-object guard
 *   (utils/regression/guardedApi.ts): GETs pass, a mutation reaches the server only when every object it names was
 *   created by this run. Deny by default (review Q2): tests/unit/specGuards.spec.ts refuses a raw context
 *   (`getAuthenticatedApiContext`, the `request` fixture, `page.request`, `fetch`) for anything but a GET in
 *   tests/regression and tests/api. Disposed after the test.
 * - `anonymousApi` (GD-01, auth GR-1): the same guard around a context WITHOUT credentials (no token, no certificate
 *   header, no cookie), for the 401 negatives that send a mutating method (`POST /v1/roles` with no credentials). On a
 *   loopback / private BASE_URL or a local tier it carries `X-Forwarded-For: 192.0.2.1` so the caller is not loopback
 *   (`anonymousForwardedFor`). Every guard rule (ownership, platform deny-list, allow-lists) still judges what it
 *   sends. On AUTH_MODE=header stacks the dev proxy injects the admin certificate, so every spec that takes it must
 *   `test.skip(env.authMode === 'header', …)` (GD-01 limit 1).
 * - `adminToken` / `restrictedToken` (GD-02): the opaque AccessToken of the admin / the dedicated second identity
 *   (REG_RESTRICTED_USERNAME / _PASSWORD); `undefined` in header mode, `restrictedToken` also without the DED account.
 *   A grant that failed once in this RUN (remembered in the process and in `<run id>.token-failures.json` under
 *   REG_STATE_DIR, so a restarted worker sees it too — review F2) makes every later test that takes the fixture SKIP
 *   with the named reason (RESTRICTED_TOKEN_UNAVAILABLE / ADMIN_TOKEN_UNAVAILABLE): one attempt per run, never a lockout.
 *   A provider that cannot be reached (ECONNREFUSED) is an error, not a skip, and is not remembered.
 * - `guardOptions`: options of that guard; `test.use({ guardOptions: { localStack: true } })` in an `@local` pack lifts
 *   the ownership rule on a proven local stack only (TIER_KIND=local), nowhere else.
 */
export const test = base.extend<{
  env: TestEnv; api: GuardedApi; guardOptions: GuardOptions; anonymousApi: GuardedApi; adminToken: AccessToken | undefined; restrictedToken: AccessToken | undefined;
}>({
  env: async ({ }, use) => {
    const env = loadEnv();
    await use(env);
  },
  guardOptions: [{}, { option: true }],
  api: async ({ request, env, guardOptions }, use) => {
    const api = guardApi(await getAuthenticatedApiContext(request, env), guardOptions);
    try {
      await use(api);
    } finally {
      await api.dispose();
    }
  },
  anonymousApi: async ({ env, guardOptions }, use) => {
    const context = await playwrightRequest.newContext({
      baseURL: env.baseUrl,
      extraHTTPHeaders: anonymousHeaders(env.baseUrl),
      ignoreHTTPSErrors: true,
    });
    const api = guardApi(context, guardOptions);
    try {
      await use(api);
    } finally {
      await api.dispose();
    }
  },
  adminToken: async ({ request, env }, use, testInfo) => {
    if (env.authMode === 'header') return use(undefined);
    const { token, skip } = await tokenOrSkip(request, env, { username: env.username, password: env.password }, ADMIN_TOKEN_UNAVAILABLE);
    if (skip) testInfo.skip(true, skip);
    await use(token);
  },
  restrictedToken: async ({ request, env }, use, testInfo) => {
    const ded = restrictedIdentity();
    if (env.authMode === 'header' || !ded) return use(undefined);
    const { token, skip } = await tokenOrSkip(request, env, ded, RESTRICTED_TOKEN_UNAVAILABLE);
    if (skip) testInfo.skip(true, skip);
    await use(token);
  },
});

export async function loginAsSmokeUser(page: Page, env: TestEnv): Promise<void> {
  const loginPage = new LoginPage(page, env);
  logger.info(`Logging in to UI as ${env.username}`);
  await loginPage.goto();
  await loginPage.login();
}
