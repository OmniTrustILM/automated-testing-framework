import { test as base, expect } from '@playwright/test';
import { AdminApi, TokenKey } from './adminApi';
import { provisioning, Provisioning } from './env';

interface WorkerFixtures {
  admin: AdminApi;
  provisioned: Provisioning;
}

// Every fixture is worker-scoped and shared.
type TestFixtures = Record<never, never>;

export const test = base.extend<TestFixtures, WorkerFixtures>({
  admin: [
    async ({}, use) => {
      const api = await AdminApi.open();
      await use(api);
      await api.dispose();
    },
    { scope: 'worker' },
  ],
  provisioned: [
    async ({}, use) => {
      await use(provisioning());
    },
    { scope: 'worker' },
  ],
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
  const { keyPairHandle } = labelled(keys, label);
  if (!keyPairHandle) {
    throw new Error(`The token lists the key pair labelled ${label} without a handle`);
  }
  return keyPairHandle;
}
