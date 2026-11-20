/**
 * estPolicyClients — one EST Profile per authentication policy, with a client that may use it.
 *
 * WHAT: creates an EST Profile under a given policy together with what its clients authenticate
 * with — a Basic secret, a pre-registration per enrollment, a trusted vendor CA and device
 * certificate, or a trusted RA CA and RA certificate — and hands out the identity and credentials
 * of the next enrollment.
 * WHY: re-enrollment and server key generation must hold under every policy, so those specs repeat
 * the same operation once per policy and need the same four setups.
 * HOW: every object is created through the platform and its removal registered with `undo`, which
 * the spec runs newest first through the cleanup ledger. The client PKI is generated per run
 * (RSA, node-forge). A registration is single-use, so `certificateRegistration` registers a fresh
 * run-unique subject per enrollment; a re-enrollment there also needs the registration's password.
 */

import { APIRequestContext } from '@playwright/test';
import * as crypto from 'crypto';
import { attemptCleanup } from './cleanupLedger';
import { EstEnv } from './estEnv';
import { createBasicSecret, createPreRegistration, deletePreRegistration, deleteSecret, deleteTrustedCa, importTrustedCa } from './estFixtures';
import { EstRequestOptions } from './estHttp';
import { certToPem, createCa, issueCert, keyToPem } from './estPki';
import {
  cleanupEstProfile,
  createEstProfile,
  CreateEstProfileOptions,
  EstAuthenticationPolicy,
  estProfileName,
  EstProfile,
} from './estProfileUtils';
import type * as forge from 'node-forge';

export const ID_KP_CMC_RA = '1.3.6.1.5.5.7.3.28';

export const POLICIES: EstAuthenticationPolicy[] = ['raBasic', 'certificateRegistration', 'vendorMtls', 'raMtls'];

export type Undo = (step: () => Promise<unknown>) => void;

export type EstCredentials = Pick<EstRequestOptions, 'basicAuth' | 'clientCert'>;

export interface PolicyEnrollment {
  subject: forge.pki.CertificateField[];
  sans?: string[];
  credentials: EstCredentials;
  /** The Basic credentials a re-enrollment sends besides the client certificate, if the policy needs them. */
  reenrollBasicAuth?: EstCredentials['basicAuth'];
}

export interface PolicyClient {
  policy: EstAuthenticationPolicy;
  profile: EstProfile;
  nextEnrollment(): Promise<PolicyEnrollment>;
}

export type PolicyProfileOptions = Omit<
  CreateEstProfileOptions,
  'name' | 'raProfileUuid' | 'authenticationPolicy' | 'basicCredentialSecretUuids' | 'trustedCaCertificateUuids'
> & { raProfileUuid?: string };

function hex(): string {
  return crypto.randomBytes(4).toString('hex');
}

function commonName(value: string): forge.pki.CertificateField[] {
  return [{ name: 'commonName', value }];
}

async function trust(api: APIRequestContext, undo: Undo, cn: string): Promise<{ uuid: string; ca: ReturnType<typeof createCa> }> {
  const ca = createCa({ cn });
  const { uuid } = await importTrustedCa(api, ca.cert);
  undo(() => attemptCleanup({ resource: 'certificate', uuid, name: cn }, () => deleteTrustedCa(api, uuid)));
  return { uuid, ca };
}

/** Creates the profile and its credentials; `suffix` names them so leftovers trace back to the spec. */
export async function createPolicyClient(
  api: APIRequestContext,
  env: EstEnv,
  undo: Undo,
  policy: EstAuthenticationPolicy,
  suffix: string,
  options: PolicyProfileOptions = {},
): Promise<PolicyClient> {
  const newProfile = async (extra: Partial<CreateEstProfileOptions>): Promise<EstProfile> => {
    const profile = await createEstProfile(api, {
      name: estProfileName(`${suffix}-${policy}`),
      authenticationPolicy: policy,
      ...options,
      raProfileUuid: options.raProfileUuid ?? env.raProfileUuid,
      ...extra,
    });
    undo(() => cleanupEstProfile(api, profile));
    return profile;
  };

  switch (policy) {
    case 'raBasic': {
      const basicAuth = { username: `est-e2e-${suffix}-${hex()}`, password: crypto.randomBytes(16).toString('hex') };
      const secret = await createBasicSecret(api, env, { name: estProfileName(`${suffix}-secret`), ...basicAuth });
      undo(() => attemptCleanup({ resource: 'secret', ...secret }, () => deleteSecret(api, secret.uuid)));
      const profile = await newProfile({ basicCredentialSecretUuids: [secret.uuid] });
      return {
        policy,
        profile,
        nextEnrollment: async () => ({ subject: commonName(`est-e2e-${suffix}-basic-${hex()}`), credentials: { basicAuth } }),
      };
    }
    case 'certificateRegistration': {
      const profile = await newProfile({});
      return {
        policy,
        profile,
        nextEnrollment: async () => {
          const cn = `est-e2e-${suffix}-reg-${hex()}`;
          const password = crypto.randomBytes(12).toString('hex');
          const { uuid } = await createPreRegistration(api, env, {
            subjectDn: `CN=${cn}`,
            secret: password,
            raProfileUuid: options.raProfileUuid,
          });
          undo(() => attemptCleanup({ resource: 'certificate', uuid, name: cn }, () => deletePreRegistration(api, uuid)));
          const basicAuth = { username: uuid, password };
          return { subject: commonName(cn), credentials: { basicAuth }, reenrollBasicAuth: basicAuth };
        },
      };
    }
    case 'vendorMtls': {
      const vendor = await trust(api, undo, `est-e2e-${suffix}-vendor-ca-${hex()}`);
      const profile = await newProfile({ trustedCaCertificateUuids: [vendor.uuid] });
      return {
        policy,
        profile,
        nextEnrollment: async () => {
          const subject = [...commonName(`device-${hex()}`), { name: 'organizationName', value: 'EST e2e Vendor' }];
          const sans = [`device-${hex()}.est.test`];
          const device = issueCert(vendor.ca, { subject, sans, eku: ['clientAuth'] });
          return { subject, sans, credentials: { clientCert: { cert: certToPem(device.cert), key: keyToPem(device.key) } } };
        },
      };
    }
    case 'raMtls': {
      const raCa = await trust(api, undo, `est-e2e-${suffix}-ra-ca-${hex()}`);
      const ra = issueCert(raCa.ca, { subject: `est-e2e-${suffix}-ra-${hex()}`, eku: ['clientAuth', ID_KP_CMC_RA] });
      const clientCert = { cert: certToPem(ra.cert), key: keyToPem(ra.key) };
      const profile = await newProfile({ trustedCaCertificateUuids: [raCa.uuid] });
      return {
        policy,
        profile,
        nextEnrollment: async () => ({ subject: commonName(`est-e2e-${suffix}-ra-device-${hex()}`), credentials: { clientCert } }),
      };
    }
  }
}
