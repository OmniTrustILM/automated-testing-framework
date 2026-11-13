/**
 * EST-001..004 — the discovery endpoints of an EST Profile, on the default route and on the label route.
 *
 * WHAT: one EST Profile (`certificateRegistration`, system default, enabled) is created on the
 * pre-provisioned RA Profile. `/cacerts` must answer, without credentials, a certs-only PKCS#7
 * whose certificates are exactly the RA Profile's CA chain; `/csrattrs` must answer without
 * credentials either a well-formed CsrAttrs or 204. Both are checked on `/.well-known/est/<op>`
 * and on `/.well-known/est/<profile name>/<op>`. The profile's reported `estUrl` must be a
 * `/.well-known/est/<name>` URL and not an `/api/` one.
 *
 * WHY: a client bootstraps trust from `/cacerts` before it can authenticate to anything, so a
 * wrong chain or a protected endpoint stops every enrollment; and the two routes are separate
 * paths into the same profile.
 *
 * HOW: the expected chain comes from the platform's REST API and is compared as a set of SHA-256
 * fingerprints.
 */

import { APIRequestContext, expect, test } from '@playwright/test';
import { loadEstEnv, EstEnv } from '../../utils/estEnv';
import { EstResponse, decodeBase64Body, estRequest } from '../../utils/estHttp';
import { newEstAdminContext, getRaProfileCaFingerprints } from '../../utils/estAdminApi';
import {
  cleanupEstProfile,
  createEstProfile,
  estProfileName,
  EstProfile,
  findSystemDefaultEstProfile,
  restoreSystemDefaultEstProfile,
} from '../../utils/estProfileUtils';
import { isDerCsrAttrs, parseCertsOnlyDer, sha256Fingerprint } from '../../utils/estPki';
import { Logger } from '../../utils/Logger';

const logger = new Logger('EstDiscovery');

test.describe('@est discovery', () => {
  let env: EstEnv;
  let api: APIRequestContext;
  let profile: EstProfile;
  let previousDefaultUuid: string | undefined;
  let expectedChain: string[];

  test.beforeAll(async () => {
    env = loadEstEnv();
    api = await newEstAdminContext(env);
    previousDefaultUuid = await findSystemDefaultEstProfile(api);
    // A failed beforeAll still runs afterAll, which cleans up and disposes once.
    profile = await createEstProfile(api, {
      name: estProfileName('discovery'),
      raProfileUuid: env.raProfileUuid,
      authenticationPolicy: 'certificateRegistration',
      systemDefault: true,
    });
    expectedChain = await getRaProfileCaFingerprints(api, env.authorityUuid, env.raProfileUuid);
    logger.info(`Expecting a chain of ${expectedChain.length} certificate(s)`);
  });

  test.afterAll(async () => {
    if (!api) return;
    try {
      if (profile) await cleanupEstProfile(api, profile);
      if (previousDefaultUuid) await restoreSystemDefaultEstProfile(api, previousDefaultUuid);
    } finally {
      await api.dispose();
    }
  });

  function expectChain(resp: EstResponse): void {
    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('application/pkcs7-mime');
    expect(expectedChain.length).toBeGreaterThan(0);
    const fingerprints = parseCertsOnlyDer(decodeBase64Body(resp.body)).map(sha256Fingerprint);
    expect([...fingerprints].sort()).toEqual([...expectedChain].sort());
  }

  function expectCsrAttrs(resp: EstResponse): void {
    expect([200, 204]).toContain(resp.status);
    if (resp.status === 200) {
      expect(resp.headers['content-type']).toContain('application/csrattrs');
      expect(isDerCsrAttrs(decodeBase64Body(resp.body))).toBe(true);
    } else {
      expect(resp.body.length).toBe(0);
    }
  }

  test('EST-001 /cacerts on the default route returns the authority chain', async () => {
    expectChain(await estRequest({ baseUrl: env.baseUrl, op: 'cacerts' }));
  });

  test('EST-002 /csrattrs on the default route returns CsrAttrs or 204', async () => {
    expectCsrAttrs(await estRequest({ baseUrl: env.baseUrl, op: 'csrattrs' }));
  });

  test('EST-003 /cacerts on the label route returns the authority chain', async () => {
    expect(profile.estUrl).toMatch(new RegExp(`/\\.well-known/est/${profile.name}$`));
    expect(profile.estUrl).not.toContain('/api/');
    expectChain(await estRequest({ baseUrl: env.baseUrl, label: profile.name, op: 'cacerts' }));
  });

  test('EST-004 /csrattrs on the label route returns CsrAttrs or 204', async () => {
    expectCsrAttrs(await estRequest({ baseUrl: env.baseUrl, label: profile.name, op: 'csrattrs' }));
  });
});
