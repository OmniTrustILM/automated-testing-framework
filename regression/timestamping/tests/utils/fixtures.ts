import { test as base, expect, request as playwrightRequest, APIRequestContext } from '@playwright/test';
import { AdminApi } from './adminApi';
import { adminCertificateHeader, ilmHost, Provisioning, provisioning } from './env';

interface WorkerFixtures {
  admin: AdminApi;
  /** Unauthenticated context used for the TSP protocol endpoints (they carry Basic auth per request). */
  tsp: APIRequestContext;
  env: Provisioning;
}

// The suite adds no test-scoped fixtures; everything is worker-scoped and shared.
type TestFixtures = Record<never, never>;

type ContextOptions = NonNullable<Parameters<typeof playwrightRequest.newContext>[0]>;

/**
 * An ingress that terminates TLS sets the ssl-client-cert header itself, so against one the
 * administrator presents ADMIN_CLIENT_P12 over mTLS instead.
 */
function adminAuthentication(): Pick<ContextOptions, 'clientCertificates' | 'extraHTTPHeaders'> {
  const pfxPath = process.env.ADMIN_CLIENT_P12;
  if (pfxPath) {
    return {
      clientCertificates: [
        { origin: new URL(ilmHost).origin, pfxPath, passphrase: process.env.ADMIN_CLIENT_P12_PASSWORD },
      ],
    };
  }
  return { extraHTTPHeaders: { 'ssl-client-cert': adminCertificateHeader() } };
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  admin: [
    async ({}, use) => {
      const context = await playwrightRequest.newContext({ baseURL: ilmHost, ...adminAuthentication() });
      await use(new AdminApi(context));
      await context.dispose();
    },
    { scope: 'worker' },
  ],
  tsp: [
    async ({}, use) => {
      const context = await playwrightRequest.newContext({ baseURL: ilmHost });
      await use(context);
      await context.dispose();
    },
    { scope: 'worker' },
  ],
  env: [
    async ({}, use) => {
      await use(provisioning());
    },
    { scope: 'worker' },
  ],
});

export { expect };
