/**
 * estProfileUtils — wrapper around the platform's EST Profile endpoints, for the EST suite.
 *
 * WHAT: creates an EST Profile, enables it, activates EST on an RA Profile, and undoes it all.
 * WHY: a spec exercises one authentication policy at a time, so it creates the profile it needs,
 * with the name, policy and credentials it chooses, instead of sharing long-lived ones.
 * HOW: create (POST /v1/estProfiles), enable, then GET the profile to read `estUrl`, which the
 * platform builds itself, and check that it reports the response timing that was sent, or the
 * platform's defaults for what was left out. Activation on an RA Profile is a separate call.
 * Deleting disables the profile first, since an enabled profile refuses to be deleted. Deletes tolerate 404 so a
 * cleanup that runs twice does not fail the second time. `cleanupEstProfile` routes the removal
 * through the cleanup ledger, so an object that cannot be removed fails the run.
 */

import { APIRequestContext } from '@playwright/test';
import { ensureOk } from './estAdminApi';
import { attemptCleanup } from './cleanupLedger';
import { Logger } from './Logger';
import { uniqueName } from './names';

const logger = new Logger('EstProfileUtils');

export type EstAuthenticationPolicy = 'raBasic' | 'certificateRegistration' | 'vendorMtls' | 'raMtls';

/** How long the platform waits and what it tells a client to wait, in seconds. */
export interface EstResponseTiming {
  issueWaitTimeout: number;
  retryAfter: number;
  serverKeyGenerationTimeout: number;
}

/** What the platform applies when a create request leaves the timing out. */
export const DEFAULT_RESPONSE_TIMING: EstResponseTiming = {
  issueWaitTimeout: 10,
  retryAfter: 30,
  serverKeyGenerationTimeout: 30,
};

export interface CreateEstProfileOptions extends Partial<EstResponseTiming> {
  name: string;
  raProfileUuid: string;
  authenticationPolicy: EstAuthenticationPolicy;
  serverKeyGeneration?: boolean;
  allowRenewal?: boolean;
  allowRekey?: boolean;
  renewalThreshold?: number;
  systemDefault?: boolean;
  basicCredentialSecretUuids?: string[];
  trustedCaCertificateUuids?: string[];
  keyRecovery?: boolean;
  keyRecoveryTokenProfileUuid?: string;
  keyRecoveryKeyAttributes?: unknown[];
  issueCertificateAttributes?: unknown[];
}

export interface EstProfile {
  uuid: string;
  name: string;
  /** e.g. https://<host>/.well-known/est/<name> — as the platform reports it. */
  estUrl: string;
}

export interface EstActivation {
  authorityUuid: string;
  raProfileUuid: string;
}

/** A name unique to this run, so a leftover profile can be traced to the run that left it. */
export function estProfileName(suffix: string): string {
  return uniqueName(`est-e2e-${suffix}`);
}

export async function createEstProfile(api: APIRequestContext, opts: CreateEstProfileOptions): Promise<EstProfile> {
  logger.info(`Creating EST Profile: ${opts.name} (${opts.authenticationPolicy})`);

  const createResp = await api.post('/api/v1/estProfiles', {
    data: {
      description: 'EST suite — created and removed by the run',
      serverKeyGeneration: false,
      renewalThreshold: 30,
      customAttributes: [],
      ...opts,
    },
  });
  await ensureOk(createResp, `Create EST Profile ${opts.name}`);
  const { uuid } = (await createResp.json()) as { uuid: string };

  try {
    await ensureOk(await api.patch(`/api/v1/estProfiles/${uuid}/enable`), `Enable EST Profile ${uuid}`);

    const getResp = await api.get(`/api/v1/estProfiles/${uuid}`);
    await ensureOk(getResp, `Get EST Profile ${uuid}`);
    const detail = (await getResp.json()) as { estUrl?: string } & Partial<EstResponseTiming>;
    const { estUrl } = detail;
    if (!estUrl) {
      throw new Error(`EST Profile ${uuid} is enabled but reports no estUrl`);
    }
    for (const field of Object.keys(DEFAULT_RESPONSE_TIMING) as Array<keyof EstResponseTiming>) {
      const expected = opts[field] ?? DEFAULT_RESPONSE_TIMING[field];
      if (detail[field] !== expected) {
        throw new Error(`EST Profile ${uuid} reports ${field} ${detail[field]}, expected ${expected}`);
      }
    }
    logger.info(`EST Profile ready: ${opts.name} (uuid: ${uuid}), url ${estUrl}`);
    return { uuid, name: opts.name, estUrl };
  } catch (error) {
    await attemptCleanup({ resource: 'estProfile', uuid, name: opts.name }, () => deleteEstProfile(api, uuid));
    throw error;
  }
}

export async function activateEstOnRaProfile(
  api: APIRequestContext,
  target: EstActivation & { estProfileUuid: string; issueCertificateAttributes?: unknown[] },
): Promise<void> {
  const url = `/api/v1/authorities/${target.authorityUuid}/raProfiles/${target.raProfileUuid}/protocols/est/activate/${target.estProfileUuid}`;
  await ensureOk(
    await api.patch(url, { data: { issueCertificateAttributes: target.issueCertificateAttributes ?? [] } }),
    `Activate EST on RA Profile ${target.raProfileUuid}`,
  );
}

