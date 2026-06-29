/**
 * connectorUtils — wrapper around CZERTAINLY Core /api/v1/connectors and /api/v2/connectors.
 *
 * Provides:
 *  - getAllConnectors / findConnectorByName — read helpers
 *  - registerConnector — probe + register (auto-detects v1/v2 from connector's own advertisement)
 *  - ensureConnectorRegistered — idempotent: returns existing or registers + approves;
 *    reports whether THIS call did the registration (so teardown only deletes its own)
 *  - deleteConnector — best-effort delete
 *  - approveConnector / checkConnectorHealth — small helpers
 */

import { APIRequestContext } from '@playwright/test';
import { Logger } from './Logger';

const logger = new Logger('ConnectorUtils');

const CONNECTORS_API = '/api/v1/connectors';
const CONNECTORS_API_V2 = '/api/v2/connectors';

export interface ConnectorDto {
    uuid: string;
    name: string;
    url: string;
    status: string;
    authType: string;
}

export async function getAllConnectors(
    request: APIRequestContext
): Promise<ConnectorDto[]> {
    logger.info(`Listing all connectors`);
    const response = await request.get(CONNECTORS_API);
    if (!response.ok()) {
        logger.error(`Failed to list connectors: ${response.status()} ${response.statusText()}`);
        throw new Error(`Failed to list connectors: ${response.status()} ${response.statusText()}`);
    }
    const json = await response.json();

    return json as ConnectorDto[];
}

export async function findConnectorByName(
    request: APIRequestContext,
    name: string
): Promise<ConnectorDto> {
    const connectors = await getAllConnectors(request);
    const found = connectors.find(c => c.name === name);
    if (!found) {
        const available = connectors.map(c => c.name).join(', ');
        logger.error(`Connector "${name}" not found. Available: ${available}`);
        throw new Error(`Connector "${name}" not found. Available: ${available}`);
    }
    return found;
}

export async function registerConnector(
    request: APIRequestContext,
    options: { name: string; url: string; authType?: string },
): Promise<ConnectorDto> {
    const authType = options.authType ?? 'none';
    logger.info(`Probing connector "${options.name}" at ${options.url}`);

    // Step 1: probe — Core validates the URL and discovers what version(s) the connector advertises.
    // The UI sends this before POST /connectors; skipping it makes the register call return 500.
    const probeResp = await request.post(`${CONNECTORS_API_V2}/connect`, {
        data: { url: options.url, authType, authAttributes: [] },
    });
    if (!probeResp.ok()) {
        const error = await probeResp.text();
        throw new Error(`Connector probe failed for "${options.name}" at ${options.url}: ${probeResp.status()} - ${error}`);
    }
    const advertised = await probeResp.json() as Array<{ version: string }>;
    if (!Array.isArray(advertised) || advertised.length === 0 || !advertised[0].version) {
        throw new Error(`Connector "${options.name}" probe returned no version info`);
    }
    const version = advertised[0].version;

    // Step 2: register using the version advertised by the connector itself.
    logger.info(`Registering connector "${options.name}" (version: ${version})`);
    const response = await request.post(CONNECTORS_API_V2, {
        data: {
            name: options.name,
            url: options.url,
            authType,
            authAttributes: [],
            customAttributes: [],
            version,
        },
    });
    if (!response.ok()) {
        const error = await response.text();
        logger.error(`Failed to register connector "${options.name}": ${response.status()} - ${error}`);
        throw new Error(`Failed to register connector "${options.name}": ${response.status()} - ${error}`);
    }
    return await response.json() as ConnectorDto;
}

export interface EnsureConnectorResult {
    connector: ConnectorDto;
    /** True if THIS run registered the connector; false if it pre-existed. */
    registered: boolean;
}

export async function ensureConnectorRegistered(
    request: APIRequestContext,
    options: { name: string; url: string },
): Promise<EnsureConnectorResult> {
    const connectors = await getAllConnectors(request);
    const existing = connectors.find(c => c.name === options.name);
    if (existing) {
        logger.info(`Connector "${options.name}" already registered (uuid: ${existing.uuid})`);
        return { connector: existing, registered: false };
    }
    logger.info(`Connector "${options.name}" not registered — registering`);
    const registered = await registerConnector(request, options);
    // Approve only if Core left the connector in WAITING_FOR_APPROVAL.
    // Some Core versions auto-connect on register; approving a Connected one returns 422.
    if (registered.status === 'waitingForApproval' || registered.status === 'WAITING_FOR_APPROVAL') {
        await approveConnector(request, registered.uuid);
    }
    return { connector: registered, registered: true };
}

export async function deleteConnector(
    request: APIRequestContext,
    uuid: string,
): Promise<void> {
    logger.info(`Deleting connector: ${uuid}`);
    const resp = await request.delete(`${CONNECTORS_API}/${uuid}`);
    if (!resp.ok() && resp.status() !== 204 && resp.status() !== 404) {
        const error = await resp.text();
        logger.error(`Failed to delete connector ${uuid}: ${resp.status()} - ${error}`);
        throw new Error(`Failed to delete connector: ${resp.status()} - ${error}`);
    }
}

export async function approveConnector(
    request: APIRequestContext,
    uuid: string
): Promise<void> {
    logger.info(`Approving connector: ${uuid}`);
    const response = await request.put(`${CONNECTORS_API}/${uuid}/approve`);

    if (!response.ok() && response.status() !== 204) {
        const error = await response.text();
        logger.error(`Failed to approve connector ${uuid}: ${response.status()} - ${error}`);
        throw new Error(`Failed to approve connector: ${response.status()} - ${error}`);
    }
}

export async function checkConnectorHealth(
    request: APIRequestContext,
    uuid: string
): Promise<void> {
    logger.info(`Checking health of connector: ${uuid}`);
    const response = await request.get(`${CONNECTORS_API}/${uuid}/health`);

    if (!response.ok()) {
        const error = await response.text();
        logger.error(`Connector health check failed for ${uuid}: ${response.status()} - ${error}`);
        throw new Error(`Connector health check failed: ${response.status()} - ${error}`);
    }

    const body = await response.json();
    if (body.status !== 'ok') {
        logger.error(`Connector ${uuid} is not healthy: ${JSON.stringify(body)}`);
        throw new Error(`Connector is not healthy: ${JSON.stringify(body)}`);
    }
}

