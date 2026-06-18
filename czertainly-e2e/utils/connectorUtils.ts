import { APIRequestContext } from '@playwright/test';
import { Logger } from './Logger';

const logger = new Logger('ConnectorUtils');

const CONNECTORS_API = '/api/v1/connectors';

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

