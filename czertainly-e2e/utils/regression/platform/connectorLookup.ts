/**
 * connectorLookup — read-only lookup of the connectors the platform specs build on.
 *
 * WHAT: finds the connectors the platform specs build on, read-only: the secret-interface connector of a
 *       vault (named by env, else the credential provider v2, else any connected one with the interface) and the v1 credential
 *       connector for a credential kind. Nothing is created or changed here.
 * WHY: A vault or credential spec must find its connector or skip with a named reason.
 * HOW: Chooses the secret-interface connector (env name, else the credential provider v2, else any connected one with the interface) and the v1 credential connector for a kind; nothing is created.
 */
import type { APIRequestContext } from '@playwright/test';
import { apiJson } from '../apiReads';
import type { JsonObject } from '../json';
import { settings } from '../run/settings';

/** The chart's registration name of the credential provider's v2 record (the default secret-interface connector); the registered name differs between tiers by a space or a hyphen before `v2`. */
const DEFAULT_SECRET_CONNECTOR_RE = /^Common-Credential-Connector[ -]v2$/i;

/**
 * The first connected connector whose v2 interfaces include a code matching `code` (e.g. /^secret/i): the one named by
 * `settings(env).secretConnector`, else the credential provider v2 (`DEFAULT_SECRET_CONNECTOR_RE`), else the first connected one with the interface.
 */
export async function findConnectorWithInterface(api: APIRequestContext, code: RegExp, env: NodeJS.ProcessEnv = process.env): Promise<{ uuid: string; name: string; interfaceUuid: string } | undefined> {
    const rows = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/connectors');
    const named = settings(env).secretConnector;
    // The provider is matched by what it IS, not by one display name (seen on a live tier: "Common-Credential-Connector v2" with a space
    // missed the hyphenated default and the first connected connector with a secret interface won): the named one, the credential
    // provider v2 by either spelling, then any connector with a credentialProvider function group, then the other connected ones.
    const isCredentialProvider = (r: JsonObject): boolean => ((r.functionGroups ?? []) as JsonObject[]).some((g: JsonObject) => g.functionGroupCode === 'credentialProvider' || g.code === 'credentialProvider');
    const picked = new Set<string>();
    const ordered: JsonObject[] = [];
    const take = (pred: (r: JsonObject) => boolean): void => { for (const r of rows) if (pred(r) && !picked.has(String(r.uuid))) { picked.add(String(r.uuid)); ordered.push(r); } };
    if (named) take((r) => r.name === named);
    take((r) => DEFAULT_SECRET_CONNECTOR_RE.test(String(r.name)));
    take((r) => r.status === 'connected' && isCredentialProvider(r));
    take((r) => r.status === 'connected');
    for (const r of ordered) {
        const res = await api.get(`/api/v2/connectors/${r.uuid}`);
        if (!res.ok()) continue;
        const detail = (await res.json()) as JsonObject;
        const iface = ((detail.interfaces ?? []) as JsonObject[]).find((i) => code.test(String(i.code ?? i.name ?? '')));
        if (iface) return { uuid: String(r.uuid), name: String(r.name), interfaceUuid: String(iface.uuid ?? iface.interfaceUuid) };
    }
    return undefined;
}

/** The first connected v1 connector offering a credential kind (`credentialProvider` / `Basic`). */
export async function findCredentialConnector(api: APIRequestContext, kind = 'Basic', env: NodeJS.ProcessEnv = process.env): Promise<{ uuid: string; name: string } | undefined> {
    const rows = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/connectors');
    const wanted = settings(env).credentialConnector;
    const ordered = [...rows.filter((r) => r.name === wanted), ...rows.filter((r) => r.name !== wanted)];
    const row = ordered.find((r) => r.status === 'connected'
        && ((r.functionGroups ?? []) as JsonObject[]).some((g) => (g.functionGroupCode === 'credentialProvider' || g.code === 'credentialProvider') && ((g.kinds ?? []) as string[]).includes(kind)));
    return row ? { uuid: String(row.uuid), name: String(row.name) } : undefined;
}
