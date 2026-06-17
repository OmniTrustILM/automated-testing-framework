/**
 * CZERTAINLY Core v2 attribute payload shapes — shared across all resource creations.
 *
 * Every POST to Core (Credential, Authority, RA Profile, Cert issue) sends
 * `attributes: [...]` with the same structure:
 *   { name, uuid, version: 'v2', contentType, content: [{ data, reference? }] }
 *
 * We use 6 contentTypes; `data` shape and where each is used:
 *   1. string     — primitive — Credential.keyStoreType, Authority.url, RA Profile.usernameGenMethod
 *   2. boolean    — primitive — RA Profile.sendNotifications, RA Profile.keyRecoverable
 *   3. secret     — { secret: '...' } — Credential.keyStorePassword
 *   4. file       — { content: <base64>, fileName, mimeType } — Credential.keyStore (the .p12)
 *   5. credential — { uuid, name } (FK to Core Credential) — Authority.credential
 *   6. object     — { id, name } (FK to EJBCA entity) — RA Profile.certificationAuthority / endEntityProfile / certificateProfile
 *

 * Because each contentType has its own `data` shape, we provide 6 builder helpers —
 * one per contentType (stringAttr, booleanAttr, secretAttr, fileAttr, credentialAttr,
 * objectAttr) — so callers always produce the correct shape without boilerplate.
 */
export type AttributeContentType =
  | 'string' | 'boolean' | 'secret' | 'file' | 'credential' | 'object';

export interface AttributeContent {
  data: unknown;
  reference?: string;
}

export interface AttributeRequest {
  name: string;
  uuid: string;
  version: 'v2';
  contentType: AttributeContentType;
  content: AttributeContent[];
}

export function stringAttr(name: string, uuid: string, value: string): AttributeRequest {
  return {
    name, uuid, version: 'v2', contentType: 'string',
    content: [{ data: value, reference: value }],
  };
}

export function booleanAttr(name: string, uuid: string, value: boolean): AttributeRequest {
  return {
    name, uuid, version: 'v2', contentType: 'boolean',
    content: [{ data: value }],
  };
}

export function secretAttr(name: string, uuid: string, value: string): AttributeRequest {
  return {
    name, uuid, version: 'v2', contentType: 'secret',
    content: [{ data: { secret: value } }],
  };
}

export function fileAttr(
  name: string,
  uuid: string,
  contentBase64: string,
  fileName: string,
  mimeType: string,
): AttributeRequest {
  return {
    name, uuid, version: 'v2', contentType: 'file',
    content: [{ data: { content: contentBase64, fileName, mimeType } }],
  };
}

export function credentialAttr(
  name: string,
  uuid: string,
  credentialUuid: string,
  credentialName: string,
): AttributeRequest {
  return {
    name, uuid, version: 'v2', contentType: 'credential',
    content: [{
      data: { uuid: credentialUuid, name: credentialName },
      reference: credentialName,
    }],
  };
}

export function objectAttr(
  name: string,
  uuid: string,
  refId: number,
  refName: string,
): AttributeRequest {
  return {
    name, uuid, version: 'v2', contentType: 'object',
    content: [{
      data: { id: refId, name: refName },
      reference: refName,
    }],
  };
}
