/** apiContext — API contexts of the suites: the admin context and the anonymous context. */
import { APIRequestContext, request as playwrightRequest } from '@playwright/test';
import type { TestEnv } from '../env';
import { Logger } from '../Logger';
import { fetchAccessToken } from './accessToken';
import { isLocalTier } from '../regression/tier/kind';
import { isLoopbackHost, isPrivateAddress } from '../regression/tier/dns';

const logger = new Logger('ApiContext');

/**
 * Authenticates through the cached token of `fetchAccessToken`. `minLifetimeMs`
 * keeps a cached token that would expire during the test from being reused.
 */
export async function getAuthenticatedApiContext(request: APIRequestContext, env: TestEnv, options: { minLifetimeMs?: number } = {}): Promise<APIRequestContext> {
  return (await openAuthenticatedApiContext(request, env, options)).context;
}

/** The same context with the moment its token expires (milliseconds; Infinity in header mode), for renewal. */
export async function openAuthenticatedApiContext(
  request: APIRequestContext, env: TestEnv, options: { minLifetimeMs?: number } = {},
): Promise<{ context: APIRequestContext; expiresAt: number }> {
  if (env.authMode === 'header') {
    // Local development stack: no identity provider; AUTH_CLIENT_CERT is sent the way the dev proxy does.
    const cert = process.env.AUTH_CLIENT_CERT;
    logger.info(`AUTH_MODE=header: ${cert ? 'sending ssl-client-cert' : 'relying on the dev proxy'} for API calls`);
    const context = await playwrightRequest.newContext({
      baseURL: env.baseUrl,
      extraHTTPHeaders: { Accept: 'application/json', ...(cert ? { 'ssl-client-cert': cert } : {}) },
      ignoreHTTPSErrors: true,
    });
    return { context, expiresAt: Number.POSITIVE_INFINITY };
  }

  if (!env.clientSecret) {
    logger.error('SMOKE_CLIENT_SECRET is missing, but it is required for API authentication via Keycloak.');
    throw new Error('SMOKE_CLIENT_SECRET is missing, but it is required for API authentication via Keycloak.');
  }

  // One password grant per identity per validity window; a refused grant is remembered.
  const token = await fetchAccessToken(request, env, { username: env.username, password: env.password }, { minLifetimeMs: options.minLifetimeMs });

  const context = await playwrightRequest.newContext({
    baseURL: env.baseUrl,
    extraHTTPHeaders: {
      'Authorization': `Bearer ${token.bearer()}`,
      'Accept': 'application/json',
    },
    ignoreHTTPSErrors: true
  });
  return { context, expiresAt: token.expiresAt };
}


export const DOCUMENTATION_ADDRESS = '192.0.2.1';

/**
 * The `X-Forwarded-For` an anonymous request carries, or undefined. A request with no credentials from a loopback
 * address authenticates as the `localhost` system user, so on a loopback / private BASE_URL or a local tier the context
 * presents the documentation address; never to a public host.
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

export function anonymousHeaders(baseUrl: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const xff = anonymousForwardedFor(baseUrl, env);
  return { Accept: 'application/json', ...(xff ? { 'X-Forwarded-For': xff } : {}) };
}

/** A context without credentials. For the fixtures only: the spec lint reports any other reference as a raw context. */
export async function newAnonymousContext(env: TestEnv): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: env.baseUrl,
    extraHTTPHeaders: anonymousHeaders(env.baseUrl),
    ignoreHTTPSErrors: true,
  });
}
