/**
 * estAdminApi — authenticated access to the platform's REST API for the EST suite.
 *
 * WHAT: an API request context that authenticates with the admin client certificate, the shared
 * `ensureOk` response check, and two lookups on an RA Profile.
 * WHY: the EST suite provisions and inspects the platform through the same edge it enrolls
 * against, where admin access is by client certificate rather than a login.
 * HOW: `newEstAdminContext` builds a Playwright request context with `clientCertificates` bound
 * to the edge's origin. The lookups return the CA chain fingerprints (lowercase SHA-256 of the
 * DER) and the name of an RA Profile, for comparison with what EST answers.
 */

import { APIRequestContext, request } from '@playwright/test';
import { EstEnv } from './estEnv';

export async function newEstAdminContext(env: EstEnv): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: env.baseUrl,
    ignoreHTTPSErrors: true,
    clientCertificates: [{ origin: new URL(env.baseUrl).origin, certPath: env.adminCertPath, keyPath: env.adminKeyPath }],
  });
}

/** Throws `<what> failed: <status> - <body>` unless the response is ok or its status is allowed. */
export async function ensureOk(
  resp: { ok(): boolean; status(): number; text(): Promise<string> },
  what: string,
  allow: number[] = [],
): Promise<void> {
  if (resp.ok() || allow.includes(resp.status())) return;
  throw new Error(`${what} failed: ${resp.status()} - ${await resp.text()}`);
}

export async function getRaProfileCaFingerprints(
  api: APIRequestContext,
  authorityUuid: string,
  raProfileUuid: string,
): Promise<string[]> {
  const resp = await api.get(`/api/v1/authorities/${authorityUuid}/raProfiles/${raProfileUuid}/caCertificates`);
  await ensureOk(resp, `Get CA certificates of RA Profile ${raProfileUuid}`);
  const certs = (await resp.json()) as Array<{ fingerprint: string }>;
  return certs.map((c) => c.fingerprint.toLowerCase());
}

export async function getRaProfileName(api: APIRequestContext, raProfileUuid: string): Promise<string> {
  const resp = await api.get(`/api/v1/raProfiles/${raProfileUuid}`);
  await ensureOk(resp, `Get RA Profile ${raProfileUuid}`);
  return ((await resp.json()) as { name: string }).name;
}
