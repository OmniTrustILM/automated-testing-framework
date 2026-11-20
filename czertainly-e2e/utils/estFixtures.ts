/**
 * estFixtures — platform objects the EST specs enroll against.
 *
 * WHAT: a Basic credential secret in the vault, a trusted CA certificate, a pre-registered
 * certificate record and a bare RA Profile, each with its delete; and the approvals of a
 * certificate request, with their approval.
 * WHY: the EST authentication policies need something to authenticate with — a stored username
 * and password, a trusted issuer of client certificates, a registration holding a one-time
 * secret — and each spec brings its own so that nothing is shared between them.
 * HOW: the secret is created in the Vault Profile, polled until `active` (the vault connector
 * stores it asynchronously) and enabled. The CA is uploaded and marked trusted. The pre-registration
 * is a certificate record created by the v2 register operation. Deletes tolerate 404; callers
 * wrap them in `attemptCleanup`. Passwords and registration secrets are never logged.
 */

import { APIRequestContext } from '@playwright/test';
import { ensureOk } from './estAdminApi';
import { EstEnv } from './estEnv';
import { certToDer, Certificate } from './estPki';
import { deleteCertificate } from './certificateUtils';
import { attemptCleanup } from './cleanupLedger';
import { Logger } from './Logger';

const logger = new Logger('EstFixtures');

export interface BasicSecretOptions {
  name: string;
  username: string;
  password: string;
  /** How long to wait for the vault to report the secret active. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function createBasicSecret(
  api: APIRequestContext,
  env: EstEnv,
  opts: BasicSecretOptions,
): Promise<{ uuid: string; name: string }> {
  logger.info(`Creating Basic secret: ${opts.name}`);
  const createResp = await api.post(`/api/v1/vaults/${env.vaultUuid}/vaultProfiles/${env.vaultProfileUuid}/secrets`, {
    data: {
      name: opts.name,
      description: 'EST suite — created and removed by the run',
      secret: { type: 'basicAuth', username: opts.username, password: opts.password },
      attributes: [],
      customAttributes: [],
    },
  });
  await ensureOk(createResp, `Create secret ${opts.name}`);
  const { uuid } = (await createResp.json()) as { uuid: string };

  try {
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    for (;;) {
      const getResp = await api.get(`/api/v1/secrets/${uuid}`);
      await ensureOk(getResp, `Get secret ${uuid}`);
      const { state } = (await getResp.json()) as { state: string };
      if (state === 'active') break;
      if (Date.now() > deadline) throw new Error(`Secret ${uuid} did not become active, last state: ${state}`);
      await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs ?? 1000));
    }

    await ensureOk(await api.patch(`/api/v1/secrets/${uuid}/enable`), `Enable secret ${uuid}`);
    return { uuid, name: opts.name };
  } catch (error) {
    await attemptCleanup({ resource: 'secret', uuid, name: opts.name }, () => deleteSecret(api, uuid));
    throw error;
  }
}

export async function setSecretEnabled(api: APIRequestContext, uuid: string, enabled: boolean): Promise<void> {
  const action = enabled ? 'enable' : 'disable';
  await ensureOk(await api.patch(`/api/v1/secrets/${uuid}/${action}`), `${action} secret ${uuid}`);
}

export async function deleteSecret(api: APIRequestContext, uuid: string): Promise<void> {
  logger.info(`Deleting secret: ${uuid}`);
  await ensureOk(await api.patch(`/api/v1/secrets/${uuid}/disable`), `Disable secret ${uuid}`, [404]);
  await ensureOk(await api.delete(`/api/v1/secrets/${uuid}`), `Delete secret ${uuid}`, [404]);
}

export async function importTrustedCa(api: APIRequestContext, cert: Certificate): Promise<{ uuid: string }> {
  logger.info(`Importing trusted CA: ${cert.subject.getField('CN')?.value ?? 'unnamed'}`);
  const uploadResp = await api.post('/api/v1/certificates/upload', {
    data: { certificate: certToDer(cert).toString('base64'), customAttributes: [] },
  });
  await ensureOk(uploadResp, 'Upload CA certificate');
  const { uuid } = (await uploadResp.json()) as { uuid: string };

  try {
    await ensureOk(await api.patch(`/api/v1/certificates/${uuid}`, { data: { trustedCa: true } }), `Trust CA ${uuid}`);
    return { uuid };
  } catch (error) {
    await attemptCleanup({ resource: 'certificate', uuid, name: 'trusted CA' }, () => deleteTrustedCa(api, uuid));
    throw error;
  }
}

export async function deleteTrustedCa(api: APIRequestContext, uuid: string): Promise<void> {
  await deleteCertificate(api, uuid);
}

export async function createPreRegistration(
  api: APIRequestContext,
  env: EstEnv,
  opts: { subjectDn: string; secret: string; raProfileUuid?: string },
): Promise<{ uuid: string }> {
  const raProfileUuid = opts.raProfileUuid ?? env.raProfileUuid;
  logger.info(`Pre-registering certificate: ${opts.subjectDn}`);
  const resp = await api.post(
    `/api/v2/operations/authorities/${env.authorityUuid}/raProfiles/${raProfileUuid}/certificates/register`,
    { data: { subjectDn: opts.subjectDn, authorizationSecret: opts.secret } },
  );
  await ensureOk(resp, `Pre-register ${opts.subjectDn}`);
  return { uuid: ((await resp.json()) as { uuid: string }).uuid };
}

export async function deletePreRegistration(api: APIRequestContext, uuid: string): Promise<void> {
  await deleteCertificate(api, uuid);
}

/** An enabled RA Profile without attributes on the main authority. */
export async function createRaProfile(api: APIRequestContext, env: EstEnv, name: string): Promise<{ uuid: string }> {
  logger.info(`Creating RA Profile: ${name}`);
  const resp = await api.post(`/api/v1/authorities/${env.authorityUuid}/raProfiles`, {
    data: { name, attributes: [], customAttributes: [], enabled: true },
  });
  await ensureOk(resp, `Create RA Profile ${name}`);
  return { uuid: ((await resp.json()) as { uuid: string }).uuid };
}

export async function deleteRaProfile(api: APIRequestContext, env: EstEnv, uuid: string): Promise<void> {
  const url = `/api/v1/authorities/${env.authorityUuid}/raProfiles/${uuid}`;
  await ensureOk(await api.patch(`${url}/disable`), `Disable RA Profile ${uuid}`, [404]);
  await ensureOk(await api.delete(url), `Delete RA Profile ${uuid}`, [404]);
}

export interface CertificateApproval {
  approvalUuid: string;
  status: string;
}

export async function getCertificateApprovals(api: APIRequestContext, certificateUuid: string): Promise<CertificateApproval[]> {
  const resp = await api.get(`/api/v1/certificates/${certificateUuid}/approvals`, {
    params: { itemsPerPage: 100, pageNumber: 1 },
  });
  await ensureOk(resp, `Get approvals of certificate ${certificateUuid}`);
  return ((await resp.json()) as { approvals: CertificateApproval[] }).approvals;
}

export async function approve(api: APIRequestContext, approvalUuid: string): Promise<void> {
  logger.info(`Approving: ${approvalUuid}`);
  await ensureOk(await api.patch(`/api/v1/approvals/${approvalUuid}/approve`), `Approve ${approvalUuid}`);
}
