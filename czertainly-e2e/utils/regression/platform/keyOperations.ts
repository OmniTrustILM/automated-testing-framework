/**
 * keyOperations — sign, verify, encrypt, decrypt, export and import on the items of an own key; every call goes through GuardedApi, so an
 * operation on a foreign key item is refused before it is sent.
 */

import type { APIRequestContext, APIResponse } from '@playwright/test';
import { AttributeDefinition, AttributeOption, SignVariant, pickSignatureOption } from './cryptoAlgorithmCases';
import type { GuardedApi } from '../guard/types';
import { apiJson } from '../apiReads';
import { KeyRef } from '../ledger/ledger';
import { runId } from '../ledger/runState';
import { isJsonObject, JsonObject } from '../json';
import { KeyRequestType, KeyChain } from './keys';
import { profileUrl } from './tokens';


export interface ItemRef {
    tokenUuid: string;
    tokenProfileUuid: string;
    keyUuid: string;
    itemUuid: string;
}

export const operationUrl = (item: ItemRef, op: 'sign' | 'verify' | 'encrypt' | 'decrypt'): string =>
    `/api/v1/operations/tokens/${item.tokenUuid}/tokenProfiles/${item.tokenProfileUuid}/keys/${item.keyUuid}/items/${item.itemUuid}/${op}`;

export function itemRef(chain: KeyChain, kind: 'private' | 'public', key: KeyRef = chain.key): ItemRef {
    const itemUuid = kind === 'private' ? key.keyItems?.privateUuid : key.keyItems?.publicUuid;
    if (!itemUuid) throw new Error(`key ${key.uuid} has no ${kind} item uuid`);
    return { tokenUuid: chain.token.uuid, tokenProfileUuid: chain.tokenProfile.uuid, keyUuid: key.uuid, itemUuid };
}

export const listSignAttributes = (api: APIRequestContext, item: ItemRef): Promise<AttributeDefinition[]> =>
    apiJson<AttributeDefinition[]>(api, 'GET', `${operationUrl(item, 'sign')}/attributes`);

export const listEncryptAttributes = (api: APIRequestContext, item: ItemRef): Promise<AttributeDefinition[]> =>
    apiJson<AttributeDefinition[]>(api, 'GET', `${operationUrl(item, 'encrypt')}/attributes`);

export function signatureAttributesFor(defs: AttributeDefinition[], variant: SignVariant): JsonObject[] | undefined {
    const def = defs.find((d) => /signatureAlgorithm/i.test(d.name)) ?? defs[0];
    if (!def) return [];
    const option = pickSignatureOption((def.content ?? []) as AttributeOption[], variant);
    if (!option) return undefined;
    return [{ name: def.name, uuid: def.uuid, version: 'v2', contentType: def.contentType ?? 'string', content: [option] }];
}

export function signWithItem(api: GuardedApi, item: ItemRef, dataBase64: string, signatureAttributes: JsonObject[]): Promise<APIResponse> {
    return api.post(operationUrl(item, 'sign'), { data: { signatureAttributes, data: [{ data: dataBase64 }] } });
}

export function verifyWithItem(api: GuardedApi, item: ItemRef, dataBase64: string, signatureBase64: string, signatureAttributes: JsonObject[]): Promise<APIResponse> {
    return api.post(operationUrl(item, 'verify'), { data: { signatureAttributes, signatures: [{ data: signatureBase64 }], data: [{ data: dataBase64 }] } });
}

export function cipherWithItem(api: GuardedApi, item: ItemRef, op: 'encrypt' | 'decrypt', dataBase64: string, cipherAttributes: JsonObject[]): Promise<APIResponse> {
    return api.post(operationUrl(item, op), { data: { cipherAttributes, cipherData: [{ data: dataBase64 }] } });
}

const firstOf = (list: unknown): JsonObject | undefined => (Array.isArray(list) && isJsonObject(list[0]) ? list[0] : undefined);
const stringOrUndefined = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const signatureOf = (body: JsonObject): string | undefined => stringOrUndefined(firstOf(body?.signatures)?.data);
export function verificationOf(body: JsonObject): boolean | undefined {
    const result = firstOf(body?.verifications)?.result;
    return typeof result === 'boolean' ? result : undefined;
}
export const cipherOutputOf = (body: JsonObject): string | undefined => stringOrUndefined(firstOf(body?.encryptedData ?? body?.decryptedData)?.data);

export function exportKeyItem(api: GuardedApi, keyUuid: string, itemUuid: string, passphrase: string): Promise<APIResponse> {
    return api.post(`/api/v1/keys/${keyUuid}/items/${itemUuid}/export`, { data: { passphrase, exportAttributes: [] } });
}

export function disableKeyItemExport(api: GuardedApi, keyUuid: string, itemUuid: string): Promise<APIResponse> {
    return api.patch(`/api/v1/keys/${keyUuid}/items/${itemUuid}/export/disable`);
}

export interface ImportRequest {
    name: string;
    importAttributes: JsonObject[];
    inputPassphrase?: string;
    exportable?: boolean;
}

export const listImportKeyAttributes = (api: APIRequestContext, chain: Pick<KeyChain, 'token' | 'tokenProfile'>, type: KeyRequestType = 'keyPair'): Promise<AttributeDefinition[]> =>
    apiJson<AttributeDefinition[]>(api, 'GET', `${profileUrl(chain.token, chain.tokenProfile)}/keys/${type}/import/attributes`);

export function importKey(api: GuardedApi, chain: Pick<KeyChain, 'token' | 'tokenProfile'>, req: ImportRequest, type: KeyRequestType = 'keyPair'): Promise<APIResponse> {
    return api.post(`${profileUrl(chain.token, chain.tokenProfile)}/keys/${type}/import`, {
        data: {
            name: req.name,
            description: `REG run ${runId()} import`,
            ...(req.inputPassphrase ? { inputPassphrase: req.inputPassphrase } : {}),
            exportable: req.exportable ?? false,
            importAttributes: req.importAttributes,
            customAttributes: [],
            groupUuids: [],
        },
    });
}
