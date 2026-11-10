import { APIRequestContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import type { TestEnv } from '../env';
import { Logger } from '../Logger';
import type { Credentials } from '../regression/rbac/identities';
import { currentRunId, regressionStateDir } from '../regression/run/runId';

/**
 * accessToken — the opaque AccessToken, the Keycloak password grant, the per-process token cache and the failure memory.
 * A repeated wrong password can lock the account, so a failed grant is not repeated.
 */
const logger = new Logger('AccessToken');

/** A token a spec may hold without printing it: `bearer()` is the only way to the raw string; `claims()` decodes without verifying. */
export interface AccessToken {
  bearer(): string;
  claims(): Record<string, unknown>;
  readonly expiresAt: number;
  toString(): string;
  toJSON(): string;
}

const REDACTED = '[token]';

/** The payload of a compact JWT, or {} when unreadable (never verified). */
function claimsOf(token: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function expiryOf(token: string): number {
  const exp = claimsOf(token).exp;
  return typeof exp === 'number' ? exp * 1000 : 0;
}

export function opaqueToken(raw: string): AccessToken {
  const token: AccessToken = {
    bearer: () => raw,
    claims: () => claimsOf(raw),
    expiresAt: expiryOf(raw),
    toString: () => REDACTED,
    toJSON: () => REDACTED,
  };
  // Not an own enumerable property, not inspectable.
  Object.defineProperty(token, Symbol.for('nodejs.util.inspect.custom'), { value: () => REDACTED, enumerable: false });
  return Object.freeze(token);
}

export class TokenGrantFailed extends Error {
  constructor(readonly identity: string, readonly detail: string, readonly cached: boolean) {
    super(`token grant for identity "${identity}" ${cached ? 'failed earlier in this process' : 'failed'} (${detail}); not retried: a repeated failed ` +
      'password grant can lock the account at the identity provider (REG_RESTRICTED_* / SMOKE_* must be fixed first)');
    this.name = 'TokenGrantFailed';
  }
}

export const RESTRICTED_TOKEN_UNAVAILABLE =
  'restricted identity unavailable: token grant failed once — check REG_RESTRICTED_*; not retried to avoid an account lockout';
export const ADMIN_TOKEN_UNAVAILABLE = 'admin token unavailable: token grant failed once — check SMOKE_USERNAME / SMOKE_PASSWORD / SMOKE_CLIENT_SECRET; not retried';

export const TOKEN_REUSE_MARGIN_MS = 60_000;

/** A test may raise its own timeout inside its body, so a cached token must outlive the longest usual test: 300 s. */
export const TOKEN_LIFETIME_FLOOR_MS = 300_000;

export const minLifetimeForTest = (testTimeoutMs: number): number => Math.max(testTimeoutMs, TOKEN_LIFETIME_FLOOR_MS);

const tokenCache = new Map<string, AccessToken>();
const tokenFailures = new Map<string, string>();

/**
 * The failure memory is also persisted in the run's state directory (`<run id>.token-failures.json`), because a worker
 * restarts after a failed test. Only a definite credential failure is remembered; a timeout, network error or 5xx is retried.
 * No file is written outside a regression or API run.
 */
export const tokenFailureFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(regressionStateDir(env), `${currentRunId(env)}.token-failures.json`);

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

const rememberedTokenFailure = (key: string, env: NodeJS.ProcessEnv): string | undefined => tokenFailures.get(key) ?? readTokenFailures(env)[key];

const CREDENTIAL_REFUSALS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

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

export function resetTokenCacheForUnitTests(env: NodeJS.ProcessEnv = process.env): void {
  tokenCache.clear();
  tokenFailures.clear();
  if (persistsFailures(env)) fs.rmSync(tokenFailureFile(env), { force: true });
}

export interface TokenGrantOptions {
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** A cached token is reused only while it has at least this much lifetime left (never less than TOKEN_REUSE_MARGIN_MS). */
  minLifetimeMs?: number;
  /** The grant request timeout (default 30 s). A timeout is not remembered. */
  timeoutMs?: number;
}

/**
 * One password grant per identity per validity window, returned as an opaque AccessToken. A grant the identity provider
 * refused is remembered and later calls throw TokenGrantFailed without a request; a timeout, network error or 5xx throws a plain Error.
 * Never logs the token or the secret; never makes a wrong-password attempt on purpose.
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
    // The log line keeps the error class only, never the identity provider's URL or a call log.
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

/** The token for a fixture, or the skip reason when its grant failed once in this process. */
export async function tokenOrSkip(request: APIRequestContext, env: TestEnv, creds: Credentials, reason: string, opts: TokenGrantOptions = {}): Promise<{ token?: AccessToken; skip?: string }> {
  try {
    return { token: await fetchAccessToken(request, env, creds, opts) };
  } catch (e) {
    if (e instanceof TokenGrantFailed) return { skip: reason };
    throw e;
  }
}
