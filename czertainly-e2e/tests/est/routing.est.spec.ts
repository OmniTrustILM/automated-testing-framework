/**
 * EST-010..016 — how a request's label selects the EST Profile and the RA Profile that serve it.
 *
 * WHAT: two `raBasic` EST Profiles, each with its own Basic secret: `default` is the system
 * default, `direct` is also activated on the pre-provisioned label RA Profile. A request without
 * a label must be served by `default`, `/<direct>/` by `direct` on its own RA Profile, and
 * `/<label RA Profile>/` by `direct` on that RA Profile. Each route accepts only its own profile's
 * credentials. Unknown labels answer 404 and never fall back to the default; a label held by an
 * EST Profile and an RA Profile at once cannot be created; `PUT` is not routed to the platform at
 * all; and no answer or `estUrl` exposes the platform's internal `/api/v1/protocols` path.
 *
 * WHY: the label is the only thing that picks the authentication policy and the issuing RA
 * Profile, so a wrong or fallback route would enroll a client under someone else's rules.
 *
 * HOW: the RA Profile of each issued certificate is read from the inventory. Every EST answer the
 * spec receives is kept and scanned at the end.
 */

import { APIRequestContext, expect, test } from '@playwright/test';
import * as crypto from 'crypto';
import { loadEstEnv, EstEnv } from '../../utils/estEnv';
import { EstResponse, estRequest } from '../../utils/estHttp';
import { newEstAdminContext, getRaProfileName } from '../../utils/estAdminApi';
import {
  activateEstOnRaProfile,
  cleanupEstProfile,
  createEstProfile,
  estProfileName,
  EstProfile,
} from '../../utils/estProfileUtils';
import { createBasicSecret, createRaProfile, deleteRaProfile, deleteSecret } from '../../utils/estFixtures';
import {
  cleanupEnrolledCertificates,
  enrolledCertificate,
  EST_REFUSAL,
  getInventoryCertificate,
  simpleEnroll,
} from '../../utils/estEnroll';
import { attemptCleanup } from '../../utils/cleanupLedger';
import { createCsr, Csr } from '../../utils/estPki';

type Credentials = { username: string; password: string };