/** 404: the RA Profile is already gone, and with it the activation. */
export async function deactivateEstOnRaProfile(api: APIRequestContext, target: EstActivation): Promise<void> {
  const url = `/api/v1/authorities/${target.authorityUuid}/raProfiles/${target.raProfileUuid}/protocols/est/deactivate`;
  await ensureOk(await api.patch(url), `Deactivate EST on RA Profile ${target.raProfileUuid}`, [404]);
}

export async function setEstProfileEnabled(api: APIRequestContext, uuid: string, enabled: boolean): Promise<void> {
  const action = enabled ? 'enable' : 'disable';
  await ensureOk(await api.patch(`/api/v1/estProfiles/${uuid}/${action}`), `${action} EST Profile ${uuid}`);
}

export async function deleteEstProfile(api: APIRequestContext, uuid: string): Promise<void> {
  logger.info(`Deleting EST Profile: ${uuid}`);
  await ensureOk(await api.patch(`/api/v1/estProfiles/${uuid}/disable`), `Disable EST Profile ${uuid}`, [404]);
  await ensureOk(await api.delete(`/api/v1/estProfiles/${uuid}`), `Delete EST Profile ${uuid}`, [404]);
}

/** Removes the profile through the ledger; with `activation`, deactivates EST on that RA Profile first. */
export async function cleanupEstProfile(
  api: APIRequestContext,
  profile: EstProfile,
  activation?: EstActivation,
): Promise<boolean> {
  if (activation) {
    await attemptCleanup(
      { resource: 'estActivation', uuid: activation.raProfileUuid, name: profile.name },
      () => deactivateEstOnRaProfile(api, activation),
    );
  }
  return attemptCleanup({ resource: 'estProfile', uuid: profile.uuid, name: profile.name }, () =>
    deleteEstProfile(api, profile.uuid),
  );
}

interface NamedAttribute {
  uuid?: string;
  name: string;
  version?: string;
  contentType?: string;
  content?: unknown;
}

/** The request form of an attribute the platform reported. */
function toRequestAttributes(attributes: NamedAttribute[] | undefined): unknown[] {
  return (attributes ?? []).map(({ uuid, name, version, contentType, content }) => ({
    uuid,
    name,
    version,
    contentType,
    content,
  }));
}

/** UUID of the EST Profile that serves requests without a label, if there is one. */
export async function findSystemDefaultEstProfile(api: APIRequestContext): Promise<string | undefined> {
  const resp = await api.get('/api/v1/estProfiles');
  await ensureOk(resp, 'List EST Profiles');
  const profiles = (await resp.json()) as Array<{ uuid: string; systemDefault?: boolean }>;
  return profiles.find((profile) => profile.systemDefault)?.uuid;
}

/**
 * Makes the EST Profile the system default again. Creating a default profile clears the flag of the
 * previous one and deleting it does not give the flag back, so a spec that creates one restores it.
 * The update replaces the whole profile, so the request is rebuilt from what the platform reports.
 */
export async function restoreSystemDefaultEstProfile(api: APIRequestContext, uuid: string): Promise<void> {
  logger.info(`Restoring the system default EST Profile: ${uuid}`);
  const resp = await api.get(`/api/v1/estProfiles/${uuid}`);
  await ensureOk(resp, `Get EST Profile ${uuid}`);
  const d = (await resp.json()) as Record<string, any>;
  const associations = d.certificateAssociations;
  const data = {
    description: d.description,
    raProfileUuid: d.raProfile?.uuid,
    systemDefault: true,
    authenticationPolicy: d.authenticationPolicy,
    basicCredentialSecretUuids: (d.basicCredentialSecrets ?? []).map((secret: { uuid: string }) => secret.uuid),
    trustedCaCertificateUuids: (d.trustedCaCertificates ?? []).map((ca: { uuid: string }) => ca.uuid),
    allowRenewal: d.allowRenewal,
    allowRekey: d.allowRekey,
    renewalThreshold: d.renewalThreshold,
    serverKeyGeneration: d.serverKeyGeneration,
    keyRecovery: d.keyRecovery,
    keyRecoveryTokenProfileUuid: d.keyRecoveryTokenProfile?.uuid,
    keyRecoveryKeyAttributes: toRequestAttributes(d.keyRecoveryKeyAttributes),
    issueWaitTimeout: d.issueWaitTimeout,
    retryAfter: d.retryAfter,
    serverKeyGenerationTimeout: d.serverKeyGenerationTimeout,
    issueCertificateAttributes: toRequestAttributes(d.issueCertificateAttributes),
    customAttributes: toRequestAttributes(d.customAttributes),
    certificateAssociations: associations && {
      ownerUuid: associations.ownerUuid,
      groupUuids: associations.groupUuids ?? [],
      customAttributes: toRequestAttributes(associations.customAttributes),
    },
  };
  await ensureOk(await api.put(`/api/v1/estProfiles/${uuid}`, { data }), `Restore system default EST Profile ${uuid}`);
}
