import { test as base, Page, expect } from '@playwright/test';
import { loadEnv, TestEnv } from '../utils/env';
import { LoginPage } from '../pages/LoginPage';
import { Logger } from '../utils/Logger';
import { guardApi } from '../utils/regression/guard/createGuard';
import { GuardedApi } from '../utils/regression/guard/types';
import { restrictedIdentity } from '../utils/regression/rbac/identities';
import type { RunRaProfile } from '../utils/regression/ownRaProfiles';
import type { TestInfo } from '@playwright/test';
import { ADMIN_TOKEN_UNAVAILABLE, RESTRICTED_TOKEN_UNAVAILABLE, AccessToken, minLifetimeForTest, tokenOrSkip } from '../utils/auth/accessToken';
import { getAuthenticatedApiContext, newAnonymousContext } from '../utils/auth/apiContext';

const logger = new Logger('TestFixtures');

export { expect, getAuthenticatedApiContext };

/**
 * testFixtures — `env`, the guarded `api`, `anonymousApi`, `adminToken` / `restrictedToken` and `ownRaProfile`.
 * Deny by default: a raw context is refused for anything but a GET (tests/unit/specGuards.spec.ts). The spec-facing
 * fixtures are in fixtures/regressionFixtures.ts.
 * On AUTH_MODE=header the dev proxy injects the admin certificate, so a spec taking `anonymousApi` must skip when `env.authMode === 'header'`.
 */
export const test = base.extend<{
  env: TestEnv; api: GuardedApi; anonymousApi: GuardedApi; adminToken: AccessToken | undefined; restrictedToken: AccessToken | undefined;
  ownRaProfile: RunRaProfile;
}>({
  env: async ({ }, use) => {
    const env = loadEnv();
    await use(env);
  },
  api: async ({ request, env }, use, testInfo) => {
    const api = guardApi(await getAuthenticatedApiContext(request, env, { minLifetimeMs: minLifetimeForTest(testInfo.timeout) }));
    try {
      await use(api);
    } finally {
      await api.dispose();
    }
  },
  anonymousApi: async ({ env }, use) => {
    const context = await newAnonymousContext(env);
    const api = guardApi(context);
    try {
      await use(api);
    } finally {
      await api.dispose();
    }
  },
  adminToken: async ({ request, env }, use, testInfo) => {
    if (env.authMode === 'header') return use(undefined);
    const { token, skip } = await tokenOrSkip(request, env, { username: env.username, password: env.password }, ADMIN_TOKEN_UNAVAILABLE);
    if (skip) testInfo.skip(true, skip);
    await use(token);
  },
  restrictedToken: async ({ request, env }, use, testInfo) => {
    const ded = restrictedIdentity();
    if (env.authMode === 'header' || !ded) return use(undefined);
    // The RBAC rows hold this token while their first row issues fixtures: never take a cached one that is about to expire.
    const { token, skip } = await tokenOrSkip(request, env, ded, RESTRICTED_TOKEN_UNAVAILABLE, { minLifetimeMs: minLifetimeForTest(testInfo.timeout) });
    if (skip) testInfo.skip(true, skip);
    await use(token);
  },
  ownRaProfile: async ({ api }, use, testInfo) => {
    // `require`, not `import()`: Node's own loader cannot read a TypeScript file.
    const { ensureRunRaProfileOrSkip } = require('../utils/regression/ownRaProfiles') as typeof import('../utils/regression/ownRaProfiles');
    await use(await ensureRunRaProfileOrSkip(api, ledgerSpecOf(testInfo), (reason) => testInfo.skip(true, reason)));
  },
});

export function ledgerSpecOf(testInfo: Pick<TestInfo, 'annotations' | 'file'>): string {
  return testInfo.annotations.find((a) => a.type === 'ledger-id')?.description ?? testInfo.file.split(/[\\/]/).pop()!.replace(/(\.api)?\.spec\.ts$/, '');
}

export async function loginAsSmokeUser(page: Page, env: TestEnv): Promise<void> {
  const loginPage = new LoginPage(page, env);
  logger.info(`Logging in to UI as ${env.username}`);
  await loginPage.goto();
  await loginPage.login();
}
