/**
 * discoveryUtils — API-based wait helpers for the network discovery flow (SMK-003).
 *
 * Replaces the page.reload()-based polling in DiscoveryPage.waitForCompletion
 * with direct backend polling — faster and avoids UI render races.
 *
 * GET /api/v1/discoveries/{uuid} returns a discovery object with two status
 * fields that both flip to "completed" when done: status (overall) and
 * connectorStatus (connector-side).
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
