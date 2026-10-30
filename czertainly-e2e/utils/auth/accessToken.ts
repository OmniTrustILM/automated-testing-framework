import { APIRequestContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import type { TestEnv } from '../env';
import { Logger } from '../Logger';
import type { Credentials } from '../regression/rbac/identities';
import { currentRunId, regressionStateDir } from '../regression/run/runId';

/**
 * Access tokens of an identity: the opaque AccessToken wrapper, the Keycloak password grant, the per-process token
 * cache and the failure memory that stops a failed grant from being repeated (a repeated wrong password can lock the
 * account at the identity provider). The fixtures in fixtures/testFixtures.ts only wire this module.
 */
const logger = new Logger('AccessToken');

/**
 * An access token a spec may hold without being able to print it: `String(token)`, `JSON.stringify`
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

/** The opaque wrapper of a raw token (it never prints the raw value). */
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

/** The skip reason of a spec that takes `restrictedToken` after the grant failed once. */
export const RESTRICTED_TOKEN_UNAVAILABLE =
  'restricted identity unavailable: token grant failed once — check REG_RESTRICTED_*; not retried to avoid an account lockout';
/** The skip reason of a spec that takes `adminToken` after the admin grant failed once. */
export const ADMIN_TOKEN_UNAVAILABLE = 'admin token unavailable: token grant failed once — check SMOKE_USERNAME / SMOKE_PASSWORD / SMOKE_CLIENT_SECRET; not retried';

/** Reuse a token until this long before it expires. */
export const TOKEN_REUSE_MARGIN_MS = 60_000;

/**
 * The token lifetime a test asks for is never below this. A test may raise its own timeout inside its body (the fixture only sees the
 * project's), so a cached token must outlive the longest usual test: 300 s, the usual identity-provider lifetime. With such a token
 * every test gets a fresh grant (as before the cache), while the failure memory stays; a longer-lived token is still reused.
 */
export const TOKEN_LIFETIME_FLOOR_MS = 300_000;

/** The minimum remaining lifetime of a token reused by a test with this timeout. */
export const minLifetimeForTest = (testTimeoutMs: number): number => Math.max(testTimeoutMs, TOKEN_LIFETIME_FLOOR_MS);

/** Per process: a cached token per identity and base URL, and the identities whose grant failed. */
const tokenCache = new Map<string, AccessToken>();
const tokenFailures = new Map<string, string>();

/**
 * The failure memory must outlive the worker (Playwright restarts a worker after a failed test; the logout and
 * non-interference projects run in workers of their own), so it is also persisted in the run's state directory
 * (`regressionStateDir()`: REG_STATE_DIR, else the default one) as `<run id>.token-failures.json`, keyed by
 * `<base URL>|<username>`, and removed on success. Only a DEFINITE credential
 * failure is remembered (the identity provider answered 401, or 400 with `invalid_grant` / `invalid_client` /
 * `unauthorized_client`, or answered 200 without a token). A timeout, a network error or a 5xx proves nothing about the
 * credentials: it fails that call and is retried by the next one. The file is written in a regression or API run (both
 * configs set REG_RUN_ID before anything else, and REG_STATE_DIR may be set too); the smoke suite sets neither, so its
 * memory stays in the process and no file is written.
 */
export const tokenFailureFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(regressionStateDir(env), `${currentRunId(env)}.token-failures.json`);

/** The failure memory is written to a file only inside a regression or API run (REG_RUN_ID set by the config, or REG_STATE_DIR). */
const persistsFailures = (env: NodeJS.ProcessEnv): boolean => Boolean(env.REG_RUN_ID || env.REG_STATE_DIR);

function readTokenFailures(env: NodeJS.ProcessEnv): Record<string, string> {
  if (!persistsFailures(env)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenFailureFile(env), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeTokenFailures(env: NodeJS.ProcessEnv, map: Record<string, string>): void {
  if (!persistsFailures(env)) return;
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
  if (!persistsFailures(env)) return;
  const map = readTokenFailures(env);
  if (Object.hasOwn(map, key)) {
    delete map[key];
    if (Object.keys(map).length) writeTokenFailures(env, map);
    else fs.rmSync(tokenFailureFile(env), { force: true });
  }
}

/** The remembered failure of a key: this process first, then the run's file (another worker's memory). */
const rememberedTokenFailure = (key: string, env: NodeJS.ProcessEnv): string | undefined => tokenFailures.get(key) ?? readTokenFailures(env)[key];

/** The OAuth error codes that say the identity provider refused THESE credentials or this client. */
const CREDENTIAL_REFUSALS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

/** True when a refused grant is a definite credential failure (worth remembering), not a hiccup of the provider. */
async function isCredentialRefusal(response: Awaited<ReturnType<APIRequestContext['post']>>): Promise<boolean> {
  if (response.status() === 401) return true;
  if (response.status() !== 400) return false;
  try {
    const error = ((await response.json()) as { error?: unknown }).error;
    return typeof error === 'string' && CREDENTIAL_REFUSALS.has(error);
  } catch {
    return false;
  }
}

/** Unit tests only: forget every cached token and failure (the process's and the run's file). */
export function resetTokenCacheForUnitTests(env: NodeJS.ProcessEnv = process.env): void {
  tokenCache.clear();
  tokenFailures.clear();
  if (persistsFailures(env)) fs.rmSync(tokenFailureFile(env), { force: true });
}

export interface TokenGrantOptions {
  /** The clock (unit tests). */
  now?: () => number;
  /** The environment the run id and REG_STATE_DIR are read from (unit tests). */
  env?: NodeJS.ProcessEnv;
  /**
   * A cached token is reused only while it has at least this much lifetime left (never less than TOKEN_REUSE_MARGIN_MS): a test that
   * runs for minutes needs a token that outlives it. The `api` fixture passes the test's timeout.
   */
  minLifetimeMs?: number;
  /** The grant request timeout (default 30 s; unit tests shorten it). A timeout fails the call and is not remembered. */
  timeoutMs?: number;
}

/**
 * The access token of an identity (used by the auth and inventory specs) — the same Keycloak password grant
 * `getAuthenticatedApiContext` makes for the admin user, returned as an opaque AccessToken (API-AUTH-02 / 03 decode and
 * alter it through `bearer()` + jwtTools; the DED rows send it as `Bearer` with `identityOverride`). One grant per
 * identity per validity window (reused until 60 s before `exp`, or until `minLifetimeMs` before it when the caller needs a longer-lived token); a grant the identity provider REFUSED (401, or
 * 400 `invalid_grant`) is remembered for the process and every later call throws TokenGrantFailed WITHOUT a request
 * (a wrong or rotated password would otherwise be retried once per test and lock a shared account). A timeout, a network
 * error or a 5xx throws a plain Error and is not remembered. Never logs the token or the secret; never makes a
 * wrong-password attempt on purpose (the credentials are the identity's own).
 */
export async function fetchAccessToken(request: APIRequestContext, env: TestEnv, creds: Credentials, opts: TokenGrantOptions = {}): Promise<AccessToken> {
  const key = `${env.baseUrl}|${creds.username}`;
  const penv = opts.env ?? process.env;
  const failed = rememberedTokenFailure(key, penv);
  if (failed !== undefined) throw new TokenGrantFailed(creds.username, failed, true);
  const now = opts.now ?? Date.now;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - now() > Math.max(TOKEN_REUSE_MARGIN_MS, opts.minLifetimeMs ?? 0)) return cached;
  if (!env.clientSecret) throw new Error('SMOKE_CLIENT_SECRET is missing, but it is required for API authentication via Keycloak.');
  const authBase = env.authBaseUrl ? env.authBaseUrl.replace(/\/$/, '') : `${env.baseUrl.replace(/\/$/, '')}/kc`;
  let response: Awaited<ReturnType<APIRequestContext['post']>>;
  try {
    response = await request.post(`${authBase}/realms/${env.authRealm}/protocol/openid-connect/token`, {
      form: { grant_type: 'password', client_id: env.authClientId, client_secret: env.clientSecret, username: creds.username, password: creds.password },
      timeout: opts.timeoutMs ?? 30_000,
    });
  } catch (e) {
    // A timeout or a network error says nothing about the credentials: the call fails, nothing is remembered. The log line keeps
    // the error class only (never the URL of the identity provider or a call log).
    const message = String((e as Error)?.message ?? e).split(/Call log|https?:\/\//)[0].replace(/\s+/g, ' ').trim().slice(0, 120);
    logger.error(`The token request for an identity did not complete (${message}); not remembered as a credential failure`);
    throw e;
  }
  if (!response.ok()) {
    if (await isCredentialRefusal(response)) {
      const detail = `status ${response.status()}`;
      rememberTokenFailure(key, detail, penv);
      logger.error(`Failed to get an access token for an identity (${detail}); not retried in this run`);
      throw new TokenGrantFailed(creds.username, detail, false);
    }
    // The provider answered, but not with a verdict on the credentials (5xx, 429, a proxy error): fail this call, retry the next.
    logger.error(`The identity provider answered the token request with status ${response.status()}; not remembered as a credential failure`);
    throw new Error(`token request for identity "${creds.username}" was not answered with a token (status ${response.status()}); not a credential verdict, so not remembered`);
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
 * (the fixture skips the test with it instead of failing).
 */
export async function tokenOrSkip(request: APIRequestContext, env: TestEnv, creds: Credentials, reason: string, opts: TokenGrantOptions = {}): Promise<{ token?: AccessToken; skip?: string }> {
  try {
    return { token: await fetchAccessToken(request, env, creds, opts) };
  } catch (e) {
    if (e instanceof TokenGrantFailed) return { skip: reason };
    throw e;
  }
}
