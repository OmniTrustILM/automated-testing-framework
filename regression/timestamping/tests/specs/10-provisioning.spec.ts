import { CertificateDetail, SigningProfileDetail } from '../utils/adminApi';
import { TsaSet } from '../utils/env';
import { expect, test } from '../utils/fixtures';

/**
 * Everything the TSP request path depends on, verified through the API rather than trusted
 * because the provisioning script exited zero. A half-provisioned platform otherwise fails
 * much later as an opaque in-band rejection.
 */
test.describe('provisioning', () => {
  const sets: Array<[string, (set: { nonQualified: TsaSet; qualified: TsaSet }) => TsaSet]> = [
    ['non-qualified', (all) => all.nonQualified],
    ['qualified', (all) => all.qualified],
  ];

  for (const [label, pick] of sets) {
    test(`the ${label} signing profile is enabled, timestamping, and bound to its certificate`, async ({ admin, env }) => {
      const set = pick(env.sets);
      const profile = await admin.getSigningProfile(set.signingProfile.uuid);

      expect(profile.name, 'signing profile name').toBe(set.signingProfile.name);
      expect(profile.enabled, `signing profile '${set.signingProfile.name}' is enabled`).toBe(true);

      const workflow = (profile as SigningProfileDetail).workflow as Record<string, unknown> | undefined;
      expect(workflow, 'signing profile carries a workflow').toBeDefined();
      expect(workflow!.type, 'workflow type').toBe('timestamping');
      expect(workflow!.defaultPolicyId, 'default policy OID').toBe(set.policyOid);
      // Strict equality on purpose: Boolean(undefined) would let a missing field satisfy the
      // non-qualified case and hide a dropped flag.
      expect(workflow!.qualifiedTimestamp, 'qualifiedTimestamp flag').toBe(set.qualified);

      const certificate = profile.signingScheme?.certificate;
      expect(certificate?.uuid, 'signing certificate bound to the profile').toBe(set.certificate.uuid);

      const protocols = (profile.enabledProtocols ?? []) as string[];
      expect(protocols, `TSP is enabled on '${set.signingProfile.name}'`).toContain('tsp');
    });

    test(`the ${label} TSP profile is enabled and linked back to its signing profile`, async ({ admin, env }) => {
      const set = pick(env.sets);
      const tspProfile = await admin.getTspProfile(set.tspProfile.uuid);

      expect(tspProfile.name, 'TSP profile name').toBe(set.tspProfile.name);
      expect(tspProfile.enabled, `TSP profile '${set.tspProfile.name}' is enabled`).toBe(true);

      const linked = (tspProfile.defaultSigningProfile ?? tspProfile.signingProfile) as
        | { uuid?: string; name?: string }
        | undefined;
      expect(linked?.uuid, 'TSP profile points at the signing profile').toBe(set.signingProfile.uuid);
    });

    test(`the ${label} TSA certificate validates against a trusted chain`, async ({ admin, env }) => {
      const set = pick(env.sets);
      const certificate: CertificateDetail = await admin.getCertificate(set.certificate.uuid);

      expect(certificate.commonName, 'certificate common name').toBe(set.certificate.commonName);
      // An empty issuerCertificateUuid is the root cause behind
      // "Certificate is not eligible for signing workflow type TIMESTAMPING".
      expect(certificate.issuerCertificateUuid, 'issuer is linked in the platform').toBeTruthy();
      expect(['valid', 'expiring'], `validation status (${certificate.validationStatus})`).toContain(
        certificate.validationStatus,
      );

      const chain = await admin.get<{ completeChain: boolean; certificates: CertificateDetail[] }>(
        `/v1/certificates/${set.certificate.uuid}/chain?withEndCertificate=false`,
      );
      expect(chain.completeChain, 'issuer chain is complete').toBe(true);
      expect(chain.certificates.length, 'issuer chain is present').toBeGreaterThan(0);
      expect(chain.certificates.some((issuer) => issuer.trustedCa), 'a trusted CA anchors the chain').toBe(true);
    });
  }

  test('the qualified profile is the only one wired to a time-quality configuration', async ({ admin, env }) => {
    const qualified = await admin.getSigningProfile(env.sets.qualified.signingProfile.uuid);
    const nonQualified = await admin.getSigningProfile(env.sets.nonQualified.signingProfile.uuid);

    const qualifiedWorkflow = qualified.workflow as Record<string, { uuid?: string; name?: string } | undefined>;
    const nonQualifiedWorkflow = nonQualified.workflow as Record<string, unknown>;

    expect(qualifiedWorkflow.timeQualityConfiguration?.uuid, 'qualified profile time-quality configuration').toBe(
      env.timeQuality.uuid,
    );
    expect(nonQualifiedWorkflow.timeQualityConfiguration ?? null, 'non-qualified profile has none').toBeNull();
  });

  test('the time-quality configuration matches what was provisioned', async ({ admin, env }) => {
    const configuration = await admin.get<{ uuid: string; name: string; accuracy: string }>(
      `/v1/timeQualityConfigurations/${env.timeQuality.uuid}`,
    );
    expect(configuration.name, 'time-quality configuration name').toBe(env.timeQuality.name);
    expect(configuration.accuracy, 'configured accuracy').toBe(env.timeQuality.accuracy);
  });

  test('the mapped user holds the timestamping role', async ({ admin, env }) => {
    const user = await admin.get<{ username: string; roles?: Array<{ uuid: string; name: string }> }>(
      `/v1/users/${env.mappedUser.uuid}`,
    );
    expect(user.username, 'mapped user').toBe(env.mappedUser.username);
    const roleUuids = (user.roles ?? []).map((role) => role.uuid);
    expect(roleUuids, `user '${env.mappedUser.username}' has role '${env.role.name}'`).toContain(env.role.uuid);
  });

  test('the timestamping role grants the timestamp action on both TSP profiles', async ({ admin, env }) => {
    const permissions = await admin.get<{
      resources?: Array<{
        name: string;
        allowAllActions?: boolean;
        actions?: string[];
        objects?: Array<{ uuid: string; allow?: string[] }>;
      }>;
    }>(`/v1/roles/${env.role.uuid}/permissions`);

    const tspResource = (permissions.resources ?? []).find((resource) => resource.name === 'tspProfiles');
    expect(tspResource, 'role carries a tspProfiles permission').toBeDefined();

    const grantedUuids = (tspResource!.objects ?? [])
      .filter((object) => (object.allow ?? []).includes('timestamp'))
      .map((object) => object.uuid);
    const allowsEverything = tspResource!.allowAllActions === true || (tspResource!.actions ?? []).includes('timestamp');

    for (const set of [env.sets.nonQualified, env.sets.qualified]) {
      expect(
        allowsEverything || grantedUuids.includes(set.tspProfile.uuid),
        `role grants 'timestamp' on TSP profile '${set.tspProfile.name}'`,
      ).toBe(true);
    }
  });
});
