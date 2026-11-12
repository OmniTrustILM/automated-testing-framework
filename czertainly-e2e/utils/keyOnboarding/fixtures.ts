/**
 * fixtures — the fixtures of the key onboarding specs.
 *
 * WHAT: extends the framework's `test` (env, localApi) with `admin` (AdminApi over the guarded `api`, here the local-stack `localApi`),
 * `adminWorker` (the same over a worker-scoped local-stack guard, for hooks) and `provisioned` (the run's ready provisioning), and keeps
 * the two lookups the specs use on a token listing.
 * WHY: the specs were written with `admin` / `provisioned`; the names stay, the plumbing is the regression framework's.
 * `adminWorker` is not the framework's `workerApi`: that one is the plain guard, and this block's calls (onboarding, removal from the
 * inventory) pass only under the guard's `localStack` option, which a worker fixture may take only on a proven local stack
 * (`withWorkerApi(..., { localStack: true })` checks the tier and the proof before it builds anything).
 * HOW: `provisioned` skips the test with the setup's reason when the block is unavailable; `api` is the framework's `localApi` (the block
 * runs on a proven local stack only); `adminWorker` builds its context once per worker and renews the token when it runs low.
 */
import { test as base, expect, withWorkerApi } from '../../fixtures/regressionFixtures';
import { loadEnv } from '../env';
import { AdminApi, TokenKey } from './adminApi';
import { Provisioning, readSummary } from './provisioning';

export const test = base.extend<{ admin: AdminApi; provisioned: Provisioning }, { adminWorker: AdminApi }>({
    // The block runs on a proven local stack: its `api` is the framework's local-stack guard (`localApi`), which lifts the
    // ownership rule there and refuses any run that is not a @local test on a stack with the local proof.
    api: async ({ localApi }, use) => {
        await use(localApi);
    },
    // For beforeAll / afterAll hooks, which can only use worker fixtures: the same admin API, one local-stack guard per worker.
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

/** Finds a listed pair by label, which every planted pair carries. */
export function labelled(keys: TokenKey[], label: string): TokenKey {
    const found = keys.find((key) => key.label === label);
    if (!found) {
        throw new Error(`The token lists no key pair labelled ${label}`);
    }
    return found;
}

/** The handle of a listed pair by label, for a pair the listing can address. */
export function handleOf(keys: TokenKey[], label: string): string {
    const { keyHandle } = labelled(keys, label);
    if (!keyHandle) {
        throw new Error(`The token lists the key pair labelled ${label} without a handle`);
    }
    return keyHandle;
}

/** The key an onboarding result names, for the ledger (defined in provisioning.ts, a module without fixtures). */
export { onboardedKey } from './provisioning';
