/**
 * epicAuthorityMetadata — helpers of the Epic ilm#658 tests: an ACME authority on acme-connector whose connection check returns the
 * ACME account as authority metadata (`acmeAccountUrl`, `acmeAccountThumbprint`).
 * Account keys are EC P-256 keys stored as private-key secrets in a vault profile; the thumbprint is computed here (RFC 7638).
 */
import * as crypto from 'crypto';
import type { APIRequestContext } from '@playwright/test';
import { Json, send, sendOk, waitUntil } from './epicOwnership';
import { Logger } from './Logger';
import { ApiAnswer, answerOf } from './regression/apiReads';
import { AUTHORITY_CREATE_MS } from './regression/timeouts';

const logger = new Logger('EpicAuthorityMetadata');

export const LE_STAGING_DIRECTORY = 'https://acme-staging-v02.api.letsencrypt.org/directory';
/** A path on the same ACME server that answers 404, so the connection check fails. */
export const MISSING_DIRECTORY = 'https://acme-staging-v02.api.letsencrypt.org/no-such-directory';
export const ACCOUNT_URL = 'acmeAccountUrl';
export const ACCOUNT_THUMBPRINT = 'acmeAccountThumbprint';

/** acme-connector's authority attributes (internal/attr/uuids.go). */
const ATTR = {
    directoryUrl: { uuid: '617287bd-e0c3-4472-b253-13d70021c36e', name: 'data_directoryUrl' },
    accountKey: { uuid: '1fd1090d-73f8-4865-a430-67fa2ca6f34e', name: 'data_accountKey' },
    termsOfServiceAgreed: { uuid: 'fd615471-a634-4e2a-bc1b-92e4d516f2fc', name: 'data_termsOfServiceAgreed' },
} as const;

export interface AcmeConnector { uuid: string; name: string; interfaceUuid: string }
export interface AccountKey { uuid: string; name: string; pem: string; thumbprint: string }

/** The private key of a new EC P-256 account, PKCS#8 PEM. */
export function newAccountKeyPem(): string {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

/** RFC 7638 JWK thumbprint (SHA-256, base64url) of an EC or RSA key: a private or public key PEM, or a JWK. */
export function jwkThumbprint(key: string | crypto.JsonWebKeyInput): string {
    const jwk = crypto.createPublicKey(key).export({ format: 'jwk' }) as Record<string, string>;
    const members = jwk.kty === 'EC' ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y } : { e: jwk.e, kty: jwk.kty, n: jwk.n };
    return crypto.createHash('sha256').update(JSON.stringify(members)).digest('base64url');
}

/** The metadata items of one connector as name → first value, from an authority detail (`metadata` grouped by connector). */
export function metadataValues(detail: Json, connectorUuid: string): Record<string, unknown> {
    const group = ((detail.metadata ?? []) as Json[]).find((m) => m.connectorUuid === connectorUuid);
    const values: Record<string, unknown> = {};
    for (const item of (group?.items ?? []) as Json[]) values[String(item.name)] = (item.content as Json[] | undefined)?.[0]?.data;
    return values;
}

/** The number of metadata items named `name` across all connector groups. */
export function metadataCount(detail: Json, name: string): number {
    return ((detail.metadata ?? []) as Json[]).flatMap((m) => (m.items ?? []) as Json[]).filter((i) => i.name === name).length;
}

/** The connected connector named `name` (default: the first whose name contains "acme") with its v3 authority interface. */
export async function findAcmeConnector(api: APIRequestContext, name?: string): Promise<AcmeConnector | undefined> {
    const list = (await sendOk(api, 'GET', '/api/v1/connectors')).json as Json[];
    const rows = (list ?? []).filter((r) => r.status === 'connected' && (name ? r.name === name : /acme/i.test(String(r.name))));
    for (const row of rows) {
        const detail = (await sendOk(api, 'GET', `/api/v2/connectors/${row.uuid}`)).json as Json;
        const iface = ((detail?.interfaces ?? []) as Json[]).find((i) => i.code === 'authority' && i.version === 'v3');
        if (iface) return { uuid: String(row.uuid), name: String(row.name), interfaceUuid: String(iface.uuid) };
    }
    return undefined;
}

