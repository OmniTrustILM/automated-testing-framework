/**
 * keyUtils — finds and removes the public-key entries the platform adds with a certificate.
 *
 * WHAT: reads which Key a certificate is linked to, and deletes such a Key once nothing else
 * uses it.
 *
 * WHY: when a certificate enters the inventory (upload, discovery, issuance), core links it to a
 * Key with the same public key, and creates one named `certKey_<CN>` if none exists. Deleting the
 * certificate leaves that Key behind. Cleanup used to "select all" on the Keys page instead, and
 * with two workers it took keys that belonged to another test.
 *
 * HOW: a Key is removed only when it is ours beyond doubt: no token instance (a bare public key,
 * not one held in a token), created after our test began, and no associations left once our
 * certificate is gone. Anything else is left in place.
 */

import { APIRequestContext } from '@playwright/test';
import { Logger } from './Logger';

const logger = new Logger('KeyUtils');

/**
 * UUID of the Key the certificate is linked to, or undefined when it has none. This is the Key's
 * own UUID, which the key endpoints take. The key list (POST /api/v1/keys) shows each item's UUID
 * in `uuid` and the Key's in `keyWrapperUuid`: with an item UUID, GET answers 404 and the bulk
 * DELETE answers 204 without removing anything.
 */
export async function getCertificateKeyUuid(request: APIRequestContext, certUuid: string): Promise<string | undefined> {
    const resp = await request.get(`/api/v1/certificates/${certUuid}`);
    if (resp.status() === 404) return undefined;
    if (!resp.ok()) {
        throw new Error(`Get certificate ${certUuid} failed: ${resp.status()} - ${await resp.text()}`);
    }
    const body = await resp.json() as { key?: { uuid?: string } };
    return body.key?.uuid;
}

/**
 * Deletes the Key if it is a bare public key created at or after `createdAfter` that no object
 * references any more. Returns whether it was deleted; a Key that is gone already counts as done.
 */
export async function deleteKeyIfOrphaned(
    request: APIRequestContext,
    keyUuid: string,
    createdAfter: Date,
): Promise<boolean> {
    const resp = await request.get(`/api/v1/keys/${keyUuid}`);
    if (resp.status() === 404) return true;
    if (!resp.ok()) {
        throw new Error(`Get key ${keyUuid} failed: ${resp.status()} - ${await resp.text()}`);
    }
    const key = await resp.json() as {
        name: string;
        tokenInstanceUuid?: string;
        creationTime?: string;
        associations?: unknown[];
    };

    const createdByUs = key.creationTime !== undefined && new Date(key.creationTime) >= createdAfter;
    const stillUsed = (key.associations?.length ?? 0) > 0;
    if (key.tokenInstanceUuid || !createdByUs || stillUsed) {
        logger.info(`Keeping key ${key.name} (${keyUuid}): ` +
            `token=${key.tokenInstanceUuid ?? '-'} created=${key.creationTime ?? '-'} associations=${key.associations?.length ?? 0}`);
        return false;
    }

    logger.info(`Deleting key ${key.name} (${keyUuid})`);
    const del = await request.delete('/api/v1/keys', { data: [keyUuid] });
    if (!del.ok() && del.status() !== 404) {
        throw new Error(`Delete key ${keyUuid} failed: ${del.status()} - ${await del.text()}`);
    }
    // The bulk delete answers 204 even for a key it skipped (one still in use, for instance), so
    // only a 404 afterwards proves the key is gone. Throwing lets the cleanup ledger name it.
    for (let attempt = 0; attempt < 5; attempt++) {
        if ((await request.get(`/api/v1/keys/${keyUuid}`)).status() === 404) return true;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Delete key ${keyUuid} answered ${del.status()} but the key is still there`);
}
