/**
 * credentialUtils — wrapper around CZERTAINLY Core /api/v1/credentials.
 *
 * Used by globalSetup to create a SoftKeyStore credential from a .p12 keystore
 * (passed via env vars) and by globalTeardown to delete it after the test run.
 *
 * createCredential does TWO HTTP calls:
 *   1. GET attribute schema for credentialProvider/SoftKeyStore — to learn attribute UUIDs
 *   2. POST the credential payload built with discovered UUIDs + values from caller
 *
 * Caller (globalSetup) is responsible for resolving the credential-provider connector
 * UUID first via connectorUtils.findConnectorByName.
 */

import { APIRequestContext } from '@playwright/test';
import { Logger } from './Logger';
import { AttributeRequest, stringAttr, secretAttr, fileAttr } from './attributeTypes';

const logger = new Logger('CredentialUtils');
const CREDENTIALS_API = '/api/v1/credentials';

export interface CredentialDto {
  uuid: string;
  name: string;
}

export interface CreateCredentialOptions {
  name: string;
  connectorUuid: string;   // UUID of the credential-provider connector
  p12Base64: string;       // .p12 keystore content, base64-encoded
  password: string;        // keystore password
}

export async function createCredential(
    request: APIRequestContext,
    options: CreateCredentialOptions,
): Promise<CredentialDto> {
    logger.info(`Creating credential: ${options.name}`);

    // Step 1: fetch attribute schema to learn UUIDs of keyStoreType / keyStorePassword / keyStore
    const schemaUrl = `/api/v1/connectors/${options.connectorUuid}/attributes/credentialProvider/SoftKeyStore`;
    const schemaResp = await request.get(schemaUrl);
    if (!schemaResp.ok()) {
        const errBody = await schemaResp.text();
        throw new Error(`Failed to fetch SoftKeyStore attribute schema: ${schemaResp.status()} - ${errBody}`);
    }
    const schema = await schemaResp.json() as Array<{ name: string; uuid: string }>;

    // Helper: find attribute UUID by name (throws if not in schema)
    const uuidOf = (name: string): string => {
        const attr = schema.find(a => a.name === name);
        if (!attr) {
            throw new Error(`Attribute "${name}" not found in SoftKeyStore schema`);
        }
        return attr.uuid;
    };

    // Step 2: build payload using attribute helpers
    const attributes: AttributeRequest[] = [
        stringAttr('keyStoreType', uuidOf('keyStoreType'), 'PKCS12', true),
        secretAttr('keyStorePassword', uuidOf('keyStorePassword'), options.password),
        fileAttr('keyStore', uuidOf('keyStore'), options.p12Base64, 'keystore.p12', 'application/x-pkcs12'),
    ];

    // Step 3: POST and return
    const resp = await request.post(CREDENTIALS_API, {
        data: {
            name: options.name,
            connectorUuid: options.connectorUuid,
            kind: 'SoftKeyStore',
            attributes,
            customAttributes: [],
        },
    });
    if (!resp.ok()) {
        const errBody = await resp.text();
        throw new Error(`Failed to create credential: ${resp.status()} - ${errBody}`);
    }

    const { uuid } = await resp.json() as { uuid: string };
    logger.info(`Credential created: ${options.name} (uuid: ${uuid})`);
    return { uuid, name: options.name };
}

export async function deleteCredential(
    request: APIRequestContext,
    uuid: string,
): Promise<void> {
    logger.info(`Deleting credential: ${uuid}`);
    const resp = await request.delete(`${CREDENTIALS_API}/${uuid}`);
    if (!resp.ok() && resp.status() !== 204 && resp.status() !== 404) {
        const errBody = await resp.text();
        throw new Error(`Failed to delete credential ${uuid}: ${resp.status()} - ${errBody}`);
    }
}
