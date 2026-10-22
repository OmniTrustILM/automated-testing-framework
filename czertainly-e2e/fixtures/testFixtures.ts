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

// Token and identity logic lives in utils/auth/. Only what the smoke specs and the global setup / teardown import is exported from here.
export { expect, getAuthenticatedApiContext };

/**
 * Fixtures:
 * - `env`: the validated test environment (strict, see utils/env.ts).
 * - `api`: the authenticated API context of the REG-* / API-* specs, wrapped in the own-object guard
 *   (utils/regression/guardedApi.ts): GETs pass, a mutation reaches the server only when every object it names was
 *   created by this run. Deny by default: tests/unit/specGuards.spec.ts refuses a raw context
 *   (`getAuthenticatedApiContext`, the `request` fixture, `page.request`, `fetch`) for anything but a GET in
 *   tests/regression and tests/api. Disposed after the test.
 * - `anonymousApi`: the same guard around a context WITHOUT credentials (no token, no certificate
 *   header, no cookie), for the 401 negatives that send a mutating method (`POST /v1/roles` with no credentials). On a
 *   loopback / private BASE_URL or a local tier it carries `X-Forwarded-For: 192.0.2.1` so the caller is not loopback
 *   (`anonymousForwardedFor`). Every guard rule (ownership, platform deny-list, allow-lists) still judges what it
 *   sends. On AUTH_MODE=header stacks the dev proxy injects the admin certificate, so every spec that takes it must
 *   `test.skip(env.authMode === 'header', …)`.
 * - `adminToken` / `restrictedToken`: the opaque AccessToken of the admin / the dedicated second identity
 *   (REG_RESTRICTED_USERNAME / _PASSWORD); `undefined` in header mode, `restrictedToken` also without the DED account.
 *   A grant that failed once in this RUN (remembered in the process and in `<run id>.token-failures.json` under
 *   REG_STATE_DIR, so a restarted worker sees it too) makes every later test that takes the fixture SKIP
 *   with the named reason (RESTRICTED_TOKEN_UNAVAILABLE / ADMIN_TOKEN_UNAVAILABLE): one attempt per run, never a lockout.
 *   A provider that cannot be reached (ECONNREFUSED) is an error, not a skip, and is not remembered.
 * - `ownRaProfile`: the run RA profile (`ensureRunRaProfile`, CA-agnostic). A tier without a healthy CA skips the test with
 *   the helper's named reason (the deploy gate), so a spec needs no try / skip of its own.
 *   It takes the ledger spec from the test's `testMeta({ id })` (else the file name), and loads its helpers only when a test asks
 *   for it.
 * The spec-facing fixtures built on these (`own`, `needs`, `live`, `signedIn`, `regressionEnv`, `localApi`) live in
 * fixtures/regressionFixtures.ts, so that the smoke suite loads no more than it does here.
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
    // A cached token is reused only when it outlives the test (the fixture sees the project's timeout, a test may raise its own: see the floor).
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
    const { token, skip } = await tokenOrSkip(request, env, ded, RESTRICTED_TOKEN_UNAVAILABLE);
    if (skip) testInfo.skip(true, skip);
    await use(token);
  },
  ownRaProfile: async ({ api }, use, testInfo) => {
    // Loaded only by the tests that take this fixture (the smoke suite never does). `require`, not `import()`: a dynamic import of a
    // module nothing loaded before goes through Node's own loader, which cannot read a TypeScript file.
    const { ensureRunRaProfileOrSkip } = require('../utils/regression/ownRaProfiles') as typeof import('../utils/regression/ownRaProfiles');
    await use(await ensureRunRaProfileOrSkip(api, ledgerSpecOf(testInfo), (reason) => testInfo.skip(true, reason)));
  },
});

/** The ledger `spec` of a fixture's objects: the test's `testMeta({ id })`, else the spec file's stem (`x.api.spec.ts` → `x`). */
export function ledgerSpecOf(testInfo: Pick<TestInfo, 'annotations' | 'file'>): string {
  return testInfo.annotations.find((a) => a.type === 'ledger-id')?.description ?? testInfo.file.split(/[\\/]/).pop()!.replace(/(\.api)?\.spec\.ts$/, '');
}

export async function loginAsSmokeUser(page: Page, env: TestEnv): Promise<void> {
  const loginPage = new LoginPage(page, env);
  logger.info(`Logging in to UI as ${env.username}`);
  await loginPage.goto();
  await loginPage.login();
}
