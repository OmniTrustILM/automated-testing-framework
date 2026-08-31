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

export const test = base.extend<TestFixtures, WorkerFixtures>({
  admin: [
    async ({}, use) => {
      const context = await playwrightRequest.newContext({
        baseURL: ilmHost,
        extraHTTPHeaders: { 'ssl-client-cert': adminCertificateHeader() },
      });
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