test.describe('@est routing', () => {
  let env: EstEnv;
  let api: APIRequestContext;
  let labelRaProfileName: string;
  const secrets: Array<{ uuid: string; name: string }> = [];
  const profiles: EstProfile[] = [];
  let defaultProfile: EstProfile;
  let directProfile: EstProfile;
  let defaultCredentials: Credentials;
  let directCredentials: Credentials;
  let activated = false;
  const issued: Buffer[] = [];
  const answers: EstResponse[] = [];

  async function newRaBasicProfile(suffix: string, systemDefault: boolean): Promise<[EstProfile, Credentials]> {
    const credentials = { username: `est-e2e-${suffix}`, password: crypto.randomBytes(16).toString('hex') };
    const secret = await createBasicSecret(api, env, { name: estProfileName(`${suffix}-secret`), ...credentials });
    secrets.push(secret);
    const profile = await createEstProfile(api, {
      name: estProfileName(suffix),
      raProfileUuid: env.raProfileUuid,
      authenticationPolicy: 'raBasic',
      systemDefault,
      basicCredentialSecretUuids: [secret.uuid],
    });
    profiles.push(profile);
    return [profile, credentials];
  }

  async function cleanup(): Promise<void> {
    await cleanupEnrolledCertificates(api, issued);
    for (const profile of profiles) {
      const activation =
        profile === directProfile && activated
          ? { authorityUuid: env.authorityUuid, raProfileUuid: env.labelRaProfileUuid }
          : undefined;
      await cleanupEstProfile(api, profile, activation);
    }
    for (const secret of secrets) {
      await attemptCleanup({ resource: 'secret', uuid: secret.uuid, name: secret.name }, () => deleteSecret(api, secret.uuid));
    }
  }

  async function enroll(label: string | undefined, credentials: Credentials, csr?: Csr): Promise<EstResponse> {
    const resp = await simpleEnroll({
      baseUrl: env.baseUrl,
      label,
      basicAuth: credentials,
      csr: csr ?? createCsr({ subject: `est-e2e-routing-${crypto.randomBytes(4).toString('hex')}` }),
    });
    answers.push(resp);
    if (resp.status === 200) issued.push(enrolledCertificate(resp));
    return resp;
  }

  async function raProfileOf(resp: EstResponse): Promise<string | undefined> {
    return (await getInventoryCertificate(api, enrolledCertificate(resp))).raProfileName;
  }

  test.beforeAll(async () => {
    env = loadEstEnv();
    api = await newEstAdminContext(env);
    try {
      labelRaProfileName = await getRaProfileName(api, env.labelRaProfileUuid);
      [defaultProfile, defaultCredentials] = await newRaBasicProfile('routing-default', true);
      [directProfile, directCredentials] = await newRaBasicProfile('routing-direct', false);
      await activateEstOnRaProfile(api, {
        authorityUuid: env.authorityUuid,
        raProfileUuid: env.labelRaProfileUuid,
        estProfileUuid: directProfile.uuid,
      });
      activated = true;
    } catch (error) {
      await cleanup();
      await api.dispose();
      throw error;
    }
  });

  test.afterAll(async () => {
    if (!api) return;
    await cleanup();
    await api.dispose();
  });

  test('EST-010 a request without a label is served by the system default EST Profile', async () => {
    const resp = await enroll(undefined, defaultCredentials);
    expect(resp.status).toBe(200);
    expect(await raProfileOf(resp)).toBe(await getRaProfileName(api, env.raProfileUuid));

    const other = await enroll(undefined, directCredentials);
    expect(other.status).toBe(401);
    expect(other.headers['www-authenticate']).toBe('Basic realm="est"');
  });

  test('EST-011 /<EST Profile>/ is served by that profile on its default RA Profile', async () => {
    const resp = await enroll(directProfile.name, directCredentials);
    expect(resp.status).toBe(200);
    expect(await raProfileOf(resp)).toBe(await getRaProfileName(api, env.raProfileUuid));

    const other = await enroll(directProfile.name, defaultCredentials);
    expect(other.status).toBe(401);
    expect(other.headers['www-authenticate']).toBe(`Basic realm="${directProfile.name}"`);
  });

  test('EST-012 /<RA Profile>/ is served by the EST Profile activated on it, issuing on that RA Profile', async () => {
    const resp = await enroll(labelRaProfileName, directCredentials);
    expect(resp.status).toBe(200);
    expect(await raProfileOf(resp)).toBe(labelRaProfileName);

    expect((await enroll(labelRaProfileName, defaultCredentials)).status).toBe(401);
  });

  test('EST-013 an unknown label answers 404 and never falls back to the system default', async () => {
    const label = `est-e2e-unknown-${crypto.randomBytes(4).toString('hex')}`;
    const cacerts = await estRequest({ baseUrl: env.baseUrl, label, op: 'cacerts' });
    answers.push(cacerts);
    expect(cacerts.status).toBe(404);
    expect(cacerts.headers['content-type']).toContain('text/plain');
    expect(cacerts.body.toString('utf8')).toBe(EST_REFUSAL.notFound);

    const enrollment = await enroll(label, defaultCredentials);
    expect(enrollment.status).toBe(404);
  });

  test('EST-014 a label cannot belong to an EST Profile and an RA Profile at once', async () => {
    // An RA Profile named like an EST Profile cannot have EST activated.
    const clash = await createRaProfile(api, env, directProfile.name);
    try {
      const activation = await api.patch(
        `/api/v1/authorities/${env.authorityUuid}/raProfiles/${clash.uuid}/protocols/est/activate/${defaultProfile.uuid}`,
        { data: { issueCertificateAttributes: [] } },
      );
      expect([400, 409, 422]).toContain(activation.status());
    } finally {
      await attemptCleanup({ resource: 'raProfile', uuid: clash.uuid, name: directProfile.name }, () =>
        deleteRaProfile(api, env, clash.uuid),
      );
    }

    // An EST Profile cannot take the name of an RA Profile with EST activated.
    const create = await api.post('/api/v1/estProfiles', {
      data: {
        name: labelRaProfileName,
        raProfileUuid: env.raProfileUuid,
        authenticationPolicy: 'raBasic',
        serverKeyGeneration: false,
        renewalThreshold: 30,
        customAttributes: [],
      },
    });
    if (create.ok()) {
      const { uuid } = (await create.json()) as { uuid: string };
      profiles.push({ uuid, name: labelRaProfileName, estUrl: '' });
    }
    expect([400, 409, 422]).toContain(create.status());

    // Both labels still resolve to their single holder.
    const direct = await estRequest({ baseUrl: env.baseUrl, label: directProfile.name, op: 'cacerts' });
    const viaRaProfile = await estRequest({ baseUrl: env.baseUrl, label: labelRaProfileName, op: 'cacerts' });
    answers.push(direct, viaRaProfile);
    expect(direct.status).toBe(200);
    expect(viaRaProfile.status).toBe(200);
  });

  test('EST-015 PUT is not routed to the platform', async () => {
    const resp = await estRequest({
      baseUrl: env.baseUrl,
      label: directProfile.name,
      op: 'simpleenroll',
      method: 'PUT',
      contentType: 'application/pkcs10',
      body: 'x',
    });
    answers.push(resp);
    expect(resp.status).toBe(404);
    expect(JSON.parse(resp.body.toString('utf8')).message).toBe('no Route matched with those values');
  });

  test('EST-016 no answer and no estUrl exposes the internal protocol path', async () => {
    expect(answers.length).toBeGreaterThan(0);
    for (const resp of answers) {
      expect(JSON.stringify(resp.headers)).not.toContain('/api/v1/protocols');
      expect(resp.body.toString('latin1')).not.toContain('/api/v1/protocols');
    }
    for (const profile of [defaultProfile, directProfile]) {
      expect(profile.estUrl).not.toContain('/api/');
      expect(profile.estUrl).toMatch(new RegExp(`^https://[^/]+/\\.well-known/est/${profile.name}$`));
    }
  });
});
