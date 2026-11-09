/**
 * fixtures — the fixtures of the key onboarding specs: `admin` (the framework's strict guarded `api`), `localAdmin` (`localApi`,
 * for the `@local` rows of 25-merge only), `adminWorker` (the worker-scoped guard, for hooks) and `provisioned`.
 */
import { test as base, expect, withWorkerApi } from '../../fixtures/regressionFixtures';
import { loadEnv } from '../env';
import { AdminApi, TokenKey } from './adminApi';
import type { MetadataAttribute } from './attributes';
import { Provisioning, readSummary } from './provisioning';

export const test = base.extend<{ admin: AdminApi; localAdmin: AdminApi; provisioned: Provisioning }, { adminWorker: AdminApi }>({
    adminWorker: [
        async ({ playwright }, use) => {
            const grantContext = await playwright.request.newContext({ ignoreHTTPSErrors: true });
            try {
                await withWorkerApi(grantContext, loadEnv(), (api) => use(new AdminApi(api)));
            } finally {
                await grantContext.dispose();
            }
        },
        { scope: 'worker' },
    ],
    admin: async ({ api }, use) => {
        await use(new AdminApi(api));
    },
    // `localApi` refuses unless the test is `@local` on a proven local stack.
    localAdmin: async ({ localApi }, use) => {
        await use(new AdminApi(localApi));
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

export function keyPairMetaOf(keys: TokenKey[], label: string): MetadataAttribute[] {
    const { keyPairMeta } = labelled(keys, label);
    if (!keyPairMeta) {
        throw new Error(`The token lists the key pair labelled ${label} without metadata`);
    }
    return keyPairMeta;
}

export function identityOf(key: TokenKey): string | undefined {
    return key.keyPairMeta && JSON.stringify(key.keyPairMeta);
}

export { onboardedKey } from './provisioning';
