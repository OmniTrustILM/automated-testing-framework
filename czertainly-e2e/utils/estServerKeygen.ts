/**
 * estServerKeygen — `/serverkeygen` as the EST specs read it, and the key records it leaves.
 *
 * WHAT: reads a server key generation answer into its private key and certificate, checks that
 * they belong together, reads the key the inventory links to a certificate, removes such a key
 * with its token copy, and prepares the key attributes of a key-recovery EST Profile.
 * WHY: an in-memory key must reach the client only, while a recovered key must also stay on the
 * token, and each claim is checked against what the platform actually holds.
 * HOW: the answer is a `multipart/mixed` body of a PKCS#8 part and a certs-only part
 * (RFC 7030 §4.4.2). Keys are compared through Node's crypto, which reads RSA and EC keys alike: the public
 * key derived from the private key against the certificate's, both as SPKI DER. A key item's
 * `keyData` is base64 of that SPKI DER. A recovered key is removed by deleting it, which also
 * destroys it on the token.
 */

import { APIRequestContext } from '@playwright/test';
import * as crypto from 'crypto';
import { ensureOk } from './estAdminApi';
import { EstResponse } from './estHttp';
import { parseCertsOnlyDer, parseMultipartMixed } from './estPki';
import { Logger } from './Logger';

const logger = new Logger('EstServerKeygen');

export const PKCS8 = 'application/pkcs8';

export interface ServerGeneratedKey {
  /** The private key as PKCS#8 DER. */
  key: Buffer;
  /** The certificate as DER. */
  certificate: Buffer;
}

/** The key and certificate of a successful `/serverkeygen`; throws, naming what is wrong, otherwise. */
export function serverGeneratedKey(resp: EstResponse): ServerGeneratedKey {
  if (resp.status !== 200) {
    throw new Error(`Server key generation answered ${resp.status}: ${resp.body.toString('utf8').slice(0, 200)}`);
  }
  const parts = parseMultipartMixed(resp.headers['content-type'] ?? '', resp.body);
  const keyPart = parts.find((part) => part.contentType === PKCS8);
  const certificatePart = parts.find((part) => part.contentType === 'application/pkcs7-mime');
  if (parts.length !== 2 || !keyPart || !certificatePart) {
    throw new Error(`Server key generation answered parts: ${parts.map((part) => part.contentType).join(', ')}`);
  }
  const certificates = parseCertsOnlyDer(certificatePart.body);
  if (certificates.length !== 1) {
    throw new Error(`Server key generation answered ${certificates.length} certificates`);
  }
  return { key: keyPart.body, certificate: certificates[0] };
}

/** SPKI DER of the certificate's public key. */
export function certificatePublicKey(certificate: Buffer): Buffer {
  return new crypto.X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' });
}

/** Whether the PKCS#8 private key belongs to the certificate's public key. */
export function privateKeyMatchesCertificate(pkcs8: Buffer, certificate: Buffer): boolean {
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const derived = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return derived.equals(certificatePublicKey(certificate));
}

export interface InventoryKey {
  uuid: string;
  tokenProfileUuid?: string;
  /** The key's private item exists in the inventory. */
  hasPrivateKey: boolean;
  /** SPKI DER of the public item, when the inventory holds one. */
  publicKey?: Buffer;
}

/** The key the inventory links to the certificate, or undefined when it links none. */
export async function getCertificateKey(api: APIRequestContext, certificateUuid: string): Promise<InventoryKey | undefined> {
  const certResp = await api.get(`/api/v1/certificates/${certificateUuid}`);
  await ensureOk(certResp, `Get certificate ${certificateUuid}`);
  const keyUuid = ((await certResp.json()) as { key?: { uuid?: string } }).key?.uuid;
  if (!keyUuid) return undefined;

  const keyResp = await api.get(`/api/v1/keys/${keyUuid}`);
  await ensureOk(keyResp, `Get key ${keyUuid}`);
  const key = (await keyResp.json()) as { tokenProfileUuid?: string; items: Array<{ type: string; keyData?: string }> };
  const publicItem = key.items.find((item) => item.type === 'Public');
  return {
    uuid: keyUuid,
    tokenProfileUuid: key.tokenProfileUuid,
    hasPrivateKey: key.items.some((item) => item.type === 'Private'),
    publicKey: publicItem?.keyData ? Buffer.from(publicItem.keyData, 'base64') : undefined,
  };
}

/**
 * Deletes the key, which destroys it on its token first, and checks the record is gone. Destroying
 * it separately beforehand would leave a record that can no longer be deleted: the token no longer
 * knows the key and refuses the delete.
 */
export async function deleteTokenKey(api: APIRequestContext, keyUuid: string): Promise<void> {
  logger.info(`Deleting key: ${keyUuid}`);
  await ensureOk(await api.delete(`/api/v1/keys/${keyUuid}`, { data: [] }), `Delete key ${keyUuid}`, [404]);
  const after = await api.get(`/api/v1/keys/${keyUuid}`);
  if (after.status() !== 404) throw new Error(`Delete key ${keyUuid} left the key in the inventory: ${after.status()}`);
}

const KEY_ALGORITHM = { uuid: '72159c04-d1a9-4703-8b23-469224425d5f', name: 'data_keyAlgorithm' };
const ECDSA_CURVE = { uuid: '08730b36-90f3-4046-9f13-3cf827ad6cc7', name: 'data_ecdsaCurve' };
const KEY_SPEC_GROUP = { uuid: '05927c10-b5ca-43cb-a69f-098885b8c307', name: 'group_keySpecV2' };

/**
 * Key attributes for an ECDSA P-256 key on the token profile. The curve sits behind a callback
 * group, and the platform accepts it in an EST Profile only after that callback ran, as the UI does.
 */
export async function ecdsaKeyRecoveryAttributes(api: APIRequestContext, tokenProfileUuid: string): Promise<unknown[]> {
  const algorithm = { ...KEY_ALGORITHM, contentType: 'string', content: [{ contentType: 'string', reference: 'ECDSA', data: 'ECDSA' }] };
  const callback = await api.post(`/api/v1/keys/${tokenProfileUuid}/callback`, {
    data: { ...KEY_SPEC_GROUP, attributes: [{ version: 'v3', ...algorithm }] },
  });
  await ensureOk(callback, `Key attribute callback on token profile ${tokenProfileUuid}`);
  return [
    { ...KEY_ALGORITHM, contentType: 'string', content: [{ reference: 'ECDSA', data: 'ECDSA' }] },
    { ...ECDSA_CURVE, contentType: 'string', content: [{ reference: 'secp256r1', data: 'secp256r1' }] },
  ];
}
