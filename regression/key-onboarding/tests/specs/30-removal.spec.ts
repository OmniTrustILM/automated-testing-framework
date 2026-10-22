import { KeyDetail, TokenKey } from '../utils/adminApi';
import { expect, identityOf, keyPairMetaOf, labelled, test } from '../utils/fixtures';

test.describe.serial('Removing an onboarded key from the inventory', () => {
  let keyUuid: string;

  test('removes the key from the inventory and leaves the pair on the token', async ({ admin, provisioned }) => {
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);
    const [onboarded] = (
      await admin.onboardTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid, [
        { keyPairMeta: keyPairMetaOf(keys, provisioned.planted.removable) },
      ])
    ).results;
    expect(onboarded.onboarded).toBe(true);
    keyUuid = onboarded.keyUuid ?? '';

    const removal = await admin.removeKeyFromInventory(keyUuid);

    expect(removal.status()).toBe(204);
    expect((await admin.raw('GET', `/v1/keys/${keyUuid}`)).status()).toBe(404);
    const relisted = labelled(await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid), provisioned.planted.removable);
    expect(relisted.status).toBe('onboardable');
  });

  test('onboards the removed pair again', async ({ admin, provisioned }) => {
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);

    const [again] = (
      await admin.onboardTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid, [
        { keyPairMeta: keyPairMetaOf(keys, provisioned.planted.removable) },
      ])
    ).results;

    expect(again.onboarded).toBe(true);
    expect(again.keyUuid).toBeDefined();
    expect(again.keyUuid).not.toBe(keyUuid);
    const key = await admin.get<KeyDetail>(`/v1/keys/${again.keyUuid}`);
    expect(key.tokenProfileUuid).toBe(provisioned.tokenProfile.uuid);
    expect(key.items).toHaveLength(2);
  });
});

/** The pair a key holds, found by the key the listing names for it. */
function heldBy(keys: TokenKey[], keyUuid: string): TokenKey {
  const found = keys.find((key) => key.inventoryKeyUuid === keyUuid);
  if (!found) {
    throw new Error(`The token lists no key pair held by key ${keyUuid}`);
  }
  return found;
}

test.describe.serial('Removing keys from the inventory in bulk', () => {
  let createdKey: KeyDetail;
  let createdPair: string | undefined;
  let onboardedUuids: string[];
  let compromisedUuid: string;

  test.beforeAll(async ({ admin, provisioned }) => {
    const { token, tokenProfile, planted } = provisioned;
    createdKey = await admin.createKeyPair(token.uuid, tokenProfile.uuid, `ko-created-${Date.now().toString(36)}`);
    const keys = await admin.allTokenKeys(token.uuid, tokenProfile.uuid);
    createdPair = identityOf(heldBy(keys, createdKey.uuid));
    const { results } = await admin.onboardTokenKeys(
      token.uuid,
      tokenProfile.uuid,
      [...planted.bulkRemovable, planted.compromised].map((label) => ({ keyPairMeta: keyPairMetaOf(keys, label) })),
    );
    expect(results.map((result) => result.onboarded)).toEqual([true, true, true]);
    onboardedUuids = results.slice(0, planted.bulkRemovable.length).map((result) => result.keyUuid ?? '');
    compromisedUuid = results[planted.bulkRemovable.length].keyUuid ?? '';
    await admin.compromiseKey(compromisedUuid);
  });

  test('refuses to remove a compromised key', async ({ admin }) => {
    const removal = await admin.removeKeyFromInventory(compromisedUuid);

    expect(removal.status()).toBe(422);
    expect(await removal.text()).toContain('compromised');
  });

  test('removes the onboarded and the created keys and reports the compromised key', async ({ admin, provisioned }) => {
    const report = await admin.removeKeysFromInventory([...onboardedUuids, createdKey.uuid, compromisedUuid]);

    expect(report).toEqual([expect.objectContaining({ uuid: compromisedUuid, message: expect.stringContaining('compromised') })]);
    for (const keyUuid of [...onboardedUuids, createdKey.uuid]) {
      expect((await admin.raw('GET', `/v1/keys/${keyUuid}`)).status()).toBe(404);
    }
    expect((await admin.raw('GET', `/v1/keys/${compromisedUuid}`)).status()).toBe(200);
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);
    for (const label of provisioned.planted.bulkRemovable) {
      expect(labelled(keys, label).status).toBe('onboardable');
    }
    expect(createdPair).toBeDefined();
    expect(keys.find((key) => identityOf(key) === createdPair)?.status).toBe('onboardable');
  });

  test('destroys the compromised key, as the refusal advises', async ({ admin, provisioned }) => {
    const destruction = await admin.raw('PATCH', `/v1/keys/${compromisedUuid}/destroy`, []);

    expect(destruction.status()).toBe(204);
    const key = await admin.get<KeyDetail>(`/v1/keys/${compromisedUuid}`);
    expect(key.items.map((item) => item.state)).toEqual(['destroyedCompromised', 'destroyedCompromised']);
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);
    expect(keys.find((listed) => listed.label === provisioned.planted.compromised)).toBeUndefined();
  });
});
