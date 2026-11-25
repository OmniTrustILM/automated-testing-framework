/**
 * EST-050..053 — `/simpleenroll` issuing at once, pending at the CA, and pending an approval.
 *
 * WHAT:
 * - a synchronous CA answers 200 certs-only with one certificate for the CSR's key and subject;
 * - a CA that never issues on its own answers 202 with `Retry-After`, and an identical retry is
 *   202 again without a second request;
 * - an RA Profile with an approval profile answers 202; once the request is approved through the
 *   API, an identical retry returns the certificate, and exactly one certificate and one approval
 *   exist;
 * - an EST Profile with a Retry-After of 7 s answers a request pending an approval with 202 and
 *   `Retry-After: 7`.
 *
 * WHY: RFC 7030 §4.2.3 lets a server defer an enrollment, and the client's only way back is to
 * repeat the same request; the platform must recognise it rather than file a second one.
 *
 * HOW: one raBasic EST Profile per RA Profile (sync, pending, approval), each with its own Basic
 * secret. A deferred request has no certificate yet, so it is found by its run-unique common name
 * and removed by it at the end. Everything goes through the cleanup ledger.
 */

import { APIRequestContext, expect, test } from '@playwright/test';
import * as crypto from 'crypto';
import { EstEnv } from '../../utils/estEnv';
import { EstResponse } from '../../utils/estHttp';
import { approve, getCertificateApprovals } from '../../utils/estFixtures';
import {
  certificateHasKey,
  cleanupEnrolledCertificates,
  enrolledCertificate,
  findCertificatesByCommonName,
  getInventoryCertificate,
  simpleEnroll,
} from '../../utils/estEnroll';
import { createCsr, Csr } from '../../utils/estPki';
import { EstSuite } from '../../utils/estSuite';
import { PolicyProfileOptions } from '../../utils/estPolicyClients';
import { waitForCertificateState } from '../../utils/certificateUtils';

function expectDeferred(resp: EstResponse): void {
  expect(resp.status, resp.body.toString('utf8')).toBe(202);
  expect(Number(resp.headers['retry-after'])).toBeGreaterThan(0);
}

test.describe('@est enroll', () => {
  const suite = new EstSuite();
  const { undo } = suite;
  let env: EstEnv;
  let api: APIRequestContext;

  test.beforeAll(async () => ({ env, api } = await suite.open()));
  test.afterAll(() => suite.close());

  const client = (suffix: string, raProfileUuid: string, options?: PolicyProfileOptions) =>
    suite.raBasicClient(suffix, raProfileUuid, options);

  /** A CSR whose common name is unique to the run, so its pending request can be found by it. */
  function deferredCsr(prefix: string): { cn: string; csr: Csr } {
    const cn = suite.uniqueCommonName(prefix);
    return { cn, csr: createCsr({ subject: cn }) };
  }

  test('EST-050 a synchronous CA answers certs-only with one certificate for the CSR', async () => {
    const sync = await client('enroll', env.raProfileUuid);
    const { subject, credentials } = await sync.nextEnrollment();
    const csr = createCsr({ subject });

    const resp = await simpleEnroll({ baseUrl: env.baseUrl, label: sync.profile.name, csr, ...credentials });

    const der = enrolledCertificate(resp);
    undo.push(() => cleanupEnrolledCertificates(api, [der]));
    expect(certificateHasKey(der, csr.key)).toBe(true);
    expect(new crypto.X509Certificate(der).subject).toBe(`CN=${subject[0].value}`);
    expect((await getInventoryCertificate(api, der)).state).toBe('issued');
  });

  test('EST-051 a pending CA answers 202 with Retry-After, and an identical retry is 202 without a second request', async () => {
    const pending = await client('pending', env.pendingRaProfileUuid);
    const { credentials } = await pending.nextEnrollment();
    const { cn, csr } = deferredCsr('pending');
    const request = { baseUrl: env.baseUrl, label: pending.profile.name, csr, ...credentials };

    expectDeferred(await simpleEnroll(request));
    expectDeferred(await simpleEnroll(request));

    expect(await findCertificatesByCommonName(api, cn)).toHaveLength(1);
  });

  test('EST-052 an approval answers 202; once approved, an identical retry returns the one certificate', async () => {
    const approval = await client('approval', env.approvalRaProfileUuid);
    const { credentials } = await approval.nextEnrollment();
    const { cn, csr } = deferredCsr('approval');
    const request = { baseUrl: env.baseUrl, label: approval.profile.name, csr, ...credentials };

    expectDeferred(await simpleEnroll(request));
    const [certificateUuid, ...others] = await findCertificatesByCommonName(api, cn);
    expect(others).toHaveLength(0);
    const approvals = await getCertificateApprovals(api, certificateUuid);
    expect(approvals).toHaveLength(1);
    await approve(api, approvals[0].approvalUuid);
    await waitForCertificateState(api, certificateUuid, 'issued');

    const der = enrolledCertificate(await simpleEnroll(request));

    expect(certificateHasKey(der, csr.key)).toBe(true);
    expect((await getInventoryCertificate(api, der)).uuid).toBe(certificateUuid);
    expect(await findCertificatesByCommonName(api, cn)).toEqual([certificateUuid]);
    expect(await getCertificateApprovals(api, certificateUuid)).toHaveLength(1);
  });

  test('EST-053 the EST Profile sets the Retry-After of a deferred answer', async () => {
    const approval = await client('timing', env.approvalRaProfileUuid, { issueWaitTimeout: 0, retryAfter: 7 });
    const { credentials } = await approval.nextEnrollment();
    const { cn, csr } = deferredCsr('timing');

    const resp = await simpleEnroll({ baseUrl: env.baseUrl, label: approval.profile.name, csr, ...credentials });

    expect(resp.status, resp.body.toString('utf8')).toBe(202);
    expect(resp.headers['retry-after']).toBe('7');
    expect(await findCertificatesByCommonName(api, cn)).toHaveLength(1);
  });
});
