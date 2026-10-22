import { KeyDetail, OnboardingResult } from '../utils/adminApi';
import { requestAttribute } from '../utils/attributes';
import { expect, keyPairMetaOf, labelled, test } from '../utils/fixtures';
import { signThroughCore, verifiesWithRecordedPublicKey } from '../utils/signing';

const COST_CENTER = { attribute: 'key-onboarding-cost-center', value: 'Payments' };

test.describe.serial('Onboarding key pairs from a token', () => {
  let results: OnboardingResult[];
  let chosenEcName: string;

  test('onboards the selected pairs under their names and refuses a pair without a public key', async ({ admin, provisioned }) => {
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);
    const costCenter = await admin.keyCustomAttribute(COST_CENTER.attribute);
    chosenEcName = `Edge signer ${provisioned.planted.ec}`;

    results = (
      await admin.onboardTokenKeys(
        provisioned.token.uuid,
        provisioned.tokenProfile.uuid,
        [
          { keyPairMeta: keyPairMetaOf(keys, provisioned.planted.rsa) },
          { keyPairMeta: keyPairMetaOf(keys, provisioned.planted.ec), name: chosenEcName },
          { keyPairMeta: keyPairMetaOf(keys, provisioned.planted.orphan) },
        ],
        [requestAttribute(costCenter, [{ data: COST_CENTER.value }])],
      )
    ).results;

    expect(results.map((result) => result.onboarded)).toEqual([true, true, false]);
    expect(results.map((result) => result.intoExistingKey)).toEqual([false, false, false]);
    expect(results[0].keyName).toBe(provisioned.planted.rsa);
    expect(results[1].keyName).toBe(chosenEcName);
    expect(results[2].reason).toContain('no public key');
  });

  test('records an onboarded key as disabled, not exportable and with the custom attributes sent', async ({ admin, provisioned }) => {
    const key = await admin.get<KeyDetail>(`/v1/keys/${results[0].keyUuid}`);

    expect(key.tokenProfileUuid).toBe(provisioned.tokenProfile.uuid);
    expect(key.items).toHaveLength(2);
    for (const item of key.items) {
      expect(item).toMatchObject({ state: 'active', enabled: false, exportable: false });
    }
    const costCenter = key.customAttributes?.find((attribute) => attribute.name === COST_CENTER.attribute);
    expect(costCenter?.content?.map((content) => content.data)).toEqual([COST_CENTER.value]);
  });

  for (const [label, resultIndex] of [
    ['an RSA key under a SHA-1 sized ID', 0],
    ['an EC key under a short ID', 1],
  ] as const) {
    test(`signs through Core with ${label} once it is enabled`, async ({ admin, provisioned }) => {
      await admin.enableKey(results[resultIndex].keyUuid ?? '');
      const key = await admin.get<KeyDetail>(`/v1/keys/${results[resultIndex].keyUuid}`);
      const data = Buffer.from(`signed by ${key.name}`);

      const signature = await signThroughCore(admin, provisioned, key, data);

      expect(verifiesWithRecordedPublicKey(key, data, signature)).toBe(true);
    });
  }

  test('lists the onboarded pairs as held by their keys and refuses to onboard one again', async ({ admin, provisioned }) => {
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);
    const rsa = labelled(keys, provisioned.planted.rsa);

    const again = (
      await admin.onboardTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid, [
        { keyPairMeta: keyPairMetaOf(keys, provisioned.planted.rsa) },
      ])
    ).results[0];

    expect(rsa).toMatchObject({ status: 'inInventory', inventoryKeyUuid: results[0].keyUuid });
    expect(labelled(keys, provisioned.planted.ec)).toMatchObject({ status: 'inInventory', inventoryKeyName: chosenEcName });
    expect(again).toMatchObject({ onboarded: false, keyUuid: results[0].keyUuid });
    expect(again.reason).toContain(provisioned.planted.rsa);
  });

  test('refuses the metadata of a listed pair stripped of its content', async ({ admin, provisioned }) => {
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);
    const stripped = keyPairMetaOf(keys, provisioned.planted.rsa).map((attribute) => ({ ...attribute, content: undefined }));

    const response = await admin.raw(
      'POST',
      `/v1/tokens/${provisioned.token.uuid}/tokenProfiles/${provisioned.tokenProfile.uuid}/tokenKeys/onboard`,
      { keys: [{ keyPairMeta: stripped }] },
    );

    expect(response.status()).toBe(422);
    expect(await response.text()).toContain('content is required');
  });
});
