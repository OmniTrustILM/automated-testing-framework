/**
 * raProfileUtils — wrapper around CZERTAINLY Core RA Profile endpoints.
 *
 * Used by globalSetup to create an RA Profile under an existing Authority, and by
 * globalTeardown to delete it.
 *
 * createRaProfile does MULTIPLE HTTP calls:
 *   1. GET attribute schema for this Authority (per-Authority, not per-Connector)
 *   2. Pick End Entity Profile from schema's inline content[] by name
 *   3. POST callback to resolve Certificate Profile id (cascade: depends on EE Profile)
 *   4. POST callback to resolve Certification Authority id (cascade: depends on EE Profile)
 *   5. POST the RA Profile payload — 7 attributes (3 object FKs + 2 boolean + 2 string)
 *
 * After create the RA Profile is DISABLED; caller must call enableRaProfile.
 */

import { APIRequestContext } from '@playwright/test';
import { Logger } from './Logger';
import {
  AttributeRequest,
  stringAttr,
  booleanAttr,
  objectAttr,
} from './attributeTypes';

const logger = new Logger('RaProfileUtils');

export interface RaProfileDto {
  uuid: string;
  name: string;
}

export interface CreateRaProfileOptions {
  name: string;
  authorityUuid: string;            // UUID of the Core Authority
  endEntityProfileName: string;     // e.g. from env
  certificateProfileName: string;   // e.g. from env
  caName: string;                   // e.g. from env
  usernamePrefix: string;           // we'll pass 'atf-'
}

// Local type — shape of one entry in the RA Profile schema response.
// Loose typing intentionally: content shape and callback shape vary across attribute types.
interface SchemaAttribute {
    uuid: string;
    name: string;
    contentType: string;
    content?: Array<{ data: any; reference?: string }>;
    attributeCallback?: {
        callbackContext: string;
        callbackMethod: string;
        mappings: Array<{
            to: string;
            targets: string[];
            from?: string;
            value?: string;
        }>;
    };
}

