/**
 * fixtures — the fixtures of the key onboarding specs: `admin`, `adminWorker` (for hooks) and `provisioned`.
 * `adminWorker` is not the framework's `workerApi`: this block's calls pass only under the guard's `localStack` option.
 */
import { test as base, expect, withWorkerApi } from '../../fixtures/regressionFixtures';
import { loadEnv } from '../env';
import { AdminApi, TokenKey } from './adminApi';
import { Provisioning, readSummary } from './provisioning';

export const test = base.extend<{ admin: AdminApi; provisioned: Provisioning }, { adminWorker: AdminApi }>({
    // The block runs on a proven local stack: `localApi` lifts the ownership rule there.
    api: async ({ localApi }, use) => {
        await use(localApi);
    },
    adminWorker: [
        async ({ playwright }, use) => {
            const grantContext = await playwright.request.newContext({ ignoreHTTPSErrors: true });
            try {
                await withWorkerApi(grantContext, loadEnv(), (api) => use(new AdminApi(api)), { localStack: true });
            } finally {
                await grantContext.dispose();
            }
        },
        { scope: 'worker' },
    ],
    admin: async ({ api }, use) => {
        await use(new AdminApi(api));
    },
    provisioned: async ({}, use, testInfo) => {
        const summary = readSummary();
        if (summary.status !== 'ready') {
            testInfo.skip(true, summary.reason);
            return;
        }
        await use(summary.provisioning);
    },
});

export { expect };

export function labelled(keys: TokenKey[], label: string): TokenKey {
    const found = keys.find((key) => key.label === label);
    if (!found) {
        throw new Error(`The token lists no key pair labelled ${label}`);
    }
    return found;
}

export function handleOf(keys: TokenKey[], label: string): string {
    const { keyHandle } = labelled(keys, label);
    if (!keyHandle) {
        throw new Error(`The token lists the key pair labelled ${label} without a handle`);
    }
    return keyHandle;
}

export { onboardedKey } from './provisioning';
