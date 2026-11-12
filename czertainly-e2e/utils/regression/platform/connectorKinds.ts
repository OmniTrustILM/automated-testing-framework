/**
 * connectorKinds — which connectors a tier has, found by what they offer, and the shape of their detail.
 *
 * WHAT: `ConnectorSpec` names a connector by what it offers (interface version, function groups and kinds, v2 interfaces, an optional
 *       name hint); `findRegisteredConnector` reads the registry and returns the first registered connector that matches, whatever its
 *       state; `findVaultConnector` returns the connected HashiCorp Vault connector with a secret interface. `CONNECTOR_SPECS` holds the
 *       connectors of the platform the suite knows. The pure readers `groupsOf`, `interfaceCodes`, `featuresByInterface`, `detailShapeProblems`,
 *       `infoShapeProblems` and `inventoryLine` describe a connector detail without touching the tier.
 * WHY: the connector rows, the needs that skip a row when a connector is absent and the read-only probe of the main flow must all decide
 *      from the same answer, and a connector is never recognised by a hard-coded registration name alone.
 * HOW: every call is a GET (`GET /v1/connectors`, `GET /v2/connectors/{uuid}`); nothing is created or changed. A read that does not answer
 *      2xx is an error of the test, not a missing connector: only an answer that lists no matching connector means "absent".
 */
import type { APIRequestContext } from '@playwright/test';
import { apiJson } from '../apiReads';
import { isJsonObject, rowsOf, type JsonObject } from '../json';
import { connectorVersion, type ConnectorRow, type ConnectorVersion } from './connectorApi';

/** What a connector offers; every member that is set must match. */
export interface ConnectorSpec {
    /** The interface generation; undefined matches either. */
    version?: ConnectorVersion;
    /** A name hint, to tell connectors of one interface apart (the match is on the registered name). */
    name?: RegExp;
    /** Function group code → kinds that must all be offered (the group and kinds of the connector detail). */
    functionGroups?: Record<string, string[]>;
    /** v2 interface codes that must all be present. */
    interfaces?: string[];
}

/** The v2 interfaces every v2 connector offers for the platform to talk to it. */
export const V2_BASE_INTERFACES = ['info', 'health'] as const;

/** Function group code → its kinds, sorted, from a connector detail. */
export const groupsOf = (detail: JsonObject): Record<string, string[]> =>
    Object.fromEntries(rowsOf(detail.functionGroups).map((g) => [String(g.functionGroupCode ?? g.code), ((g.kinds ?? []) as string[]).slice().sort()]));

/** The v2 interface codes of a connector detail, lower-cased. */
export const interfaceCodes = (detail: JsonObject): string[] => rowsOf(detail.interfaces).map((i) => String(i.code ?? i.name ?? '').toLowerCase());

/** Interface code → the feature flags it lists (empty when the interface lists none). */
export function featuresByInterface(detail: JsonObject): Record<string, string[]> {
    return Object.fromEntries(rowsOf(detail.interfaces).map((i) => [String(i.code ?? i.name ?? '').toLowerCase(), Array.isArray(i.features) ? i.features.map(String) : []]));
}

/** True when the detail offers every group and kind of the spec. */
function hasGroups(detail: JsonObject, wanted: Record<string, string[]>): boolean {
    const groups = groupsOf(detail);
    return Object.entries(wanted).every(([code, kinds]) => !!groups[code] && kinds.every((k) => groups[code].includes(k)));
}

/** True when a registered connector matches the spec (pure; `detail` is its v2 detail, `version` the version read from it). */
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

/** The registry as rows (`GET /v1/connectors`); a read that does not answer 2xx throws. */
async function registry(api: APIRequestContext): Promise<ConnectorRow[]> {
    const rows = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/connectors');
    return rowsOf(rows).map((r) => ({ uuid: String(r.uuid), name: String(r.name), status: typeof r.status === 'string' ? r.status : undefined }));
}

/** The first registered connector (any status) that matches the spec, with its v2 detail, or undefined. */
export async function findRegisteredConnector(api: APIRequestContext, spec: ConnectorSpec): Promise<RegisteredConnector | undefined> {
    for (const row of await registry(api)) {
        if (spec.name && !spec.name.test(row.name)) continue;
        const v = await connectorVersion(api, row.uuid);
        if (!v.detail) continue;
        if (matchesSpec(spec, row, v.version, v.detail)) return { list: row, detail: v.detail };
    }
    return undefined;
}

/** The connectors the platform ships, by what they offer. */
export const CONNECTOR_SPECS: Record<'credential-v1' | 'ejbca' | 'adcs-v2' | 'network-discovery-v1' | 'network-discovery-v2' | 'software-cryptography-v1' | 'software-cryptography-v2', ConnectorSpec> = {
    'credential-v1': { version: 1, functionGroups: { credentialProvider: ['SoftKeyStore', 'Basic', 'ApiKey'] } },
    'ejbca': { name: /ejbca/i, functionGroups: { authorityProvider: ['EJBCA'] } },
    'adcs-v2': { version: 2, name: /adcs/i, interfaces: ['info', 'health', 'metrics', 'authority', 'attributes'] },
    'network-discovery-v1': { version: 1, functionGroups: { discoveryProvider: ['IP-Hostname'] } },
    'network-discovery-v2': { version: 2, name: /discovery/i, interfaces: ['info', 'health', 'discovery'] },
    'software-cryptography-v1': { version: 1, name: /software/i, functionGroups: { cryptographyProvider: ['SOFT'] } },
    'software-cryptography-v2': { version: 2, name: /software/i, interfaces: ['info', 'health', 'metrics', 'cryptography'] },
};

/** A connected HashiCorp Vault connector with a secret interface: where the secret rows can also run. */
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

// ------------------------------------------------------------------ the shape of a connector detail and of its info

/** What is wrong with the detail of a connector of this version (empty: it has the shape the platform relies on). */
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
 * What is wrong with the answer of `GET /v2/connectors/{uuid}/info` (empty: an object that names the connector and its version). The body is
 * the connector document itself or wraps it as `connector`; a list of interfaces, when present, is a list of `{ code, version }`.
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

/** One line that says what a connector offers: `v1 groups discoveryProvider[IP-Hostname]` or `v2 interfaces info, health, metrics(openMetrics)`. */
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
