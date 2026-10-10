/**
 * discoveryUtils — API-based wait helpers for the network discovery flow (SMK-003).
 *
 * Replaces the page.reload()-based polling in DiscoveryPage.waitForCompletion
 * with direct backend polling — faster and avoids UI render races.
 *
 * GET /api/v1/discoveries/{uuid} returns a discovery object with two status
 * fields that both flip to "completed" when done: status (overall) and
 * connectorStatus (connector-side).
 *
 * Also the API side of SMK-003's cleanup: which inventory certificates a discovery
 * added, and deleting the discovery itself. Cleanup must name its own objects by UUID —
 * a "select all" in the UI also takes whatever a test on the other worker created.
 */

import { APIRequestContext, expect } from '@playwright/test';
import { Logger } from './Logger';

const logger = new Logger('DiscoveryUtils');

export async function waitForDiscoveryCompletion(
    request: APIRequestContext,
    discoveryUuid: string,
    timeout: number = 60_000,
): Promise<void> {
    logger.info(`Waiting for discovery ${discoveryUuid} to complete (timeout ${timeout}ms)`);

    await expect.poll(async () => {
        const resp = await request.get(`/api/v1/discoveries/${discoveryUuid}`);
        if (!resp.ok()) {
            logger.warn(`Discovery ${discoveryUuid} poll got status ${resp.status()}`);
            return null;
        }
        const data = await resp.json();
        return { status: data.status, connectorStatus: data.connectorStatus };
    }, {
        message: `Discovery ${discoveryUuid} did not complete within ${timeout}ms`,
        timeout,
        intervals: [2000, 3000, 5000],
    }).toEqual({ status: 'completed', connectorStatus: 'completed' });

    logger.info(`Discovery ${discoveryUuid} completed`);
}

/**
 * Inventory UUIDs of the certificates this discovery added. `newlyDiscovered=true` leaves out
 * certificates that were in the inventory before the run: the discovery found them too, but
 * they are not ours to delete. Pages are 1-based.
 *
 * Read it before deleting the discovery — the delete drops this list but keeps the certificates.
 */
export async function listNewlyDiscoveredInventoryUuids(
    request: APIRequestContext,
    discoveryUuid: string,
): Promise<string[]> {
    const uuids: string[] = [];
    const itemsPerPage = 100;
    for (let pageNumber = 1; ; pageNumber++) {
        const resp = await request.get(`/api/v1/discoveries/${discoveryUuid}/certificates`, {
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

/** Deletes the discovery and its history. 404 counts as done, so a repeated cleanup passes. */
export async function deleteDiscovery(request: APIRequestContext, discoveryUuid: string): Promise<void> {
    logger.info(`Deleting discovery: ${discoveryUuid}`);
    const resp = await request.delete(`/api/v1/discoveries/${discoveryUuid}`);
    if (!resp.ok() && resp.status() !== 404) {
        throw new Error(`Delete discovery ${discoveryUuid} failed: ${resp.status()} - ${await resp.text()}`);
    }
}
