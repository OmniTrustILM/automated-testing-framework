/**
 * EST-060..067, EST-085 — `/simplereenroll`: renewal with the same key and rekey with a new one,
 * under every authentication policy, the profile switches that refuse them, and identical renewals
 * sent at once.
 *
 * WHAT: under each policy a certificate is enrolled, renewed with the same key while presented as
 * the TLS client certificate, and the renewed one rekeyed with a new key. Also: a certificate from
 * another EST Profile is refused; under `certificateRegistration` the registration's password is
 * still required; a profile with renewal and rekey switched off refuses both with their own text;
 * several identical renewals sent at once create one successor, and every one answers it.
 *
 * WHY: RFC 7030 §4.2.2 has the client prove it holds the certificate it renews; the platform must
 * accept that proof under every policy, keep or replace the key as the CSR asks, and honour the
 * profile's switches.
 *
 * HOW: one EST Profile per policy (`estPolicyClients`), with `renewalThreshold` far beyond the
 * certificate's validity so a fresh certificate is due. The source certificate and its key are
 * presented over mutual TLS; issued certificates are read with Node's X509Certificate and removed
 * through the cleanup ledger.
 */

import { APIRequestContext, expect, test } from '@playwright/test';
import { EstEnv } from '../../utils/estEnv';
import { EstResponse } from '../../utils/estHttp';
import {
  certificateHasKey,
  cleanupCertificatesByCommonName,
  cleanupEnrolledCertificates,
  CsrOperation,
  derToPem,
  enrolledCertificate,
  EST_REFUSAL,
  findCertificatesByCommonName,
  issuedIdentityMismatches,
  sendCsr,
} from '../../utils/estEnroll';
import { createPolicyClient, PolicyClient, PolicyEnrollment, POLICIES, PolicyProfileOptions } from '../../utils/estPolicyClients';
import { EstSuite } from '../../utils/estSuite';
import { createCsr, KeyPair, keyToPem } from '../../utils/estPki';
import { EstAuthenticationPolicy } from '../../utils/estProfileUtils';

/** Days; far beyond any issued validity, so every fresh certificate is inside the renewal window. */
const RENEWAL_THRESHOLD = 3650;
const CONCURRENT_REQUESTS = 5;

interface Held {
  enrollment: PolicyEnrollment;
  der: Buffer;
  key: KeyPair;
}

function expectRefused(resp: EstResponse, status: number, text: string): void {
  expect(resp.status).toBe(status);
  expect(resp.body.toString('utf8')).toBe(text);
}

