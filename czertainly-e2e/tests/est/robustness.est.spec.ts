/**
 * EST-080..084 — `/simpleenroll` under bad input and under concurrent identical requests.
 *
 * WHAT:
 * - a body that is not base64 PKCS#10 is refused with 400, one larger than the platform's limit
 *   with 413, and a body sent with a content type other than `application/pkcs10` with 415, each
 *   with its fixed text;
 * - several identical requests sent at once create one certificate: on a synchronous CA every one
 *   answers that certificate, and on an RA Profile with an approval profile every one answers 202
 *   and exactly one approval exists.
 *
 * WHY: an EST server faces devices that retry and misbehave; bad input must be refused before it
 * costs anything, and a client that retries in parallel must not get a second certificate.
 *
 * HOW: one raBasic EST Profile per RA Profile, each with its own Basic secret. Requests answered
 * 202 are found and removed by their run-unique common name; everything goes through the
 * cleanup ledger.
 */

import { APIRequestContext, expect, test } from '@playwright/test';
import { EstEnv } from '../../utils/estEnv';
import { estRequest, EstResponse } from '../../utils/estHttp';
import { getCertificateApprovals } from '../../utils/estFixtures';
import {
  certificateHasKey,
  enrolledCertificate,
  EST_REFUSAL,
  findCertificatesByCommonName,
  simpleEnroll,
} from '../../utils/estEnroll';
import { PolicyClient } from '../../utils/estPolicyClients';
import { EstSuite } from '../../utils/estSuite';
import { createCsr } from '../../utils/estPki';

/** Above the platform's request limit. */
const OVERSIZED_BYTES = 140_000;
const CONCURRENT_REQUESTS = 5;

function expectRefused(resp: EstResponse, status: number, text: string): void {
  expect(resp.status).toBe(status);
  expect(resp.body.toString('utf8')).toBe(text);
}

test.describe('@est robustness', () => {
  const suite = new EstSuite();
  let env: EstEnv;
  let api: APIRequestContext;

  test.beforeAll(async () => ({ env, api } = await suite.open()));
  test.afterAll(() => suite.close());

  const client = (suffix: string, raProfileUuid: string) => suite.raBasicClient(suffix, raProfileUuid);

  /** Posts a raw body to `/simpleenroll` of the profile with valid Basic credentials. */
  async function post(profile: PolicyClient, body: Buffer | string, contentType: string): Promise<EstResponse> {
    const { credentials } = await profile.nextEnrollment();
    return estRequest({ baseUrl: env.baseUrl, label: profile.profile.name, op: 'simpleenroll', contentType, body, ...credentials });
  }

  /** A CSR whose common name is unique to the run; whatever it creates is removed by that name. */
  function csrNamed(prefix: string): { cn: string; csr: ReturnType<typeof createCsr> } {
    const cn = suite.uniqueCommonName(prefix);
    return { cn, csr: createCsr({ subject: cn }) };
  }

  test('EST-080 a body that is not base64 PKCS#10 is refused with 400', async () => {
    const profile = await client('robust', env.raProfileUuid);
    expectRefused(await post(profile, 'not base64 at all !!!', 'application/pkcs10'), 400, EST_REFUSAL.badRequest);
  });

  test('EST-081 a body above the request limit is refused with 413', async () => {
    const profile = await client('robust', env.raProfileUuid);
    const oversized = Buffer.alloc(OVERSIZED_BYTES, 'A');
    expectRefused(await post(profile, oversized, 'application/pkcs10'), 413, EST_REFUSAL.payloadTooLarge);
  });

  test('EST-082 a CSR sent as another content type is refused with 415', async () => {
    const profile = await client('robust', env.raProfileUuid);
    const { csr } = csrNamed('robust-type');
    expectRefused(await post(profile, csr.base64, 'application/json'), 415, EST_REFUSAL.unsupportedMediaType);
  });

  test(`EST-083 ${CONCURRENT_REQUESTS} identical requests at once on a synchronous CA create one certificate`, async () => {
    const profile = await client('concurrent', env.raProfileUuid);
    const { credentials } = await profile.nextEnrollment();
    const { cn, csr } = csrNamed('concurrent-sync');
    const request = { baseUrl: env.baseUrl, label: profile.profile.name, csr, ...credentials };

    const answers = await Promise.all(Array.from({ length: CONCURRENT_REQUESTS }, () => simpleEnroll(request)));

    const certificates = answers.map((resp) => enrolledCertificate(resp));
    expect(certificateHasKey(certificates[0], csr.key)).toBe(true);
    expect(new Set(certificates.map((der) => der.toString('base64'))).size).toBe(1);
    expect(await findCertificatesByCommonName(api, cn)).toHaveLength(1);
  });

  test(`EST-084 ${CONCURRENT_REQUESTS} identical requests at once on an approval route create one request and one approval`, async () => {
    const profile = await client('concurrent-approval', env.approvalRaProfileUuid);
    const { credentials } = await profile.nextEnrollment();
    const { cn, csr } = csrNamed('concurrent-approval');
    const request = { baseUrl: env.baseUrl, label: profile.profile.name, csr, ...credentials };

    const answers = await Promise.all(Array.from({ length: CONCURRENT_REQUESTS }, () => simpleEnroll(request)));

    expect(answers.map((resp) => resp.status)).toEqual(Array(CONCURRENT_REQUESTS).fill(202));
    const found = await findCertificatesByCommonName(api, cn);
    expect(found).toHaveLength(1);
    expect(await getCertificateApprovals(api, found[0])).toHaveLength(1);
  });
});
