/**
 * fixtures — the fixtures of the timestamping specs.
 *
 * WHAT: extends the framework's `test` (env, localApi) with `admin` (AdminApi over the guarded `api`, here the local-stack `localApi`), `tsp`
 * (a plain context for protocol traffic, no admin identity) and `ts` (the run's ready provisioning).
 * WHY: the specs were written with `admin` / `tsp` / `env`; the names stay, the plumbing is the regression framework's.
 * `env` stays the framework's TestEnv, so the source's `env.<provisioned object>` reads `ts.<object>` here.
 * HOW: `ts` skips the test with the setup's reason when the tier is unavailable; `tsp` is worker-scoped (hooks use it),
 * aimed at TSA_TSP_BASE_URL or BASE_URL; `api` is the framework's `localApi` (the block runs on a proven local stack).
 */
import { APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { test as base, expect } from '../../fixtures/regressionFixtures';
import { loadEnv } from '../env';
import { AdminApi } from './adminApi';
import { timestampingConfig } from './config';
import { Provisioning, readSummary } from './provisioning';

export const test = base.extend<{ admin: AdminApi; ts: Provisioning }, { tsp: APIRequestContext }>({
    // The block runs on a proven local stack: its `api` is the framework's local-stack guard (`localApi`), which lifts the
    // ownership rule there and refuses any run that is not a @local test on a stack with the local proof.
    api: async ({ localApi }, use) => {
        await use(localApi);
    },
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
