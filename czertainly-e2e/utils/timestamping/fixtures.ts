/**
 * fixtures — the fixtures of the timestamping specs.
 *
 * Extends the framework's `test` (env, api) with `admin` (AdminApi over the guarded `api`), `tsp` (a plain context for
 * protocol traffic, no admin identity; aimed at TSA_TSP_BASE_URL or BASE_URL) and `ts` (the run's ready provisioning;
 * it skips the test with the setup's reason when the tier is unavailable). `env` stays the framework's TestEnv, so the
 * source's `env.<provisioned object>` reads `ts.<object>` here.
 */
import { APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { test as base, expect } from '../../fixtures/regressionFixtures';
import { loadEnv } from '../env';
import { AdminApi } from './adminApi';
import { timestampingConfig } from './config';
import { Provisioning, readSummary } from './provisioning';

export const test = base.extend<{ admin: AdminApi; ts: Provisioning }, { tsp: APIRequestContext }>({
    // `api` is the framework's own guarded context (strict, deny by default) on a shared tier and on a local stack alike: a row for
    // both tiers never takes the local-stack guard (the local proof serves the @local rows and the setup's one trust request only).
    admin: async ({ api }, use) => {
        await use(new AdminApi(api));
    },
    ts: async ({}, use, testInfo) => {
        const summary = readSummary();
        if (summary.status !== 'ready') {
            testInfo.skip(true, summary.reason);
            return;
        }
        await use(summary.provisioning);
    },
    tsp: [
        async ({}, use) => {
            const context = await playwrightRequest.newContext({ baseURL: timestampingConfig().tspBaseUrl ?? loadEnv().baseUrl, ignoreHTTPSErrors: true });
            await use(context);
            await context.dispose();
        },
        { scope: 'worker' },
    ],
});

export { expect };
