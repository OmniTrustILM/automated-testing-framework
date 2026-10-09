import { AdminApi, AttributeDefinition, attributeValues } from '../utils/adminApi';
import { Provisioning, provisionedFamilies, provisionedSets, RSA, SOFTWARE_V1, TsaFamily } from '../utils/env';
import { expect, test } from '../utils/fixtures';
import { certificateKeyAlgorithm, tokenSignature } from '../utils/openssl';
import { expectedSignature, signatureField, V2_OFFER } from '../utils/signatureOptions';
import { describeOutcome, requestTimestamp } from '../utils/tsp';

/** Values outside the v2 offer, which Core must refuse rather than store. */
const REFUSED_ON_RSA: Array<[string, string]> = [
  ['data_sigDigest', 'SHA-1'],
  ['data_sigDigest', 'RAW'],
  ['data_rsaSigScheme', 'RAW'],
];

interface Attempt {
  status: number;
  body: string;
}

/** Tries a signing profile on the family's non-qualified certificate and deletes it if Core creates one. */
async function attemptSigningProfile(
  admin: AdminApi,
  env: Provisioning,
  family: TsaFamily,
  definitions: AttributeDefinition[],
  values: Record<string, string>,
): Promise<Attempt> {
  const connector = env.connectors.timestampFormatting.uuid;
  const formatting = await admin.get<Array<{ version: number }>>(
    `/v1/signingProfiles/signatureFormattingConnectors/${connector}/formattingAttributes`,
  );
  const response = await admin.raw('POST', '/v1/signingProfiles', {
    name: `regression-signature-options-${Date.now()}`,
    workflow: {
      type: 'timestamping',
      signatureFormattingConnectorUuid: connector,
      // The definitions carry each attribute's default, which is what the setup script sends too.
      signatureFormattingConnectorAttributes: formatting.map((attribute) => ({
        ...attribute,
        version: `v${attribute.version}`,
      })),
      qualifiedTimestamp: false,
      defaultPolicyId: family.nonQualified.policyOid,
      allowedPolicyIds: [],
      allowedDigestAlgorithms: [],
    },
    signingScheme: {
      signingScheme: 'managed',
      managedSigningType: 'static_key',
      certificateUuid: family.nonQualified.certificate.uuid,
      signingOperationAttributes: Object.entries(values).map(([name, value]) =>
        signatureField(definitions, name, value),
      ),
    },
    customAttributes: [],
  });

  const attempt: Attempt = { status: response.status(), body: await response.text() };
  const uuid = response.ok() ? (JSON.parse(attempt.body) as { uuid?: string }).uuid : undefined;
  if (uuid) {
    const deleted = await admin.raw('DELETE', `/v1/signingProfiles/${uuid}`);
    expect(deleted.status(), `deleting the signing profile ${uuid} this test created`).toBe(204);
  }
  return attempt;
}

/**
 * A signing profile takes its signature scheme and digest from what its certificate's key
 * offers, and its tokens have to be signed exactly that way.
 */
test.describe('signature options', () => {
  // The v1 API offers a digest list of its own, MD5 and SHA-1 among it, so the offer and the
  // refusals are checked on v2 providers.
  const v2Families = provisionedFamilies().filter((family) => family.cryptoProvider !== SOFTWARE_V1);

  for (const family of v2Families) {
    test(`the ${family.label} certificates offer the signature options of their key algorithm`, async ({ admin }) => {
      for (const set of [family.nonQualified, family.qualified]) {
        const offer = await admin.signatureAttributes(set.certificate.uuid);
        expect(attributeValues(offer), `options offered for '${set.certificate.commonName}'`).toEqual(
          V2_OFFER[family.keyAlgorithm] ?? {},
        );
      }
    });
  }

  for (const { label, set } of provisionedSets()) {
    test(`the ${label} token is signed the way its profile and key call for`, async ({ admin, tsp }) => {
      const outcome = await requestTimestamp(tsp, {
        label: `signature-${label}`,
        profileName: set.signingProfile.name,
      });
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);

      const profile = await admin.getSigningProfile(set.signingProfile.uuid);
      const options = attributeValues(profile.signingScheme?.signingOperationAttributes ?? []);
      const certificate = await admin.getCertificate(set.certificate.uuid);
      const keyOid = certificateKeyAlgorithm(certificate.certificateContent);
      const expected = expectedSignature(set.keyAlgorithm, options, keyOid);
      expect(
        tokenSignature(outcome.responsePath!),
        `signature of a ${set.keyAlgorithm} token whose profile states ${JSON.stringify(options)}`,
      ).toEqual(expected);
    });
  }

  for (const family of v2Families.filter((candidate) => candidate.keyAlgorithm === RSA)) {
    for (const [field, value] of REFUSED_ON_RSA) {
      test(`the ${family.label} certificate refuses ${field} ${value}`, async ({ admin, env }) => {
        const offer = await admin.signatureAttributes(family.nonQualified.certificate.uuid);
        const attempt = await attemptSigningProfile(admin, env, family, offer, {
          data_rsaSigScheme: 'PKCS1-v1_5',
          data_sigDigest: 'SHA-384',
          [field]: value,
        });
        expect(attempt.status, attempt.body).toBe(422);
        expect(attempt.body, 'the refusal names the field').toContain(`Name=${field}`);
      });
    }
  }

  for (const family of v2Families.filter((candidate) => candidate.keyAlgorithm !== RSA)) {
    const rsa = v2Families.find(
      (candidate) => candidate.keyAlgorithm === RSA && candidate.connector.uuid === family.connector.uuid,
    );
    if (!rsa) continue;

    test(`RSA's PSS scheme is refused on the ${family.label} certificate`, async ({ admin, env }) => {
      const own = await admin.signatureAttributes(family.nonQualified.certificate.uuid);
      const rsaOffer = await admin.signatureAttributes(rsa.nonQualified.certificate.uuid);
      const attempt = await attemptSigningProfile(admin, env, family, [...own, ...rsaOffer], {
        data_rsaSigScheme: 'PSS',
        data_sigDigest: 'SHA-512',
      });
      expect(attempt.status, attempt.body).toBe(422);
      expect(attempt.body, 'the refusal names the key').toContain('not supported by the key');
    });
  }
});
