/**
 * fixtures — the fixtures of the timestamping specs: `admin` (AdminApi over the guarded `api`), `tsp` (a plain context for protocol
 * traffic) and `ts` (the run's ready provisioning).
 */
import { APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { test as base, expect } from '../../fixtures/regressionFixtures';
import { loadEnv } from '../env';
import { AdminApi } from './adminApi';
import { timestampingConfig } from './config';
import { Provisioning, readSummary } from './provisioning';

export const test = base.extend<{ admin: AdminApi; ts: Provisioning }, { tsp: APIRequestContext }>({
    // `api` is strict and deny by default: a row for both tiers never takes the local-stack guard.
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
