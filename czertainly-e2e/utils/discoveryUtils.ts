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

import { APIRequestContext } from '@playwright/test';
import { isTransientStatus, NOT_FOUND_GRACE_MS } from './certificateUtils';
import { Logger } from './Logger';

const logger = new Logger('DiscoveryUtils');

export interface WaitForDiscoveryOptions {
    /** The terminal state to wait for. Default { status: 'completed', connectorStatus: 'completed' }; a stop or a
     *  cancel waits for e.g. { status: 'stopped' } or { status: 'cancelled' } (connectorStatus then not checked). */
    expected?: { status: string; connectorStatus?: string };
    /** Statuses (of `status` or `connectorStatus`) that end the wait at once. Default ['failed'], minus the expected one. */
    failOn?: string[];
    /** Poll intervals in ms; the last one repeats. Default [2000, 3000, 5000]. */
    intervals?: number[];
    /** A 404 within this many ms of the start is polled again (read-after-write, Q8); default 10 s, 0 = fail at once. */
    notFoundGraceMs?: number;
}

/**
 * Polls GET /api/v1/discoveries/{uuid} until `status` (and `connectorStatus`, when expected) reach the expected values.
 * Fails fast like waitForCertificateState: at once on a status in `failOn`, on a 404 after the read-after-write grace
 * (`notFoundGraceMs`, default 10 s, review Q8), on any other 4xx than 408 / 425 / 429, and on the third transient
 * answer in a row (5xx, 408, 425, 429); the error names both statuses and the elapsed time. Existing callers keep
 * working.
 */
export async function waitForDiscoveryCompletion(
    request: APIRequestContext,
    discoveryUuid: string,
    timeout: number = 60_000,
    opts: WaitForDiscoveryOptions = {},
): Promise<void> {
    const expected = opts.expected ?? { status: 'completed', connectorStatus: 'completed' };
    const failOn = (opts.failOn ?? ['failed']).filter((s) => s !== expected.status && s !== expected.connectorStatus);
    const intervals = opts.intervals?.length ? opts.intervals : [2000, 3000, 5000];
    const graceMs = opts.notFoundGraceMs ?? NOT_FOUND_GRACE_MS;
    logger.info(`Waiting for discovery ${discoveryUuid} to reach ${JSON.stringify(expected)} (timeout ${timeout}ms)`);
    const startedAt = Date.now();
    const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)} s`;
    let serverErrors = 0;
    let last: { status?: string; connectorStatus?: string } = {};

    for (let attempt = 0; ; attempt++) {
        const resp = await request.get(`/api/v1/discoveries/${discoveryUuid}`);
        const httpStatus = resp.status();
        if (isTransientStatus(httpStatus)) {
            serverErrors++;
            logger.warn(`Discovery ${discoveryUuid} poll got status ${httpStatus} (${serverErrors} transient in a row)`);
            if (serverErrors >= 3) {
                throw new Error(`Discovery ${discoveryUuid}: ${serverErrors} consecutive ${httpStatus} answers; last ${JSON.stringify(last)} after ${elapsed()}`);
            }
        } else if (httpStatus === 404 && Date.now() - startedAt < graceMs) {
            serverErrors = 0;
            logger.warn(`Discovery ${discoveryUuid} not found yet (404 within the ${graceMs} ms read-after-write grace); polling on`);
        } else if (!resp.ok()) {
            throw new Error(`Discovery ${discoveryUuid}: GET answered ${httpStatus} (${(await resp.text()).slice(0, 200)}) after ${elapsed()}`);
        } else {
            serverErrors = 0;
            const data = (await resp.json()) as { status?: string; connectorStatus?: string };
            last = { status: data.status, connectorStatus: data.connectorStatus };
            const done = last.status === expected.status &&
                (expected.connectorStatus === undefined || last.connectorStatus === expected.connectorStatus);
            if (done) break;
            const bad = [last.status, last.connectorStatus].find((s) => s !== undefined && failOn.includes(s));
            if (bad) {
                throw new Error(`Discovery ${discoveryUuid} reached "${bad}" instead of ${JSON.stringify(expected)}: ${JSON.stringify(last)} after ${elapsed()}`);
            }
        }
        const remaining = timeout - (Date.now() - startedAt);
        if (remaining <= 0) {
            throw new Error(`Discovery ${discoveryUuid} did not reach ${JSON.stringify(expected)} within ${timeout}ms; last ${JSON.stringify(last)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(intervals[Math.min(attempt, intervals.length - 1)], remaining)));
    }

    logger.info(`Discovery ${discoveryUuid} reached ${JSON.stringify(expected)}`);
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
