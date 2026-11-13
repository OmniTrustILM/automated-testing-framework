/**
 * connectorKinds — which connectors a tier has, found by what they offer (never by registration name alone), and the shape of their detail;
 * GET only, a non-2xx read is a test error and only an empty match means "absent".
 */
import type { APIRequestContext } from '@playwright/test';
import { apiJson } from '../apiReads';
import { isJsonObject, rowsOf, type JsonObject } from '../json';
import { connectorVersion, type ConnectorRow, type ConnectorVersion } from './connectorApi';

export interface ConnectorSpec {
    version?: ConnectorVersion;
    name?: RegExp;
    functionGroups?: Record<string, string[]>;
    interfaces?: string[];
}

export const V2_BASE_INTERFACES = ['info', 'health'] as const;

export const groupsOf = (detail: JsonObject): Record<string, string[]> =>
    Object.fromEntries(rowsOf(detail.functionGroups).map((g) => [String(g.functionGroupCode ?? g.code), ((g.kinds ?? []) as string[]).slice().sort()]));

export const interfaceCodes = (detail: JsonObject): string[] => rowsOf(detail.interfaces).map((i) => String(i.code ?? i.name ?? '').toLowerCase());

export function featuresByInterface(detail: JsonObject): Record<string, string[]> {
    return Object.fromEntries(rowsOf(detail.interfaces).map((i) => [String(i.code ?? i.name ?? '').toLowerCase(), Array.isArray(i.features) ? i.features.map(String) : []]));
}

function hasGroups(detail: JsonObject, wanted: Record<string, string[]>): boolean {
    const groups = groupsOf(detail);
    return Object.entries(wanted).every(([code, kinds]) => !!groups[code] && kinds.every((k) => groups[code].includes(k)));
}

export function matchesSpec(spec: ConnectorSpec, row: Pick<ConnectorRow, 'name'>, version: ConnectorVersion | undefined, detail: JsonObject): boolean {
    if (spec.name && !spec.name.test(row.name)) return false;
    if (spec.version && version !== spec.version) return false;
    if (spec.functionGroups && !hasGroups(detail, spec.functionGroups)) return false;
    if (spec.interfaces) {
        const offered = interfaceCodes(detail);
        if (!spec.interfaces.every((c) => offered.includes(c))) return false;
    }
    return true;
}

export interface RegisteredConnector {
    list: ConnectorRow;
    detail: JsonObject;
}

async function registry(api: APIRequestContext): Promise<ConnectorRow[]> {
    const rows = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/connectors');
    return rowsOf(rows).map((r) => ({ uuid: String(r.uuid), name: String(r.name), status: typeof r.status === 'string' ? r.status : undefined }));
}

export async function findRegisteredConnector(api: APIRequestContext, spec: ConnectorSpec): Promise<RegisteredConnector | undefined> {
    for (const row of await registry(api)) {
        if (spec.name && !spec.name.test(row.name)) continue;
        const v = await connectorVersion(api, row.uuid);
        if (!v.detail) continue;
        if (matchesSpec(spec, row, v.version, v.detail)) return { list: row, detail: v.detail };
    }
    return undefined;
}

export const CONNECTOR_SPECS: Record<'credential-v1' | 'ejbca' | 'adcs-v2' | 'network-discovery-v1' | 'network-discovery-v2' | 'software-cryptography-v1' | 'software-cryptography-v2', ConnectorSpec> = {
    'credential-v1': { version: 1, functionGroups: { credentialProvider: ['SoftKeyStore', 'Basic', 'ApiKey'] } },
    'ejbca': { name: /ejbca/i, functionGroups: { authorityProvider: ['EJBCA'] } },
    'adcs-v2': { version: 2, name: /adcs/i, interfaces: ['info', 'health', 'metrics', 'authority', 'attributes'] },
    'network-discovery-v1': { version: 1, functionGroups: { discoveryProvider: ['IP-Hostname'] } },
    'network-discovery-v2': { version: 2, name: /discovery/i, interfaces: ['info', 'health', 'discovery'] },
    'software-cryptography-v1': { version: 1, name: /software/i, functionGroups: { cryptographyProvider: ['SOFT'] } },
    'software-cryptography-v2': { version: 2, name: /software/i, interfaces: ['info', 'health', 'metrics', 'cryptography'] },
};

