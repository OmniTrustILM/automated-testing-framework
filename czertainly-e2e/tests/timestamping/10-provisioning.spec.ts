import { plannedFamilies } from '../../utils/timestamping/config';
import { describeLocalOnly } from '../../utils/regression/tier/localProof';
import { CertificateDetail, SigningProfileDetail } from '../../utils/timestamping/adminApi';
import { expect, test } from '../../utils/timestamping/fixtures';
import { familyOrSkip, plannedSets, setOrSkip } from '../../utils/timestamping/provisioning';
import { devTests } from '../../utils/timestamping/tags';

describeLocalOnly(test);

/**
 * Everything the TSP request path depends on, verified through the API rather than trusted
 * because the provisioning script exited zero. A half-provisioned platform otherwise fails
 * much later as an opaque in-band rejection.
 */
test.describe('provisioning', devTests(), () => {
  for (const { label, family, qualified } of plannedSets()) {
    test(`the ${label} signing profile is enabled, timestamping, and bound to its certificate`, devTests(), async ({ admin }) => {
      const set = setOrSkip(family, qualified);
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

    test(`the ${label} TSP profile is enabled and linked back to its signing profile`, devTests(), async ({ admin }) => {
      const set = setOrSkip(family, qualified);
      const tspProfile = await admin.getTspProfile(set.tspProfile.uuid);

      expect(tspProfile.name, 'TSP profile name').toBe(set.tspProfile.name);
      expect(tspProfile.enabled, `TSP profile '${set.tspProfile.name}' is enabled`).toBe(true);

      const linked = (tspProfile.defaultSigningProfile ?? tspProfile.signingProfile) as
        | { uuid?: string; name?: string }
        | undefined;
      expect(linked?.uuid, 'TSP profile points at the signing profile').toBe(set.signingProfile.uuid);
    });

    test(`the ${label} TSA certificate validates against a trusted chain`, devTests(), async ({ admin }) => {
      const set = setOrSkip(family, qualified);
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

  for (const planned of plannedFamilies()) {
    test(`the ${planned.label} qualified profile is the one wired to a time-quality configuration`, devTests(), async ({ admin, ts }) => {
      const family = familyOrSkip(planned);
      const qualified = await admin.getSigningProfile(family.qualified.signingProfile.uuid);
      const nonQualified = await admin.getSigningProfile(family.nonQualified.signingProfile.uuid);

      const qualifiedWorkflow = qualified.workflow as Record<string, { uuid?: string; name?: string } | undefined>;
      const nonQualifiedWorkflow = nonQualified.workflow as Record<string, unknown>;

      expect(qualifiedWorkflow.timeQualityConfiguration?.uuid, 'qualified profile time-quality configuration').toBe(
        ts.timeQuality.uuid,
      );
      expect(nonQualifiedWorkflow.timeQualityConfiguration ?? null, 'non-qualified profile has none').toBeNull();
    });
  }

  // A re-run under pinned names must find every object again; with per-run provisioning there is no previous summary.
  const NO_PREVIOUS = 'per-run provisioning: there is no previous summary to compare';

  test('re-provisioning reused every shared object', devTests(), async () => {
    test.skip(true, NO_PREVIOUS);
  });

  for (const planned of plannedFamilies()) {
    test(`re-provisioning reused every object of the ${planned.label} family`, devTests(), async () => {
      test.skip(true, NO_PREVIOUS);
    });
  }

  test('the time-quality configuration matches what was provisioned', devTests(), async ({ admin, ts }) => {
    const configuration = await admin.get<{ uuid: string; name: string; accuracy: string }>(
      `/v1/timeQualityConfigurations/${ts.timeQuality.uuid}`,
    );
    expect(configuration.name, 'time-quality configuration name').toBe(ts.timeQuality.name);
    expect(configuration.accuracy, 'configured accuracy').toBe(ts.timeQuality.accuracy);
  });

  test('the mapped user holds the timestamping role', devTests(), async ({ admin, ts }) => {
    const user = await admin.get<{ username: string; roles?: Array<{ uuid: string; name: string }> }>(
      `/v1/users/${ts.mappedUser.uuid}`,
    );
    expect(user.username, 'mapped user').toBe(ts.mappedUser.username);
    const roleUuids = (user.roles ?? []).map((role) => role.uuid);
    expect(roleUuids, `user '${ts.mappedUser.username}' has role '${ts.role.name}'`).toContain(ts.role.uuid);
  });

  test('the timestamping role grants the timestamp action on every TSP profile', devTests(), async ({ admin, ts }) => {
    const permissions = await admin.get<{
      resources?: Array<{
        name: string;
        allowAllActions?: boolean;
        actions?: string[];
        objects?: Array<{ uuid: string; allow?: string[] }>;
      }>;
    }>(`/v1/roles/${ts.role.uuid}/permissions`);

    const tspResource = (permissions.resources ?? []).find((resource) => resource.name === 'tspProfiles');
    expect(tspResource, 'role carries a tspProfiles permission').toBeDefined();

    const grantedUuids = (tspResource!.objects ?? [])
      .filter((object) => (object.allow ?? []).includes('timestamp'))
      .map((object) => object.uuid);
    const allowsEverything = tspResource!.allowAllActions === true || (tspResource!.actions ?? []).includes('timestamp');

    for (const { label, family, qualified } of plannedSets()) {
      if (!ts.sets[family.name]) continue; // a family the setup could not provision has its own skipped tests above
      const set = setOrSkip(family, qualified);
      expect(
        allowsEverything || grantedUuids.includes(set.tspProfile.uuid),
        `role grants 'timestamp' on the ${label} TSP profile '${set.tspProfile.name}'`,
      ).toBe(true);
    }
  });
});
