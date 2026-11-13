/**
 * EST-070..076 — `/serverkeygen`: a key made in memory under every policy, the refusals, and key
 * recovery on a token.
 *
 * WHAT:
 * - in memory, under each policy: 200 `multipart/mixed` with `Cache-Control: no-store`, a PKCS#8
 *   key and one certificate that belong together, and no private key left in the inventory;
 * - a profile without server key generation, and an RA Profile with an approval profile, refuse;
 * - with key recovery, two requests on one profile both succeed with two distinct keys, each kept
 *   on the token and each matching its certificate.
 *
 * WHY: RFC 7030 §4.4 hands a private key over the wire, so it must not be cached or kept unless
 * the profile asks for recovery, and recovery must work for every request, not only the first.
 *
 * HOW: one EST Profile per policy (`estPolicyClients`); the key-recovery profile uses the
 * provisioned token profile with ECDSA P-256 key attributes. Keys are compared as SPKI DER
 * through Node's crypto. Certificates, and recovered keys on the token, are removed through the
 * cleanup ledger.
 */

import { APIRequestContext, expect, test } from '@playwright/test';
import * as crypto from 'crypto';
import { EstEnv } from '../../utils/estEnv';
import { EstResponse } from '../../utils/estHttp';
import { cleanupEnrolledCertificates, EST_REFUSAL, getInventoryCertificate, issuedIdentityMismatches, sendCsr } from '../../utils/estEnroll';
import { createPolicyClient, PolicyClient, PolicyEnrollment, POLICIES, PolicyProfileOptions } from '../../utils/estPolicyClients';
import { EstSuite } from '../../utils/estSuite';
import { createCsr, Csr, sha256Fingerprint } from '../../utils/estPki';
import { EstAuthenticationPolicy } from '../../utils/estProfileUtils';
import {
  certificatePublicKey,
  deleteTokenKey,
  ecdsaKeyRecoveryAttributes,
  getCertificateKey,
  privateKeyMatchesCertificate,
  serverGeneratedKey,
  ServerGeneratedKey,
} from '../../utils/estServerKeygen';
import { attemptCleanup } from '../../utils/cleanupLedger';

function expectRefused(resp: EstResponse, status: number, text: string): void {
  expect(resp.status).toBe(status);
  expect(resp.body.toString('utf8')).toBe(text);
}

test.describe('@est serverkeygen', () => {
  const suite = new EstSuite();
  const { undo } = suite;
  let env: EstEnv;
  let api: APIRequestContext;

  test.beforeAll(async () => ({ env, api } = await suite.open()));
  test.afterAll(() => suite.close());

  async function client(policy: EstAuthenticationPolicy, options: PolicyProfileOptions = { serverKeyGeneration: true }): Promise<PolicyClient> {
    return createPolicyClient(api, env, (step) => undo.push(step), policy, 'skg', options);
  }

  async function serverKeygen(profile: PolicyClient, enrollment?: PolicyEnrollment): Promise<{ resp: EstResponse; csr: Csr }> {
    const { subject, sans, credentials } = enrollment ?? (await profile.nextEnrollment());
    const csr = createCsr({ subject, sans });
    return { resp: await sendCsr('serverkeygen', { baseUrl: env.baseUrl, label: profile.profile.name, csr, ...credentials }), csr };
  }

  /** Checks the answer is a successful key generation for the enrollment's subject. */
  function expectGenerated(resp: EstResponse, generated: ServerGeneratedKey, enrollment: PolicyEnrollment, csr: Csr): void {
    expect(resp.headers['content-type']).toMatch(/^multipart\/mixed;/);
    expect(resp.headers['cache-control']).toBe('no-store');
    expect(privateKeyMatchesCertificate(generated.key, generated.certificate)).toBe(true);
    expect(new crypto.X509Certificate(generated.certificate).subject).toContain(`CN=${enrollment.subject[0].value}`);
    expect(issuedIdentityMismatches(generated.certificate, csr.der)).toEqual([]);
  }

  POLICIES.forEach((policy, index) => {
    test(`EST-07${index} ${policy}: an in-memory key reaches the client only`, async () => {
      const profile = await client(policy);
      const enrollment = await profile.nextEnrollment();

      const { resp, csr } = await serverKeygen(profile, enrollment);

      const generated = serverGeneratedKey(resp);
      const { certificate } = generated;
      undo.push(() => cleanupEnrolledCertificates(api, [certificate]));
      expectGenerated(resp, generated, enrollment, csr);
      const key = await getCertificateKey(api, (await getInventoryCertificate(api, certificate)).uuid);
      expect(key?.hasPrivateKey ?? false).toBe(false);
    });
  });

  test('EST-074 a profile without server key generation refuses', async () => {
    const profile = await client('raBasic', { serverKeyGeneration: false });

    expectRefused((await serverKeygen(profile)).resp, 403, EST_REFUSAL.serverKeygenDisabled);
  });

  test('EST-075 an RA Profile with an approval profile refuses', async () => {
    const profile = await client('raBasic', { serverKeyGeneration: true, raProfileUuid: env.approvalRaProfileUuid });

    expectRefused((await serverKeygen(profile)).resp, 403, EST_REFUSAL.serverKeygenUnavailable);
  });

  test('EST-076 key recovery: two requests on one profile keep two distinct keys on the token', async () => {
    const profile = await client('raBasic', {
      serverKeyGeneration: true,
      keyRecovery: true,
      keyRecoveryTokenProfileUuid: env.keyRecoveryTokenProfileUuid,
      keyRecoveryKeyAttributes: await ecdsaKeyRecoveryAttributes(api, env.keyRecoveryTokenProfileUuid),
    });

    const publicKeys: Buffer[] = [];
    for (let request = 0; request < 2; request++) {
      const enrollment = await profile.nextEnrollment();
      const { resp, csr } = await serverKeygen(profile, enrollment);
      const generated = serverGeneratedKey(resp);
      const { certificate } = generated;
      // The key is found through its certificate, so it is looked up before the certificate goes.
      undo.push(async () => {
        const linked: { uuid?: string } = {};
        await attemptCleanup({ resource: 'key', uuid: sha256Fingerprint(certificate), name: 'EST recovered key lookup' }, async () => {
          linked.uuid = (await getCertificateKey(api, (await getInventoryCertificate(api, certificate)).uuid))?.uuid;
        });
        await cleanupEnrolledCertificates(api, [certificate]);
        const keyUuid = linked.uuid;
        if (keyUuid) await attemptCleanup({ resource: 'key', uuid: keyUuid, name: 'EST recovered key' }, () => deleteTokenKey(api, keyUuid));
      });
      const { uuid } = await getInventoryCertificate(api, certificate);
      const kept = await getCertificateKey(api, uuid);

      expectGenerated(resp, generated, enrollment, csr);
      expect(kept?.hasPrivateKey).toBe(true);
      expect(kept?.tokenProfileUuid).toBe(env.keyRecoveryTokenProfileUuid);
      expect(kept?.publicKey?.equals(certificatePublicKey(certificate))).toBe(true);
      publicKeys.push(new crypto.X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' }));
    }

    expect(publicKeys[0].equals(publicKeys[1])).toBe(false);
  });
});