/** The first enabled vault profile (or the one named `name`) with its vault, to store account keys in. */
export async function findVaultProfile(api: APIRequestContext, name?: string): Promise<{ vaultUuid: string; profileUuid: string } | undefined> {
    const list = (await sendOk(api, 'POST', '/api/v1/vaultProfiles/list', { pageNumber: 1, itemsPerPage: 1000 })).json as Json;
    const row = ((list?.items ?? []) as Json[]).find((p) => p.enabled && (!name || p.name === name));
    return row ? { vaultUuid: String(row.vaultInstance?.uuid), profileUuid: String(row.uuid) } : undefined;
}

/**
 * Stores a new account key as an enabled private-key secret. `track` gets the secret as soon as it exists, so a failed activation still
 * leaves it to the caller's cleanup.
 */
export async function createAccountKey(
    api: APIRequestContext, vault: { vaultUuid: string; profileUuid: string }, name: string, track: (key: AccountKey) => void,
): Promise<AccountKey> {
    const pem = newAccountKeyPem();
    const body = { name, description: 'ATF authority metadata', secret: { type: 'privateKey', content: pem }, attributes: [], customAttributes: [] };
    const created = (await sendOk(api, 'POST', `/api/v1/vaults/${vault.vaultUuid}/vaultProfiles/${vault.profileUuid}/secrets`, body)).json as Json;
    const key: AccountKey = { uuid: String(created.uuid), name, pem, thumbprint: jwkThumbprint(pem) };
    track(key);
    await waitUntil(async () => ((await send(api, 'GET', `/api/v1/secrets/${key.uuid}`)).json as Json)?.state === 'active', `secret ${name} active`);
    await sendOk(api, 'PATCH', `/api/v1/secrets/${key.uuid}/enable`);
    logger.info(`account key secret ${name} (${key.uuid}) ready`);
    return key;
}

/** Deletes a secret and its vault entry and waits until it is gone; Core removes it from the vault asynchronously. */
export async function deleteAccountKey(api: APIRequestContext, uuid: string): Promise<void> {
    const answer = await send(api, 'DELETE', `/api/v1/secrets/${uuid}?deleteInVaults=true`);
    if (answer.status !== 404 && (answer.status < 200 || answer.status >= 300)) {
        throw new Error(`DELETE secret ${uuid} answered ${answer.status}: ${answer.text.slice(0, 300)}`);
    }
    await waitUntil(async () => (await send(api, 'GET', `/api/v1/secrets/${uuid}`)).status === 404, `secret ${uuid} deleted`);
}

/** Creates (POST) or edits (PUT) an authority; the request waits for the connector's connection check. */
export async function saveAuthority(api: APIRequestContext, method: 'POST' | 'PUT', url: string, data: unknown): Promise<ApiAnswer> {
    const started = Date.now();
    return answerOf(await api.fetch(url, { method, data, timeout: AUTHORITY_CREATE_MS }), started);
}

const attr = (a: { uuid: string; name: string }, contentType: string, content: Json[]): Json =>
    ({ version: 'v3', uuid: a.uuid, name: a.name, contentType, content });

/** The v3 request attributes of an ACME authority: directory, account key, terms of service agreed; no challenge types. */
export function acmeAuthorityAttributes(directoryUrl: string, key: Pick<AccountKey, 'uuid' | 'name'>): Json[] {
    return [
        attr(ATTR.directoryUrl, 'string', [{ contentType: 'string', data: directoryUrl }]),
        attr(ATTR.accountKey, 'resource', [{ contentType: 'resource', reference: key.name, data: { uuid: key.uuid, name: key.name, resource: 'secrets' } }]),
        attr(ATTR.termsOfServiceAgreed, 'boolean', [{ contentType: 'boolean', data: true }]),
    ];
}

/** The value of an authority's request attribute by name, from its detail (`attributes`). */
export function attributeValue(detail: Json, name: string): unknown {
    const found = ((detail.attributes ?? []) as Json[]).find((a) => a.name === name);
    return (found?.content as Json[] | undefined)?.[0]?.data;
}
