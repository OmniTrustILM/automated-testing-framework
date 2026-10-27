import { recordCreated } from '../../utils/regression/ledger/ledger';
import { runName } from '../../utils/regression/ledger/runState';
import { plannedFamilies, timestampingConfig } from '../../utils/timestamping/config';
import { AdminApi, AttributeDefinition, attributeValues } from '../../utils/timestamping/adminApi';
import { expect, test } from '../../utils/timestamping/fixtures';
import { certificateKeyAlgorithm, tokenSignature } from '../../utils/timestamping/openssl';
import { familyOrSkip, ledgerSpec, plannedSets, provisionedFamilies, Provisioning, RSA, setOrSkip, SOFTWARE_V1, TsaFamily } from '../../utils/timestamping/provisioning';
import { expectedSignature, postQuantumOffer, signatureField, V2_OFFER } from '../../utils/timestamping/signatureOptions';
import { devTests } from '../../utils/timestamping/tags';
import { describeOutcome, requestTimestamp } from '../../utils/timestamping/tsp';

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

/** Tries a signing profile on the family's non-qualified certificate; records and deletes it if Core creates one. */
async function attemptSigningProfile(
  admin: AdminApi,
  env: Provisioning,
  ledgerSpecName: string,
  family: TsaFamily,
  definitions: AttributeDefinition[],
  values: Record<string, string>,
): Promise<Attempt> {
  const connector = env.connectors.timestampFormatting.uuid;
  const formatting = await admin.get<Array<{ version: number }>>(
    `/v1/signingProfiles/signatureFormattingConnectors/${connector}/formattingAttributes`,
  );
  // A run-prefixed name, recorded right after an (unexpected) successful create, so the teardown removes it.
  const name = runName(`signature-options-${Date.now().toString(36)}`);
  const response = await admin.raw('POST', '/v1/signingProfiles', {
    name,
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
    recordCreated('signingProfiles', { uuid, name }, { spec: ledgerSpecName, note: 'accepted although a refusal was expected' });
    const deleted = await admin.raw('DELETE', `/v1/signingProfiles/${uuid}`);
    expect(deleted.status(), `deleting the signing profile ${uuid} this test created`).toBe(204);
  }
  return attempt;
}

/**
 * A signing profile takes its signature scheme and digest from what its certificate's key
 * offers, and its tokens have to be signed exactly that way.
 */
test.describe('signature options', devTests(), () => {
  // The v1 API offers a digest list of its own, MD5 and SHA-1 among it, so the offer and the
  // refusals are checked on v2 providers. The plan has one provider for every family (TSA_CRYPTO_PROVIDER).
  const v2Families = timestampingConfig().cryptoProvider === SOFTWARE_V1 ? [] : plannedFamilies();

  for (const planned of v2Families) {
    test(`the ${planned.label} certificates offer the signature options of their key algorithm`, devTests(), async ({ admin }) => {
      const family = familyOrSkip(planned);
      for (const set of [family.nonQualified, family.qualified]) {
        const offer = attributeValues(await admin.signatureAttributes(set.certificate.uuid));
        const label = `options offered for '${set.certificate.commonName}'`;
        const expected = V2_OFFER[family.keyAlgorithm];
        if (expected) {
          expect(offer, label).toEqual(expected);
        } else {
          expect(Object.keys(offer), label).toEqual(['signatureAlgorithm']);
          expect(offer.signatureAlgorithm, label).toHaveLength(1);
          expect(offer.signatureAlgorithm[0], label).toMatch(postQuantumOffer(family.keyAlgorithm));
        }
      }
    });
  }

  for (const { label, family, qualified } of plannedSets()) {
    test(`the ${label} token is signed the way its profile and key call for`, devTests(), async ({ admin, tsp }) => {
      const set = setOrSkip(family, qualified);
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

  for (const planned of v2Families.filter((candidate) => candidate.keyAlgorithm === RSA)) {
    for (const [field, value] of REFUSED_ON_RSA) {
      test(`the ${planned.label} certificate refuses ${field} ${value}`, devTests(), async ({ admin, ts }, testInfo) => {
        const family = familyOrSkip(planned);
        const offer = await admin.signatureAttributes(family.nonQualified.certificate.uuid);
        const attempt = await attemptSigningProfile(admin, ts, ledgerSpec(testInfo), family, offer, {
          data_rsaSigScheme: 'PKCS1-v1_5',
          data_sigDigest: 'SHA-384',
          [field]: value,
        });
        expect(attempt.status, attempt.body).toBe(422);
        expect(attempt.body, 'the refusal names the combination as unknown').toContain(
          'do not match a known RSA or ECDSA field combination',
        );
      });
    }
  }

  for (const plannedOther of v2Families.filter((candidate) => candidate.keyAlgorithm !== RSA)) {
    if (!v2Families.some((candidate) => candidate.keyAlgorithm === RSA)) continue;

    test(`RSA's PSS scheme is refused on the ${plannedOther.label} certificate`, devTests(), async ({ admin, ts }, testInfo) => {
      const family = familyOrSkip(plannedOther);
      // As in the source: the RSA family on the SAME connector (another connector's RSA offer proves nothing here).
      const rsa = provisionedFamilies().find(
        (candidate) => candidate.keyAlgorithm === RSA && candidate.connector.uuid === family.connector.uuid,
      );
      test.skip(!rsa, 'no provisioned RSA family on the same connector');
      if (!rsa) return;
      const own = await admin.signatureAttributes(family.nonQualified.certificate.uuid);
      const rsaOffer = await admin.signatureAttributes(rsa.nonQualified.certificate.uuid);
      const attempt = await attemptSigningProfile(admin, ts, ledgerSpec(testInfo), family, [...own, ...rsaOffer], {
        data_rsaSigScheme: 'PSS',
        data_sigDigest: 'SHA-512',
      });
      expect(attempt.status, attempt.body).toBe(422);
      expect(attempt.body, 'the refusal names the key').toContain('not supported by the key');
    });
  }
});
