/**
 * EST-020..047 — the four EST authentication policies, each accepting its own clients and refusing
 * everyone else.
 *
 * WHAT: one EST Profile per policy on the main RA Profile, and `/simpleenroll` under its label.
 * - `raBasic`: the profile's Basic secret enrolls; a wrong password and missing credentials get
 *   the same 401 challenge; a disabled secret or a disabled profile refuses.
 * - `certificateRegistration`: a pre-registration is completed by reference (user name = its
 *   UUID) and by the CSR's identity; a wrong password and an unknown reference get the same 401;
 *   a completed registration refuses a new request.
 * - `vendorMtls`: a device certificate from a trusted CA enrolls its own identity, also after
 *   rotation; an untrusted, expired or revoked certificate, a garbage `ssl-client-cert` header and
 *   a well-formed one sent without a TLS certificate are refused; so is a CSR whose subject or
 *   SAN differs from the client certificate.
 * - `raMtls`: an RA certificate with `id-kp-cmcRA` enrolls any subject, also after rotation; one
 *   without the usage, or untrusted, expired, revoked, garbage or spoofed, is refused.
 *
 * WHY: each policy is the only gate between the internet and the CA; a refusal must not leak which
 * part was wrong, and none may fall back to another policy.
 *
 * HOW: the CAs and client certificates are generated per run (RSA, node-forge); the vendor and RA
 * CAs are imported and trusted. A revoked certificate needs a CRL the platform can fetch, so it
 * comes from the environment (`EST_REVOKED_*`), and those tests skip when it is not provisioned.
 * Refusals are told apart by status and the platform's fixed text. Everything created, issued
 * certificates included, is removed through the cleanup ledger.
 */

import { APIRequestContext, expect, test } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { EstEnv, RevokedClient } from '../../utils/estEnv';
import { EstResponse } from '../../utils/estHttp';
import {
  cleanupEstProfile,
  createEstProfile,
  CreateEstProfileOptions,
  estProfileName,
  EstProfile,
  setEstProfileEnabled,
} from '../../utils/estProfileUtils';
import {
  createBasicSecret,
  createPreRegistration,
  deletePreRegistration,
  deleteSecret,
  deleteTrustedCa,
  importTrustedCa,
  setSecretEnabled,
} from '../../utils/estFixtures';
import {
  certificateHasKey,
  cleanupEnrolledCertificates,
  EnrollOptions,
  enrolledCertificate,
  EST_REFUSAL,
  forwardedCertificateHeader,
  getInventoryCertificate,
  issuedIdentityMismatches,
  simpleEnroll,
} from '../../utils/estEnroll';
import { attemptCleanup } from '../../utils/cleanupLedger';
import { Ca, certToPem, createCa, createCsr, Csr, issueCert, keyToPem } from '../../utils/estPki';
import { EstSuite } from '../../utils/estSuite';

const ID_KP_CMC_RA = '1.3.6.1.5.5.7.3.28';
const DAY_MS = 24 * 60 * 60 * 1000;

type ClientCert = { cert: string; key: string };

function tlsClient(issued: ReturnType<typeof issueCert>): ClientCert {
  return { cert: certToPem(issued.cert), key: keyToPem(issued.key) };
}

function fileClient(revoked: RevokedClient): ClientCert {
  return { cert: fs.readFileSync(revoked.certPath, 'utf8'), key: fs.readFileSync(revoked.keyPath, 'utf8') };
}

function hex(): string {
  return crypto.randomBytes(4).toString('hex');
}

function expectRefused(resp: EstResponse, status: number, text: string): void {
  expect(resp.status).toBe(status);
  expect(resp.body.toString('utf8')).toBe(text);
}

