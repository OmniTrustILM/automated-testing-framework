/**
 * certificateTeardownCalls — the revoke, wait-for-revoked and newly-discovered-certificates calls of the teardown handlers.
 * Plain requests with the handler's context (no guard: the handler checked ownership before).
 */
import type { APIRequestContext } from '@playwright/test';
import { Logger } from '../../Logger';
import { waitForCertificateState } from '../wait/certificateState';

const logger = new Logger('TeardownCertificate');

export interface RevokeThroughAuthority {
    authorityUuid: string;
    raProfileUuid: string;
    certUuid: string;
    reason?: string;
}

export async function revokeThroughAuthority(api: APIRequestContext, options: RevokeThroughAuthority): Promise<void> {
    const reason = options.reason || 'unspecified';
    logger.info(`Revoking certificate ${options.certUuid} (reason: ${reason})`);
    const url = `/api/v2/operations/authorities/${options.authorityUuid}/raProfiles/${options.raProfileUuid}/certificates/${options.certUuid}/revoke`;
    const resp = await api.post(url, { data: { reason, attributes: [] } });
    if (!resp.ok() && resp.status() !== 204) {
        const errBody = await resp.text();
        throw new Error(`Failed to revoke certificate ${options.certUuid}: ${resp.status()} - ${errBody}`);
    }
}

export async function waitUntilRevoked(api: APIRequestContext, certUuid: string, timeoutMs: number): Promise<void> {
    await waitForCertificateState(api, certUuid, 'revoked', timeoutMs);
}

/**
 * Inventory UUIDs of the certificates this discovery added as new (not ours to delete: the ones already in the inventory). Read it before
 * deleting the discovery.
 */
export async function listNewlyDiscoveredInventoryUuids(api: APIRequestContext, discoveryUuid: string): Promise<string[]> {
    const uuids: string[] = [];
    const itemsPerPage = 100;
    for (let pageNumber = 1; ; pageNumber++) {
        const resp = await api.get(`/api/v1/discoveries/${discoveryUuid}/certificates`, {
            params: { newlyDiscovered: true, itemsPerPage, pageNumber },
        });
        if (!resp.ok()) {
            throw new Error(`List certificates of discovery ${discoveryUuid} failed: ${resp.status()} - ${await resp.text()}`);
        }
        const body = await resp.json() as { certificates: Array<{ inventoryUuid?: string }>; totalPages: number };
        uuids.push(...body.certificates.flatMap((c) => (c.inventoryUuid ? [c.inventoryUuid] : [])));
        if (pageNumber >= body.totalPages) break;
    }
    logger.info(`Discovery ${discoveryUuid} added ${uuids.length} certificate(s) to the inventory`);
    return uuids;
}
