/**
 * certificateTeardownCalls — the three platform calls the certificate and discovery teardown handlers make.
 *
 * WHAT: `revokeThroughAuthority` (the v2 revoke of a certificate through its RA profile), `waitUntilRevoked` (poll the
 * certificate until its state is `revoked`) and `listNewlyDiscoveredInventoryUuids` (the inventory certificates a discovery
 * added as new).
 *
 * WHY: the run-end teardown belongs to the regression framework and depends on nothing in the smoke-era `utils/*Utils.ts`
 * modules; the calls it needs live here, next to the handlers that use them.
 *
 * HOW: plain requests with the context the handler was given (no guard: the handler's own-object check ran before). The
 * revoked wait is `waitForCertificateState` of `wait/certificateState.ts`, which fails fast instead of waiting out the
 * timeout and names the last state, the newest history entries and the elapsed time in its error.
 */
import type { APIRequestContext } from '@playwright/test';
import { Logger } from '../../Logger';
import { waitForCertificateState } from '../wait/certificateState';

const logger = new Logger('TeardownCertificate');

export interface RevokeThroughAuthority {
    authorityUuid: string;
    raProfileUuid: string;
    certUuid: string;
    /** X.509 CRL reason; defaults to "unspecified". */
    reason?: string;
}

/** `POST /v2/operations/authorities/{a}/raProfiles/{r}/certificates/{c}/revoke`; any answer but 2xx / 204 throws. */
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

/** Polls `GET /api/v1/certificates/{uuid}` until the state is `revoked` (the fail-fast rules of `waitForCertificateState`). */
export async function waitUntilRevoked(api: APIRequestContext, certUuid: string, timeoutMs: number): Promise<void> {
    await waitForCertificateState(api, certUuid, 'revoked', timeoutMs);
}

/**
 * Inventory UUIDs of the certificates this discovery added. `newlyDiscovered=true` leaves out certificates that were in the
 * inventory before the run: the discovery found them too, but they are not ours to delete. Pages are 1-based. Read it
 * before deleting the discovery: the delete drops this list but keeps the certificates.
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
