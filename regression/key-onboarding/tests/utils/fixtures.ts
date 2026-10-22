import { test as base, expect } from '@playwright/test';
import { AdminApi, TokenKey } from './adminApi';
import { MetadataAttribute } from './attributes';
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

/** The metadata of a listed pair by label, for a pair the listing can address. */
export function keyPairMetaOf(keys: TokenKey[], label: string): MetadataAttribute[] {
  const { keyPairMeta } = labelled(keys, label);
  if (!keyPairMeta) {
    throw new Error(`The token lists the key pair labelled ${label} without metadata`);
  }
  return keyPairMeta;
}

/** A listed pair's metadata as one string, which the next listing of the same pair repeats. */
export function identityOf(key: TokenKey): string | undefined {
  return key.keyPairMeta && JSON.stringify(key.keyPairMeta);
}
