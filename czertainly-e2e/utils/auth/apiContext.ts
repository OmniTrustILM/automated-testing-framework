import { APIRequestContext, request as playwrightRequest } from '@playwright/test';
import type { TestEnv } from '../env';
import { Logger } from '../Logger';
import { fetchAccessToken } from './accessToken';
import { isLocalTier } from '../regression/tier/kind';
import { isLoopbackHost, isPrivateAddress } from '../regression/tier/dns';

/** API contexts of the suites: the admin context (Keycloak password grant or header mode) and the anonymous context. */
const logger = new Logger('ApiContext');

/**
 * Direct API authentication via Keycloak (Resource Owner Password Credentials flow), through the cached token of
 * `fetchAccessToken`. Returns an APIRequestContext authorized with the Bearer token. `minLifetimeMs` (the `api` fixture passes the
 * test's timeout) keeps a cached token from being reused when it would expire during the test; smoke and global setup omit it.
 */
export async function getAuthenticatedApiContext(request: APIRequestContext, env: TestEnv, options: { minLifetimeMs?: number } = {}): Promise<APIRequestContext> {
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

  if (!env.clientSecret) {
    logger.error('SMOKE_CLIENT_SECRET is missing, but it is required for API authentication via Keycloak.');
    throw new Error('SMOKE_CLIENT_SECRET is missing, but it is required for API authentication via Keycloak.');
  }

  // The token comes from the shared cache: one password grant per identity per validity window, and a refused grant is
  // remembered, so a wrong or rotated password is tried once, not once per test (the account could be locked).
  const token = await fetchAccessToken(request, env, { username: env.username, password: env.password }, { minLifetimeMs: options.minLifetimeMs });

  return await playwrightRequest.newContext({
    baseURL: env.baseUrl,
    extraHTTPHeaders: {
      'Authorization': `Bearer ${token.bearer()}`,
      'Accept': 'application/json',
    },
    ignoreHTTPSErrors: true
  });
}

// ------------------------------------------------------------------ the anonymous context

/** An RFC 5737 documentation-range address: never loopback, never a real caller. */
export const DOCUMENTATION_ADDRESS = '192.0.2.1';

/**
 * The `X-Forwarded-For` an anonymous request carries, or undefined. A request with no credentials from a
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

/** The headers of the anonymous context: JSON accept, no credentials, the forwarded-for rule above. */
export function anonymousHeaders(baseUrl: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const xff = anonymousForwardedFor(baseUrl, env);
  return { Accept: 'application/json', ...(xff ? { 'X-Forwarded-For': xff } : {}) };
}

/**
 * A context without credentials (no token, no certificate header, no cookie), with the headers of `anonymousHeaders`.
 * For the fixtures only (the `anonymousApi` fixture): the spec lint reports any other reference as a raw context.
 */
export async function newAnonymousContext(env: TestEnv): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: env.baseUrl,
    extraHTTPHeaders: anonymousHeaders(env.baseUrl),
    ignoreHTTPSErrors: true,
  });
}
