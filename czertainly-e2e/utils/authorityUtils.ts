/**
 * authorityUtils — wrapper around CZERTAINLY Core /api/v1/authorities.
 *
 * Used by globalSetup to create an EJBCA Authority that references a previously-created
 * Credential, and by globalTeardown to delete it.
 *
 * createAuthority does TWO HTTP calls:
 *   1. GET attribute schema for authorityProvider/EJBCA — to learn attribute UUIDs
 *   2. POST the authority payload (wsUrl + credential reference) built with discovered UUIDs
 *
 * Caller (globalSetup) resolves the EJBCA connector UUID first via
 * connectorUtils.findConnectorByName, and provides the credential from createCredential.
 */

import { APIRequestContext } from '@playwright/test';
import { Logger } from './Logger';
import { AttributeRequest, stringAttr, credentialAttr } from './attributeTypes';

const logger = new Logger('AuthorityUtils');
const AUTHORITIES_API = '/api/v1/authorities';

export interface AuthorityDto {
  uuid: string;
  name: string;
}

export interface CreateAuthorityOptions {
  name: string;
  connectorUuid: string;     // UUID of the EJBCA-NG connector
  wsUrl: string;             // EJBCA Web Service URL (e.g. ends with ?wsdl)
  credential: { uuid: string; name: string };  // returned by createCredential
}

export async function createAuthority(
    request: APIRequestContext,
    options: CreateAuthorityOptions,
): Promise<AuthorityDto> {
    logger.info(`Creating authority: ${options.name}`);

    // Step 1: fetch attribute schema to learn UUIDs of url / credential
    const schemaUrl = `/api/v1/connectors/${options.connectorUuid}/attributes/authorityProvider/EJBCA`;
    const schemaResp = await request.get(schemaUrl);
    if (!schemaResp.ok()) {
        const errBody = await schemaResp.text();
        throw new Error(`Failed to fetch EJBCA authority attribute schema: ${schemaResp.status()} - ${errBody}`);
    }
    const schema = await schemaResp.json() as Array<{ name: string; uuid: string }>;

    const uuidOf = (name: string): string => {
        const attr = schema.find(a => a.name === name);
        if (!attr) {
            throw new Error(`Attribute "${name}" not found in EJBCA authority schema`);
        }
        return attr.uuid;
    };

    // Step 2: build payload using attribute helpers
    const attributes: AttributeRequest[] = [
        stringAttr('url', uuidOf('url'), options.wsUrl),
        credentialAttr('credential', uuidOf('credential'), options.credential.uuid, options.credential.name),
    ];

    // Step 3: POST and return
    const resp = await request.post(AUTHORITIES_API, {
        data: {
            name: options.name,
            connectorUuid: options.connectorUuid,
            kind: 'EJBCA',
            attributes,
            customAttributes: [],
        },
    });
    if (!resp.ok()) {
        const errBody = await resp.text();
        throw new Error(`Failed to create authority: ${resp.status()} - ${errBody}`);
    }

    const { uuid } = await resp.json() as { uuid: string };
    logger.info(`Authority created: ${options.name} (uuid: ${uuid})`);
    return { uuid, name: options.name };
}

export async function deleteAuthority(
    request: APIRequestContext,
    uuid: string,
): Promise<void> {
    logger.info(`Deleting authority: ${uuid}`);
    const resp = await request.delete(`${AUTHORITIES_API}/${uuid}`);
    if (!resp.ok() && resp.status() !== 204 && resp.status() !== 404) {
        const errBody = await resp.text();
        throw new Error(`Failed to delete authority ${uuid}: ${resp.status()} - ${errBody}`);
    }
}
