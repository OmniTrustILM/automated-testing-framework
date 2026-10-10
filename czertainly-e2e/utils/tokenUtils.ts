/**
 * tokenUtils — Token Instance and Token Profile on the Software Cryptography Provider, for SMK-006.
 *
 * WHAT: creates a new SOFT token with its own activation code, a Token Profile on it, and removes
 * both again (keys first, since a token with keys cannot go).
 *
 * WHY: a key can only be generated through a Token Profile, and a profile only exists on a token.
 * Both are preconditions for the test, not what it checks, so they go through the API: fast, and a
 * UI change on the token pages does not fail a test about keys.
 *
 * HOW: the provider reads three attributes for a new token: the action ("new"), the token's name
 * and its activation code. When it already holds tokens, its form first asks "new or existing",
 * so that choice is sent too. A Token Profile on this
 * provider takes no attributes. Deletes tolerate 404 so a cleanup that runs twice passes.
 *
 * The provider keeps its own copy of a removed token unless it runs with TOKEN_DELETE_ON_REMOVE;
 * that copy is outside the platform and outside what this cleanup can reach.
 */

import { APIRequestContext } from '@playwright/test';
import { AttributeRequest, stringAttr, secretAttr } from './attributeTypes';
import { Logger } from './Logger';

const logger = new Logger('TokenUtils');

async function ensureOk(resp: { ok(): boolean; status(): number; text(): Promise<string> }, what: string, allow: number[] = []) {
    if (resp.ok() || allow.includes(resp.status())) return;
    throw new Error(`${what} failed: ${resp.status()} - ${await resp.text()}`);
}

export interface TokenInstanceDto { uuid: string; name: string }

/**
 * Creates a new token on the provider. `name` must match the provider's rule: a letter first,
 * then letters, digits and single underscores, not ending with one.
 */
export async function createSoftTokenInstance(
    request: APIRequestContext,
    options: { connectorUuid: string; name: string; activationCode: string },
): Promise<TokenInstanceDto> {
    logger.info(`Creating token instance: ${options.name}`);

    // The connector's first form depends on whether it already holds tokens. Without any, it asks
    // for the new token's fields directly. With some, it asks "new or existing" (data_options) and
    // delivers the new token's fields through a callback. Either way the provider reads the same
    // three attributes, whose UUIDs are constants in its source (TokenInstanceAttributes).
    const schemaResp = await request.get(`/api/v1/tokens/${options.connectorUuid}/attributes`, { params: { kind: 'SOFT' } });
    await ensureOk(schemaResp, 'Read token attributes');
    const schema = await schemaResp.json() as Array<{ name: string; uuid: string }>;
    const optionsAttr = schema.find((a) => a.name === 'data_options');

    const attributes: AttributeRequest[] = [
        ...(optionsAttr
            ? [{ name: 'data_options', uuid: optionsAttr.uuid, version: 'v2' as const, contentType: 'string' as const,
                content: [{ reference: 'Create new Token', data: 'new' }] }]
            : []),
        stringAttr('data_createTokenAction', 'cc781ba3-d90b-4fe9-915a-e8d44e1cff86', 'new', true),
        stringAttr('data_newTokenName', '21a79858-a246-4b2a-93e1-1677c8beb6a4', options.name),
        secretAttr('data_tokenCode', '181aae19-d2a3-40ca-b5c7-570c8dfbb3cb', options.activationCode),
    ];

    const resp = await request.post('/api/v1/tokens', {
        data: { name: options.name, connectorUuid: options.connectorUuid, kind: 'SOFT', attributes, customAttributes: [] },
    });
    await ensureOk(resp, `Create token instance ${options.name}`);
    const token = await resp.json() as TokenInstanceDto;
    logger.info(`Token instance created: ${token.name} (uuid: ${token.uuid})`);
    return token;
}

export async function createTokenProfile(
    request: APIRequestContext,
    options: { tokenInstanceUuid: string; name: string },
): Promise<{ uuid: string; name: string }> {
    logger.info(`Creating token profile: ${options.name}`);
    const resp = await request.post(`/api/v1/tokens/${options.tokenInstanceUuid}/tokenProfiles`, {
        data: {
            name: options.name,
            description: 'SMK-006 smoke — created and removed by the run',
            attributes: [],
            customAttributes: [],
            enabled: true,
            usage: ['sign', 'verify'],
        },
    });
    await ensureOk(resp, `Create token profile ${options.name}`);
    const profile = await resp.json() as { uuid: string; name: string };
    logger.info(`Token profile created: ${profile.name} (uuid: ${profile.uuid})`);
    return profile;
}

export async function deleteTokenProfile(
    request: APIRequestContext,
    options: { tokenInstanceUuid: string; uuid: string },
): Promise<void> {
    logger.info(`Deleting token profile: ${options.uuid}`);
    await ensureOk(await request.delete(`/api/v1/tokens/${options.tokenInstanceUuid}/tokenProfiles/${options.uuid}`),
        `Delete token profile ${options.uuid}`, [404]);
}

export async function deleteTokenInstance(request: APIRequestContext, uuid: string): Promise<void> {
    logger.info(`Deleting token instance: ${uuid}`);
    await ensureOk(await request.delete(`/api/v1/tokens/${uuid}`), `Delete token instance ${uuid}`, [404]);
}

/** UUIDs of the keys held on a token, found through the key list (which lists key items). */
export async function listKeyUuidsOnToken(request: APIRequestContext, tokenInstanceUuid: string): Promise<string[]> {
    const resp = await request.post('/api/v1/keys', { data: { itemsPerPage: 100, pageNumber: 1, filters: [] } });
    await ensureOk(resp, 'List keys');
    const items = ((await resp.json()) as { cryptographicKeys: Array<{ keyWrapperUuid: string; tokenInstanceUuid?: string }> })
        .cryptographicKeys;
    return [...new Set(items.filter((k) => k.tokenInstanceUuid === tokenInstanceUuid).map((k) => k.keyWrapperUuid))];
}