test.describe('@est reenroll', () => {
  const suite = new EstSuite();
  const { undo } = suite;
  let env: EstEnv;
  let api: APIRequestContext;
  const clients = new Map<EstAuthenticationPolicy, PolicyClient>();

  test.beforeAll(async () => ({ env, api } = await suite.open()));
  test.afterAll(() => suite.close());

  async function client(policy: EstAuthenticationPolicy, options: PolicyProfileOptions = {}): Promise<PolicyClient> {
    return createPolicyClient(api, env, (step) => undo.push(step), policy, 'reenroll', {
      renewalThreshold: RENEWAL_THRESHOLD,
      ...options,
    });
  }

  async function send(op: CsrOperation, profile: PolicyClient, enrollment: PolicyEnrollment, csrKey: KeyPair | undefined, source?: Held): Promise<{ resp: EstResponse; key: KeyPair }> {
    const csr = createCsr({ subject: enrollment.subject, sans: enrollment.sans, key: csrKey });
    const credentials = source
      ? { clientCert: { cert: derToPem(source.der), key: keyToPem(source.key) }, basicAuth: enrollment.reenrollBasicAuth }
      : enrollment.credentials;
    const resp = await sendCsr(op, { baseUrl: env.baseUrl, label: profile.profile.name, csr, ...credentials });
    if (resp.status === 200) {
      const der = enrolledCertificate(resp);
      undo.push(() => cleanupEnrolledCertificates(api, [der]));
      expect(issuedIdentityMismatches(der, csr.der)).toEqual([]);
    }
    return { resp, key: csr.key };
  }

  /** Enrolls a fresh certificate through the profile, the source of a re-enrollment. */
  async function enrollSource(profile: PolicyClient): Promise<Held> {
    const enrollment = await profile.nextEnrollment();
    const { resp, key } = await send('simpleenroll', profile, enrollment, undefined);
    return { enrollment, der: enrolledCertificate(resp), key };
  }

  async function reenroll(profile: PolicyClient, source: Held, csrKey?: KeyPair): Promise<{ resp: EstResponse; key: KeyPair }> {
    return send('simplereenroll', profile, source.enrollment, csrKey, source);
  }

  POLICIES.forEach((policy, index) => {
    test(`EST-06${index} ${policy}: renew keeps the key, then rekey replaces it`, async () => {
      const profile = await client(policy);
      clients.set(policy, profile);
      const source = await enrollSource(profile);

      const renewed = await reenroll(profile, source, source.key);
      const renewedDer = enrolledCertificate(renewed.resp);
      expect(certificateHasKey(renewedDer, source.key)).toBe(true);
      expect(renewedDer.equals(source.der)).toBe(false);

      const rekeyed = await reenroll(profile, { ...source, der: renewedDer });
      const rekeyedDer = enrolledCertificate(rekeyed.resp);
      expect(certificateHasKey(rekeyedDer, rekeyed.key)).toBe(true);
      expect(certificateHasKey(rekeyedDer, source.key)).toBe(false);
    });
  });

  test('EST-064 a certificate issued through another EST Profile is refused', async () => {
    const basic = clients.get('raBasic') ?? (await client('raBasic'));
    const vendor = clients.get('vendorMtls') ?? (await client('vendorMtls'));
    const otherBasic = await client('raBasic');
    const foreign = await enrollSource(basic);

    for (const target of [vendor, otherBasic]) {
      const { resp } = await reenroll(target, foreign, foreign.key);
      expectRefused(resp, 403, EST_REFUSAL.certificateRejected);
    }
  });

  test('EST-065 certificateRegistration: a re-enrollment without the registration password is refused', async () => {
    const registration = clients.get('certificateRegistration') ?? (await client('certificateRegistration'));
    const source = await enrollSource(registration);

    const { resp } = await reenroll(registration, { ...source, enrollment: { ...source.enrollment, reenrollBasicAuth: undefined } }, source.key);

    expectRefused(resp, 401, EST_REFUSAL.unauthorized);
  });

  test(`EST-085 ${CONCURRENT_REQUESTS} identical renewals at once create one successor`, async () => {
    const profile = clients.get('raBasic') ?? (await client('raBasic'));
    const source = await enrollSource(profile);
    const { enrollment } = source;
    const cn = String(enrollment.subject[0].value);
    undo.push(() => cleanupCertificatesByCommonName(api, cn));
    const csr = createCsr({ subject: enrollment.subject, key: source.key });
    const clientCert = { cert: derToPem(source.der), key: keyToPem(source.key) };
    const request = { baseUrl: env.baseUrl, label: profile.profile.name, csr, clientCert, basicAuth: enrollment.reenrollBasicAuth };

    const answers = await Promise.all(Array.from({ length: CONCURRENT_REQUESTS }, () => sendCsr('simplereenroll', request)));

    const certificates = answers.map((resp) => enrolledCertificate(resp));
    expect(new Set(certificates.map((der) => der.toString('base64'))).size).toBe(1);
    expect(certificates[0].equals(source.der)).toBe(false);
    expect(certificateHasKey(certificates[0], source.key)).toBe(true);
    expect(await findCertificatesByCommonName(api, cn)).toHaveLength(2);
  });

  test.describe('switched off', () => {
    let profile: PolicyClient;
    let source: Held;

    test.beforeAll(async () => {
      profile = await client('raBasic', { allowRenewal: false, allowRekey: false });
      source = await enrollSource(profile);
    });

    test('EST-066 a profile without renewal refuses a renewal with the same key', async () => {
      expectRefused((await reenroll(profile, source, source.key)).resp, 403, EST_REFUSAL.renewalNotAllowed);
    });

    test('EST-067 a profile without rekey refuses a renewal with a new key', async () => {
      expectRefused((await reenroll(profile, source)).resp, 403, EST_REFUSAL.rekeyNotAllowed);
    });
  });
});