export async function createRaProfile(
    request: APIRequestContext,
    options: CreateRaProfileOptions,
): Promise<RaProfileDto> {
    logger.info(`Creating RA Profile: ${options.name}`);

    // Step 1: fetch schema (per-Authority endpoint)
    const schemaUrl = `/api/v1/authorities/${options.authorityUuid}/attributes/raProfile`;
    const schemaResp = await request.get(schemaUrl);
    if (!schemaResp.ok()) {
        const errBody = await schemaResp.text();
        throw new Error(`Failed to fetch RA Profile schema: ${schemaResp.status()} - ${errBody}`);
    }
    const schema = await schemaResp.json() as SchemaAttribute[];

    // Helper: locate schema entry by attribute name
    const schemaOf = (name: string): SchemaAttribute => {
        const attr = schema.find(a => a.name === name);
        if (!attr) {
            throw new Error(`Attribute "${name}" not in RA Profile schema`);
        }
        return attr;
    };

    // Step 2: find EE Profile from inline content[] (no callback needed for it)
    const eeSchema = schemaOf('endEntityProfile');
    const eeOption = eeSchema.content?.find(c => c.data?.name === options.endEntityProfileName);
    if (!eeOption) {
        const available = (eeSchema.content || []).map(c => c.data?.name).join(', ');
        throw new Error(`End Entity Profile "${options.endEntityProfileName}" not found. Available: ${available}`);
    }
    const eeId = eeOption.data.id as number;

    // Helper: extract literal authorityId from schema callback mappings.
    // Core pre-fills this with the connector-side authority instance UUID.
    const extractAuthorityId = (attr: SchemaAttribute): string => {
        const mapping = attr.attributeCallback?.mappings.find(m => m.to === 'authorityId' && m.value);
        if (!mapping?.value) {
            throw new Error(`No authorityId mapping in callback for "${attr.name}"`);
        }
        return mapping.value;
    };

    // Helper: POST a callback and find the option by name in the response
    const resolveCallback = async (
        attr: SchemaAttribute,
        valueName: string,
    ): Promise<{ id: number; name: string }> => {
        const callbackUrl = `/api/v1/raProfiles/${options.authorityUuid}/callback`;
        const callbackBody = {
            uuid: attr.uuid,
            name: attr.name,
            pathVariable: {
                authorityId: extractAuthorityId(attr),
                endEntityProfileId: eeId,
            },
            requestParameter: {}, body: {}, filter: {},
        };
        const resp = await request.post(callbackUrl, { data: callbackBody });
        if (!resp.ok()) {
            const errBody = await resp.text();
            throw new Error(`Callback for "${attr.name}" failed: ${resp.status()} - ${errBody}`);
        }
        const opts = await resp.json() as Array<{ data: { id: number; name: string } }>;
        const found = opts.find(o => o.data.name === valueName);
        if (!found) {
            const available = opts.map(o => o.data.name).join(', ');
            throw new Error(`"${valueName}" not in ${attr.name} callback. Available: ${available}`);
        }
        return found.data;
    };

    // Steps 3 & 4: resolve cascading options via callbacks
    const certProfile = await resolveCallback(schemaOf('certificateProfile'), options.certificateProfileName);
    const ca = await resolveCallback(schemaOf('certificationAuthority'), options.caName);

    // Step 5: build payload (7 attributes — usernamePostfix omitted as optional)
    const attributes: AttributeRequest[] = [
        objectAttr('endEntityProfile', eeSchema.uuid, eeId, options.endEntityProfileName),
        objectAttr('certificateProfile', schemaOf('certificateProfile').uuid, certProfile.id, certProfile.name),
        objectAttr('certificationAuthority', schemaOf('certificationAuthority').uuid, ca.id, ca.name),
        booleanAttr('sendNotifications', schemaOf('sendNotifications').uuid, false),
        booleanAttr('keyRecoverable', schemaOf('keyRecoverable').uuid, false),
        stringAttr('usernameGenMethod', schemaOf('usernameGenMethod').uuid, 'CN'),
        stringAttr('usernamePrefix', schemaOf('usernamePrefix').uuid, options.usernamePrefix),
    ];

    // Step 6: POST create
    const createUrl = `/api/v1/authorities/${options.authorityUuid}/raProfiles`;
    const resp = await request.post(createUrl, {
        data: { name: options.name, description: '', attributes, customAttributes: [] },
    });
    if (!resp.ok()) {
        const errBody = await resp.text();
        throw new Error(`Failed to create RA Profile: ${resp.status()} - ${errBody}`);
    }

    const { uuid } = await resp.json() as { uuid: string };
    logger.info(`RA Profile created: ${options.name} (uuid: ${uuid})`);
    return { uuid, name: options.name };
}

export async function enableRaProfile(
    request: APIRequestContext,
    authorityUuid: string,
    raProfileUuid: string,
): Promise<void> {
    logger.info(`Enabling RA Profile: ${raProfileUuid}`);
    const url = `/api/v1/authorities/${authorityUuid}/raProfiles/${raProfileUuid}/enable`;
    const resp = await request.patch(url);
    if (!resp.ok() && resp.status() !== 204) {
        const errBody = await resp.text();
        throw new Error(`Failed to enable RA Profile ${raProfileUuid}: ${resp.status()} - ${errBody}`);
    }
}

export async function deleteRaProfile(
    request: APIRequestContext,
    authorityUuid: string,
    raProfileUuid: string,
): Promise<void> {
    logger.info(`Deleting RA Profile: ${raProfileUuid}`);
    const url = `/api/v1/authorities/${authorityUuid}/raProfiles/${raProfileUuid}`;
    const resp = await request.delete(url);
    if (!resp.ok() && resp.status() !== 204 && resp.status() !== 404) {
        const errBody = await resp.text();
        throw new Error(`Failed to delete RA Profile ${raProfileUuid}: ${resp.status()} - ${errBody}`);
    }
}