export async function findVaultConnector(api: APIRequestContext): Promise<{ uuid: string; name: string; interfaceUuid: string } | undefined> {
    for (const row of await registry(api)) {
        if (row.status !== 'connected' || !/vault/i.test(row.name)) continue;
        const v = await connectorVersion(api, row.uuid);
        if (v.version !== 2 || !v.detail) continue;
        const secret = rowsOf(v.detail.interfaces).find((i) => /^secret/i.test(String(i.code ?? i.name ?? '')));
        if (secret) return { uuid: row.uuid, name: row.name, interfaceUuid: String(secret.uuid ?? secret.interfaceUuid) };
    }
    return undefined;
}


export function detailShapeProblems(version: ConnectorVersion, detail: JsonObject): string[] {
    const problems: string[] = [];
    const groups = rowsOf(detail.functionGroups);
    if (version === 1) {
        if (!groups.length) problems.push('a v1 connector lists no function group');
        for (const g of groups) if (!Array.isArray(g.kinds)) problems.push(`function group ${String(g.functionGroupCode ?? g.code)} lists no kinds array`);
        return problems;
    }
    const interfaces = rowsOf(detail.interfaces);
    const codes = interfaces.map((i) => String(i.code ?? '').toLowerCase());
    for (const code of V2_BASE_INTERFACES) if (!codes.includes(code)) problems.push(`a v2 connector does not offer the ${code} interface`);
    for (const i of interfaces) {
        if (typeof i.version !== 'string' || !i.version) problems.push(`interface ${String(i.code)} carries no version`);
        if (i.features !== undefined && i.features !== null && !Array.isArray(i.features)) problems.push(`interface ${String(i.code)} lists its features as something else than a list`);
    }
    const misplaced = Object.entries(featuresByInterface(detail)).filter(([code, list]) => code !== 'metrics' && list.includes('openMetrics')).map(([code]) => code);
    for (const code of misplaced) problems.push(`the openMetrics feature is listed on the ${code} interface, not on metrics`);
    return problems;
}

/**
 * What is wrong with the answer of `GET /v2/connectors/{uuid}/info` (empty: an object naming the connector and its version, possibly
 * wrapped as `connector`).
 */
export function infoShapeProblems(body: unknown): string[] {
    if (!isJsonObject(body)) return ['the info answer is not a JSON object'];
    const problems: string[] = [];
    const connector = isJsonObject(body.connector) ? body.connector : body;
    if (typeof connector.name !== 'string' || !connector.name) problems.push('the info names no connector');
    if (typeof connector.version !== 'string' || !connector.version) problems.push('the info carries no connector version');
    if (body.interfaces !== undefined) {
        if (!Array.isArray(body.interfaces)) problems.push('the info lists its interfaces as something else than a list');
        else for (const i of rowsOf(body.interfaces)) if (!i.code || !i.version) problems.push(`an info interface lacks its code or version (${JSON.stringify(i).slice(0, 80)})`);
    }
    return problems;
}

export function inventoryLine(name: string, version: ConnectorVersion | undefined, detail: JsonObject): string {
    if (version === 1) {
        const groups = Object.entries(groupsOf(detail)).map(([code, kinds]) => `${code}[${kinds.join(',')}]`);
        return `${name}: v1 function groups ${groups.join(' ') || '(none)'}`;
    }
    const features = featuresByInterface(detail);
    const interfaces = interfaceCodes(detail).map((c) => (features[c]?.length ? `${c}(${features[c].join(',')})` : c));
    const groups = Object.entries(groupsOf(detail)).map(([code, kinds]) => `${code}[${kinds.join(',')}]`);
    return `${name}: ${version ? `v${version}` : 'version unknown'} interfaces ${interfaces.join(', ') || '(none)'}${groups.length ? `; function groups ${groups.join(' ')}` : ''}`;
}
