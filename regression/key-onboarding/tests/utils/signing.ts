import { createPublicKey, verify } from 'crypto';
import { AdminApi, KeyDetail, KeyItem } from './adminApi';
import { definitionNamed, requestAttribute, AttributeDefinition } from './attributes';
import { Provisioning } from './env';

/** One signature scheme, named once for Core's signing attributes and once for node's verifier. */
const SIGNATURE = {
  coreOptions: { data_rsaSigScheme: 'PKCS1-v1_5', data_sigDigest: 'SHA-256' } as Record<string, string>,
  nodeDigest: 'sha256',
};

function itemOf(key: KeyDetail, type: KeyItem['type']): KeyItem {
  const item = key.items.find((candidate) => candidate.type === type);
  if (!item) {
    throw new Error(`Key ${key.name} has no ${type} item`);
  }
  return item;
}

/** Core asks for the signing attributes the key's algorithm takes. Each is answered from the scheme. */
export async function signThroughCore(
  api: AdminApi,
  provisioned: Provisioning,
  key: KeyDetail,
  data: Buffer,
): Promise<Buffer> {
  const privateKeyItem = itemOf(key, 'Private');
  const operations = `/v1/operations/tokens/${provisioned.token.uuid}/tokenProfiles/${provisioned.tokenProfile.uuid}/keys/${key.uuid}/items/${privateKeyItem.uuid}`;
  const definitions = await api.get<AttributeDefinition[]>(`${operations}/sign/attributes`);
  const signatureAttributes = definitions.map((definition) => {
    const chosen = SIGNATURE.coreOptions[definition.name];
    if (!chosen) {
      throw new Error(`The suite chooses nothing for the signing attribute ${definition.name}`);
    }
    return requestAttribute(definitionNamed(definitions, definition.name), [{ data: chosen }]);
  });
  const response = await api.post<{ signatures: Array<{ data: string }> }>(`${operations}/sign`, {
    signatureAttributes,
    data: [{ data: data.toString('base64') }],
  });
  return Buffer.from(response.signatures[0].data, 'base64');
}

/** Whether the public key Core holds for the key verifies the signature over the data. */
export function verifiesWithRecordedPublicKey(key: KeyDetail, data: Buffer, signature: Buffer): boolean {
  const publicKeyItem = itemOf(key, 'Public');
  if (!publicKeyItem.keyData) {
    throw new Error(`Key ${key.name} has no public key data`);
  }
  const publicKey = createPublicKey({ key: Buffer.from(publicKeyItem.keyData, 'base64'), format: 'der', type: 'spki' });
  return verify(SIGNATURE.nodeDigest, data, publicKey, signature);
}