test.describe('@est policies', () => {
  const suite = new EstSuite();
  const { undo } = suite;
  let env: EstEnv;
  let api: APIRequestContext;

  test.beforeAll(async () => ({ env, api } = await suite.open()));
  test.afterAll(() => suite.close());

  async function newProfile(suffix: string, opts: Omit<CreateEstProfileOptions, 'name' | 'raProfileUuid'>): Promise<EstProfile> {
    const profile = await createEstProfile(api, { name: estProfileName(suffix), raProfileUuid: env.raProfileUuid, ...opts });
    undo.push(() => cleanupEstProfile(api, profile));
    return profile;
  }

  async function trust(ca: Ca): Promise<string> {
    const { uuid } = await importTrustedCa(api, ca.cert);
    undo.push(() => attemptCleanup({ resource: 'certificate', uuid, name: 'trusted CA' }, () => deleteTrustedCa(api, uuid)));
    return uuid;
  }

  /** Enrolls under the profile's label; a certificate it issues is checked against the CSR and removed at the end. */
  async function enroll(profile: EstProfile, opts: Omit<EnrollOptions, 'baseUrl' | 'label'>): Promise<EstResponse> {
    const resp = await simpleEnroll({ baseUrl: env.baseUrl, label: profile.name, ...opts });
    if (resp.status === 200) {
      const der = enrolledCertificate(resp);
      undo.push(() => cleanupEnrolledCertificates(api, [der]));
      expect(certificateHasKey(der, opts.csr.key)).toBe(true);
      expect(issuedIdentityMismatches(der, opts.csr.der)).toEqual([]);
    }
    return resp;
  }

  test.describe('raBasic', () => {
    let profile: EstProfile;
    let secretUuid: string;
    const credentials = { username: `est-e2e-ra-${hex()}`, password: crypto.randomBytes(16).toString('hex') };
    const csr = (): Csr => createCsr({ subject: `est-e2e-basic-${hex()}` });

    test.beforeAll(async () => {
      const secret = await createBasicSecret(api, env, { name: estProfileName('policy-basic-secret'), ...credentials });
      secretUuid = secret.uuid;
      undo.push(() => attemptCleanup({ resource: 'secret', ...secret }, () => deleteSecret(api, secret.uuid)));
      profile = await newProfile('policy-basic', { authenticationPolicy: 'raBasic', basicCredentialSecretUuids: [secret.uuid] });
    });

    test('EST-020 raBasic: the profile\'s Basic credentials enroll', async () => {
      expect((await enroll(profile, { csr: csr(), basicAuth: credentials })).status).toBe(200);
    });

    test('EST-021 raBasic: a wrong password gets the same 401 challenge as no credentials', async () => {
      const wrong = await enroll(profile, { csr: csr(), basicAuth: { ...credentials, password: 'wrong-password' } });
      const none = await enroll(profile, { csr: csr() });
      for (const resp of [wrong, none]) {
        expectRefused(resp, 401, EST_REFUSAL.unauthorized);
        expect(resp.headers['www-authenticate']).toBe(`Basic realm="${profile.name}"`);
      }
    });

    test('EST-022 raBasic lockout: a disabled Basic secret no longer enrolls', async () => {
      await setSecretEnabled(api, secretUuid, false);
      try {
        expectRefused(await enroll(profile, { csr: csr(), basicAuth: credentials }), 401, EST_REFUSAL.unauthorized);
      } finally {
        await setSecretEnabled(api, secretUuid, true);
      }
    });

    test('EST-023 raBasic lockout: a disabled EST Profile answers 404', async () => {
      await setEstProfileEnabled(api, profile.uuid, false);
      try {
        expectRefused(await enroll(profile, { csr: csr(), basicAuth: credentials }), 404, EST_REFUSAL.notFound);
      } finally {
        await setEstProfileEnabled(api, profile.uuid, true);
      }
    });
  });

  test.describe('certificateRegistration', () => {
    let profile: EstProfile;

    async function register(): Promise<{ uuid: string; subject: string; secret: string }> {
      const subject = `est-e2e-reg-${hex()}`;
      const secret = crypto.randomBytes(12).toString('hex');
      const { uuid } = await createPreRegistration(api, env, { subjectDn: `CN=${subject}`, secret });
      undo.push(() => attemptCleanup({ resource: 'certificate', uuid, name: subject }, () => deletePreRegistration(api, uuid)));
      return { uuid, subject, secret };
    }

    test.beforeAll(async () => {
      profile = await newProfile('policy-reg', { authenticationPolicy: 'certificateRegistration' });
    });

    test('EST-024 certificateRegistration: the user name as reference completes that registration', async () => {
      const reg = await register();
      const resp = await enroll(profile, { csr: createCsr({ subject: reg.subject }), basicAuth: { username: reg.uuid, password: reg.secret } });
      expect(resp.status).toBe(200);
      const completed = await getInventoryCertificate(api, enrolledCertificate(resp));
      expect(completed.uuid).toBe(reg.uuid);
      expect(completed.state).toBe('issued');
    });

    test('EST-025 certificateRegistration: the CSR identity finds and completes the registration', async () => {
      const reg = await register();
      const resp = await enroll(profile, { csr: createCsr({ subject: reg.subject }), basicAuth: { username: 'any-device', password: reg.secret } });
      expect(resp.status).toBe(200);
      expect((await getInventoryCertificate(api, enrolledCertificate(resp))).uuid).toBe(reg.uuid);
    });

    test('EST-026 certificateRegistration: a wrong password gets the same 401 as an unknown reference', async () => {
      const reg = await register();
      const csr = createCsr({ subject: reg.subject });
      const wrong = await enroll(profile, { csr, basicAuth: { username: reg.uuid, password: 'wrong-secret-0000' } });
      const unknown = await enroll(profile, { csr, basicAuth: { username: crypto.randomUUID(), password: reg.secret } });
      for (const resp of [wrong, unknown]) {
        expectRefused(resp, 401, EST_REFUSAL.registrationRejected);
        expect(resp.headers['www-authenticate']).toBe(`Basic realm="${profile.name}"`);
      }
    });

    test('EST-027 certificateRegistration lockout: a completed registration refuses a new request', async () => {
      const reg = await register();
      const credentials = { username: reg.uuid, password: reg.secret };
      expect((await enroll(profile, { csr: createCsr({ subject: reg.subject }), basicAuth: credentials })).status).toBe(200);
      const again = await enroll(profile, { csr: createCsr({ subject: reg.subject }), basicAuth: credentials });
      expectRefused(again, 401, EST_REFUSAL.registrationRejected);
    });
  });

  /** The refusals both certificate policies share: untrusted, expired, revoked, garbage and spoofed. */
  function certificateRefusals(
    first: number,
    policy: string,
    ctx: () => { profile: EstProfile; csr: () => Csr; trusted: ClientCert; untrusted: ClientCert; expired: ClientCert },
    revoked: () => RevokedClient | undefined,
  ): void {
    test(`EST-0${first} ${policy}: a certificate from an untrusted CA is refused`, async () => {
      const { profile, csr, untrusted } = ctx();
      expectRefused(await enroll(profile, { csr: csr(), clientCert: untrusted }), 403, EST_REFUSAL.certificateRejected);
    });

    test(`EST-0${first + 1} ${policy}: an expired certificate is refused`, async () => {
      const { profile, csr, expired } = ctx();
      const resp = await enroll(profile, { csr: csr(), clientCert: expired });
      // A TLS edge may refuse it during the handshake (ingress-nginx: 400) before the platform sees it.
      const refusedByEdge = resp.status === 400 && resp.body.toString('utf8').includes('The SSL certificate error');
      if (!refusedByEdge) expectRefused(resp, 403, EST_REFUSAL.certificateRejected);
    });

    test(`EST-0${first + 2} ${policy}: a revoked certificate is refused`, async () => {
      const client = revoked();
      test.skip(!client, 'EST_REVOKED_* not set: no revoked certificate with a fetchable CRL is provisioned');
      const { profile, csr } = ctx();
      expectRefused(await enroll(profile, { csr: csr(), clientCert: fileClient(client!) }), 403, EST_REFUSAL.certificateRejected);
    });

    test(`EST-0${first + 3} ${policy}: a garbage ssl-client-cert header is refused`, async () => {
      const { profile, csr } = ctx();
      const resp = await enroll(profile, { csr: csr(), headers: { 'ssl-client-cert': 'garbage' } });
      expectRefused(resp, 403, EST_REFUSAL.certificateRejected);
    });

    test(`EST-0${first + 4} ${policy}: a well-formed ssl-client-cert header without a TLS certificate is refused`, async () => {
      const { profile, csr, trusted } = ctx();
      const resp = await enroll(profile, { csr: csr(), headers: forwardedCertificateHeader(trusted.cert) });
      expectRefused(resp, 403, EST_REFUSAL.certificateRejected);
    });
  }

  test.describe('vendorMtls', () => {
    let profile: EstProfile;
    let vendorCa: Ca;
    let device: ClientCert;
    let rotated: ClientCert;
    let untrusted: ClientCert;
    let expired: ClientCert;
    const subject = [
      { name: 'commonName', value: `device-${hex()}` },
      { name: 'organizationName', value: 'EST e2e Vendor' },
    ];
    const sans = [`device-${hex()}.est.test`];
    const csr = (): Csr => createCsr({ subject, sans });

    test.beforeAll(async () => {
      vendorCa = createCa({ cn: `est-e2e-vendor-ca-${hex()}` });
      const untrustedCa = createCa({ cn: `est-e2e-untrusted-ca-${hex()}` });
      device = tlsClient(issueCert(vendorCa, { subject, sans, eku: ['clientAuth'] }));
      rotated = tlsClient(issueCert(vendorCa, { subject, sans, eku: ['clientAuth'] }));
      untrusted = tlsClient(issueCert(untrustedCa, { subject, sans, eku: ['clientAuth'] }));
      expired = tlsClient(
        issueCert(vendorCa, { subject, sans, eku: ['clientAuth'], notBefore: new Date(Date.now() - 10 * DAY_MS), notAfter: new Date(Date.now() - DAY_MS) }),
      );
      const trusted = [await trust(vendorCa)];
      if (env.revoked) trusted.push(env.revoked.vendor.caUuid);
      profile = await newProfile('policy-vendor', { authenticationPolicy: 'vendorMtls', trustedCaCertificateUuids: trusted });
    });

    test('EST-030 vendorMtls: a trusted device certificate enrolls its own identity', async () => {
      expect((await enroll(profile, { csr: csr(), clientCert: device })).status).toBe(200);
    });

    test('EST-031 vendorMtls: a rotated certificate from the same CA enrolls with no configuration change', async () => {
      expect((await enroll(profile, { csr: csr(), clientCert: rotated })).status).toBe(200);
    });

    certificateRefusals(32, 'vendorMtls', () => ({ profile, csr, trusted: device, untrusted, expired }), () => env.revoked?.vendor);

    test('EST-037 vendorMtls: a CSR subject that differs from the client certificate is refused', async () => {
      const other = createCsr({ subject: [{ name: 'commonName', value: `device-${hex()}` }, subject[1]], sans });
      expectRefused(await enroll(profile, { csr: other, clientCert: device }), 403, EST_REFUSAL.identityMismatch);
    });

    test('EST-038 vendorMtls: a CSR SAN that differs from the client certificate is refused', async () => {
      const other = createCsr({ subject, sans: [`other-${hex()}.est.test`] });
      expectRefused(await enroll(profile, { csr: other, clientCert: device }), 403, EST_REFUSAL.identityMismatch);
    });
  });

  test.describe('raMtls', () => {
    let profile: EstProfile;
    let ra: ClientCert;
    let rotated: ClientCert;
    let noRaUsage: ClientCert;
    let untrusted: ClientCert;
    let expired: ClientCert;
    const raSubject = `est-e2e-ra-${hex()}`;
    const raUsage = ['clientAuth', ID_KP_CMC_RA];
    const csr = (): Csr => createCsr({ subject: `est-e2e-ra-device-${hex()}` });

    test.beforeAll(async () => {
      const raCa = createCa({ cn: `est-e2e-ra-ca-${hex()}` });
      const untrustedCa = createCa({ cn: `est-e2e-untrusted-ra-ca-${hex()}` });
      ra = tlsClient(issueCert(raCa, { subject: raSubject, eku: raUsage }));
      rotated = tlsClient(issueCert(raCa, { subject: raSubject, eku: raUsage }));
      noRaUsage = tlsClient(issueCert(raCa, { subject: raSubject, eku: ['clientAuth'] }));
      untrusted = tlsClient(issueCert(untrustedCa, { subject: raSubject, eku: raUsage }));
      expired = tlsClient(
        issueCert(raCa, { subject: raSubject, eku: raUsage, notBefore: new Date(Date.now() - 10 * DAY_MS), notAfter: new Date(Date.now() - DAY_MS) }),
      );
      const trusted = [await trust(raCa)];
      if (env.revoked) trusted.push(env.revoked.ra.caUuid);
      profile = await newProfile('policy-ra', { authenticationPolicy: 'raMtls', trustedCaCertificateUuids: trusted });
    });

    test('EST-040 raMtls: an RA certificate enrolls a subject other than its own', async () => {
      expect((await enroll(profile, { csr: csr(), clientCert: ra })).status).toBe(200);
    });

    test('EST-041 raMtls: a rotated RA certificate from the same CA enrolls with no configuration change', async () => {
      expect((await enroll(profile, { csr: csr(), clientCert: rotated })).status).toBe(200);
    });

    test('EST-042 raMtls: a certificate without id-kp-cmcRA is refused', async () => {
      expectRefused(await enroll(profile, { csr: csr(), clientCert: noRaUsage }), 403, EST_REFUSAL.certificateRejected);
    });

    certificateRefusals(43, 'raMtls', () => ({ profile, csr, trusted: ra, untrusted, expired }), () => env.revoked?.ra);
  });
});
