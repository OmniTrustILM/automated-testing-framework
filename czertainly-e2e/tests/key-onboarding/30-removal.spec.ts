import { describeLocalOnly } from '../../utils/regression/tier/localProof';
import { KeyDetail, TokenKey } from '../../utils/keyOnboarding/adminApi';
import { expect, handleOf, labelled, onboardedKey, test } from '../../utils/keyOnboarding/fixtures';
import { ledgerSpec, provisioningOrSkip } from '../../utils/keyOnboarding/provisioning';
import { devTests } from '../../utils/keyOnboarding/tags';
import { recordCreated, recordDeleted } from '../../utils/regression/ledger/ledger';
import { runName } from '../../utils/regression/ledger/runState';

describeLocalOnly(test);

test.describe.serial('Removing an onboarded key from the inventory', devTests(), () => {
  let keyUuid: string;

  test('removes the key from the inventory and leaves the pair on the token', devTests(), async ({ admin, provisioned }, testInfo) => {
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);
    const [onboarded] = (
      await admin.onboardTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid, [
        { keyHandle: handleOf(keys, provisioned.planted.removable) },
      ])
    ).results;
    if (onboarded.onboarded) {
      recordCreated('keys', onboardedKey(onboarded), {
        spec: ledgerSpec(testInfo),
        note: 'onboarded token key',
        parents: { token: provisioned.token.uuid, tokenProfile: provisioned.tokenProfile.uuid },
      });
    }
    expect(onboarded.onboarded).toBe(true);
    keyUuid = onboarded.keyUuid ?? '';

    const removal = await admin.removeKeyFromInventory(keyUuid);

    expect(removal.status()).toBe(204);
    recordDeleted('keys', onboardedKey(onboarded), ledgerSpec(testInfo), 'removed from the inventory');
    expect((await admin.raw('GET', `/v1/keys/${keyUuid}`)).status()).toBe(404);
    const relisted = labelled(await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid), provisioned.planted.removable);
    expect(relisted.status).toBe('onboardable');
  });

  test('onboards the removed pair again', devTests(), async ({ admin, provisioned }, testInfo) => {
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);

    const [again] = (
      await admin.onboardTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid, [
        { keyHandle: handleOf(keys, provisioned.planted.removable) },
      ])
    ).results;
    if (again.onboarded) {
      recordCreated('keys', onboardedKey(again), {
        spec: ledgerSpec(testInfo),
        note: 'onboarded token key',
        parents: { token: provisioned.token.uuid, tokenProfile: provisioned.tokenProfile.uuid },
      });
    }

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

test.describe.serial('Removing keys from the inventory in bulk', devTests(), () => {
  let createdKey: KeyDetail;
  let createdPairHandle: string;
  let onboardedUuids: string[];
  let compromisedUuid: string;

  const keyNames = new Map<string, string>();

  // A hook reads the summary in its body (a skip here skips the group) and uses the worker-scoped admin.
  test.beforeAll(async ({ adminWorker: admin }, testInfo) => {
    const provisioned = provisioningOrSkip();
    const { token, tokenProfile, planted } = provisioned;
    const parents = { token: token.uuid, tokenProfile: tokenProfile.uuid };
    createdKey = await admin.createKeyPair(token.uuid, tokenProfile.uuid, runName('created'));
    recordCreated('keys', { uuid: createdKey.uuid, name: createdKey.name }, { spec: ledgerSpec(testInfo), note: 'key pair created through Core', parents });
    keyNames.set(createdKey.uuid, createdKey.name);
    const keys = await admin.allTokenKeys(token.uuid, tokenProfile.uuid);
    createdPairHandle = heldBy(keys, createdKey.uuid).keyHandle ?? '';
    const { results } = await admin.onboardTokenKeys(
      token.uuid,
      tokenProfile.uuid,
      [...planted.bulkRemovable, planted.compromised].map((label) => ({ keyHandle: handleOf(keys, label) })),
    );
    for (const result of results) {
      if (result.onboarded) {
        const key = onboardedKey(result);
        recordCreated('keys', key, { spec: ledgerSpec(testInfo), note: 'onboarded token key', parents });
        keyNames.set(key.uuid, key.name);
      }
    }
    expect(results.map((result) => result.onboarded)).toEqual([true, true, true]);
    onboardedUuids = results.slice(0, planted.bulkRemovable.length).map((result) => result.keyUuid ?? '');
    compromisedUuid = results[planted.bulkRemovable.length].keyUuid ?? '';
    await admin.compromiseKey(compromisedUuid);
  });

  test('refuses to remove a compromised key', devTests(), async ({ admin }) => {
    const removal = await admin.removeKeyFromInventory(compromisedUuid);

    expect(removal.status()).toBe(422);
    expect(await removal.text()).toContain('compromised');
  });

  test('removes the onboarded and the created keys and reports the compromised key', devTests(), async ({ admin, provisioned }, testInfo) => {
    const report = await admin.removeKeysFromInventory([...onboardedUuids, createdKey.uuid, compromisedUuid]);
    const refused = new Set(report.map((message) => message.uuid));
    for (const keyUuid of [...onboardedUuids, createdKey.uuid].filter((uuid) => !refused.has(uuid))) {
      const name = keyNames.get(keyUuid);
      if (!name) throw new Error(`Key ${keyUuid} was removed in bulk but this group never recorded it; it cannot be marked deleted`);
      recordDeleted('keys', { uuid: keyUuid, name }, ledgerSpec(testInfo), 'removed from the inventory in bulk');
    }

    expect(report).toEqual([expect.objectContaining({ uuid: compromisedUuid, message: expect.stringContaining('compromised') })]);
    for (const keyUuid of [...onboardedUuids, createdKey.uuid]) {
      expect((await admin.raw('GET', `/v1/keys/${keyUuid}`)).status()).toBe(404);
    }
    expect((await admin.raw('GET', `/v1/keys/${compromisedUuid}`)).status()).toBe(200);
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);
    for (const label of provisioned.planted.bulkRemovable) {
      expect(labelled(keys, label).status).toBe('onboardable');
    }
    expect(keys.find((key) => key.keyHandle === createdPairHandle)?.status).toBe('onboardable');
  });

  test('destroys the compromised key, as the refusal advises', devTests(), async ({ admin, provisioned }) => {
    const destruction = await admin.raw('PATCH', `/v1/keys/${compromisedUuid}/destroy`, []);

    expect(destruction.status()).toBe(204);
    const key = await admin.get<KeyDetail>(`/v1/keys/${compromisedUuid}`);
    expect(key.items.map((item) => item.state)).toEqual(['destroyedCompromised', 'destroyedCompromised']);
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);
    expect(keys.find((listed) => listed.label === provisioned.planted.compromised)).toBeUndefined();
  });
});
