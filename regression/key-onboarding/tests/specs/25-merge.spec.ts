import { CertificateDetail, KeyDetail } from '../utils/adminApi';
import { expect, keyPairMetaOf, labelled, test } from '../utils/fixtures';
import { signThroughCore, verifiesWithRecordedPublicKey } from '../utils/signing';

test.describe.serial('Onboarding a key pair into the key holding its public key', () => {
  let certificate: CertificateDetail;
  let record: KeyDetail;

  test('lists a pair whose public key a certificate brought in as onboardable into that key', async ({ admin, provisioned }) => {
    certificate = await admin.uploadCertificate(provisioned.certifiedCertificate);
    expect(certificate.privateKeyAvailability).toBe(false);
    record = await admin.get<KeyDetail>(`/v1/keys/${certificate.key?.uuid}`);
    expect(record.items.map((item) => item.type)).toEqual(['Public']);

    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);

    expect(labelled(keys, provisioned.planted.certified)).toMatchObject({
      status: 'onboardableIntoKey',
      inventoryKeyUuid: record.uuid,
      inventoryKeyName: record.name,
    });
  });

  test('adds the private key disabled to that key, which keeps its identity and its certificate', async ({ admin, provisioned }) => {
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);

    const [result] = (
      await admin.onboardTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid, [
        { keyPairMeta: keyPairMetaOf(keys, provisioned.planted.certified) },
      ])
    ).results;

    expect(result).toMatchObject({ onboarded: true, intoExistingKey: true, keyUuid: record.uuid, keyName: record.name });
    const merged = await admin.get<KeyDetail>(`/v1/keys/${record.uuid}`);
    expect(merged).toMatchObject({ name: record.name, tokenProfileUuid: provisioned.tokenProfile.uuid });
    expect(merged.items.map((item) => item.type).sort()).toEqual(['Private', 'Public']);
    expect(merged.items.find((item) => item.type === 'Private')).toMatchObject({ enabled: false });
    const reread = await admin.get<CertificateDetail>(`/v1/certificates/${certificate.uuid}`);
    expect(reread).toMatchObject({ privateKeyAvailability: true, key: { uuid: record.uuid } });
  });

  test('signs through Core with the merged key once it is enabled', async ({ admin, provisioned }) => {
    await admin.enableKey(record.uuid);
    const key = await admin.get<KeyDetail>(`/v1/keys/${record.uuid}`);
    const data = Buffer.from(`signed by ${key.name}`);

    const signature = await signThroughCore(admin, provisioned, key, data);

    expect(verifiesWithRecordedPublicKey(key, data, signature)).toBe(true);
  });

  test('lists the pair as held by the merged key', async ({ admin, provisioned }) => {
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);

    expect(labelled(keys, provisioned.planted.certified)).toMatchObject({ status: 'inInventory', inventoryKeyUuid: record.uuid });
  });

  test('removes the whole merged key from the inventory and keeps the certificate', async ({ admin, provisioned }) => {
    const removal = await admin.removeKeyFromInventory(record.uuid);

    expect(removal.status()).toBe(204);
    expect((await admin.raw('GET', `/v1/keys/${record.uuid}`)).status()).toBe(404);
    expect((await admin.raw('GET', `/v1/certificates/${certificate.uuid}`)).status()).toBe(200);
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);
    expect(labelled(keys, provisioned.planted.certified).status).toBe('onboardable');
  });

  test('onboards the pair again as a new key, which the certificate links to', async ({ admin, provisioned }) => {
    const keys = await admin.allTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid);

    const [result] = (
      await admin.onboardTokenKeys(provisioned.token.uuid, provisioned.tokenProfile.uuid, [
        { keyPairMeta: keyPairMetaOf(keys, provisioned.planted.certified) },
      ])
    ).results;

    expect(result).toMatchObject({ onboarded: true, intoExistingKey: false });
    expect(result.keyUuid).not.toBe(record.uuid);
    const reread = await admin.get<CertificateDetail>(`/v1/certificates/${certificate.uuid}`);
    expect(reread).toMatchObject({ privateKeyAvailability: true, key: { uuid: result.keyUuid } });
  });
});
