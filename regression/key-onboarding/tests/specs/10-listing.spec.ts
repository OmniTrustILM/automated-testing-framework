import { MAX_TOKEN_KEYS_PER_PAGE } from '../utils/adminApi';
import { expect, labelled, test } from '../utils/fixtures';

test.describe('Listing the key pairs on a token', () => {
  test('the token profile offers key listing', async ({ admin, provisioned }) => {
    const profile = await admin.get<{ keyListAvailable: boolean }>(
      `/v1/tokens/${provisioned.token.uuid}/tokenProfiles/${provisioned.tokenProfile.uuid}`,
    );

    expect(profile.keyListAvailable).toBe(true);
  });

  test('lists each planted key pair with whether it can be onboarded', async ({ admin, provisioned }) => {
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);

    expect(labelled(keys, provisioned.planted.rsa)).toMatchObject({
      status: 'onboardable',
      keyAlgorithm: 'RSA',
      length: 2048,
      suggestedName: provisioned.planted.rsa,
    });
    expect(labelled(keys, provisioned.planted.ec)).toMatchObject({ status: 'onboardable', keyAlgorithm: 'ECDSA', length: 256 });
    expect(labelled(keys, provisioned.planted.orphan)).toMatchObject({ status: 'noPublicKey', keyAlgorithm: 'RSA' });
    expect(labelled(keys, provisioned.planted.orphan).suggestedName).toBeUndefined();
    expect(labelled(keys, provisioned.planted.orphan).reason).toContain('no public key');
  });

  test('lists a key pair without a unique ID as not onboardable and without a handle', async ({ admin, provisioned }) => {
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);

    for (const label of [provisioned.planted.noIdEc, ...provisioned.planted.idSharingEc]) {
      const key = labelled(keys, label);
      expect(key).toMatchObject({ status: 'noUniqueId', keyAlgorithm: 'ECDSA', length: 256 });
      expect(key.keyHandle).toBeUndefined();
      expect(key.reason).toContain('without an ID unique to it');
    }
  });

  test('pages through the token without repeating a key pair', async ({ admin, provisioned }) => {
    const all = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);
    const pageSize = Math.min(MAX_TOKEN_KEYS_PER_PAGE, Math.max(1, Math.ceil(all.length / 3)));

    const first = await admin.tokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid, 1, pageSize);
    const pages = [first];
    for (let pageNumber = 2; pageNumber <= first.totalPages; pageNumber++) {
      pages.push(await admin.tokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid, pageNumber, pageSize));
    }

    pages.forEach((page, index) => {
      expect(page).toMatchObject({
        pageNumber: index + 1,
        itemsPerPage: pageSize,
        totalItems: first.totalItems,
        totalPages: Math.ceil(first.totalItems / pageSize),
      });
      expect(page.items.length).toBeLessThanOrEqual(pageSize);
    });
    const handles = pages.flatMap((page) => page.items.flatMap((key) => key.keyHandle ?? []));
    expect(new Set(handles).size).toBe(handles.length);
    expect([...handles].sort()).toEqual(all.flatMap((key) => key.keyHandle ?? []).sort());
  });

  test('refuses a page the connector cannot serve', async ({ admin, provisioned }) => {
    const response = await admin.raw(
      'GET',
      `/v1/tokens/${provisioned.token.uuid}/tokenProfiles/${provisioned.tokenProfile.uuid}/tokenKeys?pageNumber=1&itemsPerPage=${MAX_TOKEN_KEYS_PER_PAGE + 1}`,
    );

    expect(response.status()).toBe(422);
  });
});
