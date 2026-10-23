import { MAX_TOKEN_KEYS_PER_PAGE } from '../utils/adminApi';
import { expect, identityOf, labelled, test } from '../utils/fixtures';

test.describe('Listing the key pairs on a token', () => {
  test('the token profile offers key listing', async ({ admin, provisioned }) => {
    const profiles = await admin.get<Array<{ uuid: string }>>('/v1/tokenProfiles?keyListable=true');

    expect(profiles.map((profile) => profile.uuid)).toContain(provisioned.tokenProfile.uuid);
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

  test('lists a key pair without a usable ID as not onboardable and without metadata', async ({ admin, provisioned }) => {
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);

    for (const label of [provisioned.planted.noIdEc, ...provisioned.planted.idSharingEc]) {
      const key = labelled(keys, label);
      expect(key).toMatchObject({ status: 'noUsableId', keyAlgorithm: 'ECDSA', length: 256 });
      expect(key.keyPairMeta).toBeUndefined();
      expect(key.reason).toContain('without an ID the platform can address it by');
    }
  });

  test('pages through the token in full pages without repeating a key pair', async ({ admin, provisioned }) => {
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
      expect(page.items).toHaveLength(Math.min(pageSize, first.totalItems - index * pageSize));
    });
    const identities = pages.flatMap((page) => page.items.flatMap((key) => identityOf(key) ?? []));
    expect(new Set(identities).size).toBe(identities.length);
    expect([...identities].sort()).toEqual(all.flatMap((key) => identityOf(key) ?? []).sort());
  });

  test('refuses a page larger than the listing limit', async ({ admin, provisioned }) => {
    const response = await admin.raw(
      'GET',
      `/v1/tokens/${provisioned.token.uuid}/tokenProfiles/${provisioned.tokenProfile.uuid}/tokenKeys?pageNumber=1&itemsPerPage=${MAX_TOKEN_KEYS_PER_PAGE + 1}`,
    );

    expect(response.status()).toBe(400);
    expect(await response.text()).toContain(`itemsPerPage must be at most ${MAX_TOKEN_KEYS_PER_PAGE}`);
  });
});
