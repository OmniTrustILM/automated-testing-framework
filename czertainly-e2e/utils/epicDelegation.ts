/**
 * epicDelegation — helpers of the Epic ilm#486 tests (RFC 8693 delegation tokens, scenarios of
 * automated-testing-framework#118): a disposable Keycloak realm with a real token exchange, test-signed tokens,
 * the run's own OAuth2 provider, and the audit log.
 *
 * Every call that carries a bearer token of the delegation tests goes through Node's fetch, not through Playwright,
 * so no token reaches a trace, a report or a Testkube artifact. Errors name the status only, never a body that could
 * echo a token.
 */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { APIRequestContext } from '@playwright/test';
import { Json, send, sendOk } from './epicOwnership';

/** Settings changes reach every Core instance through its scheduled refresh (30 s by default), plus a margin. */
export const SETTINGS_SPREAD_MS = 40_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until a settings change has reached every Core instance; a refusal cannot be polled for, an old provider also refuses. */
export const settingsSpread = (): Promise<void> => sleep(SETTINGS_SPREAD_MS);

async function http(url: string, init: RequestInit = {}, ok: number[] = [200, 201, 204]): Promise<{ status: number; body: Buffer }> {
    let response: Response;
    try {
        response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    } catch {
        throw new Error(`${init.method ?? 'GET'} ${new URL(url).pathname}: transport failed (details withheld)`);
    }
    if (!ok.includes(response.status)) throw new Error(`${init.method ?? 'GET'} ${new URL(url).pathname} answered ${response.status} (body withheld)`);
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
}

async function json<T = Json>(url: string, init: RequestInit = {}): Promise<T> {
    const { body } = await http(url, init);
    try {
        return JSON.parse(body.toString()) as T;
    } catch {
        throw new Error(`${new URL(url).pathname}: not JSON (body withheld)`);
    }
}

/** The claims of a JWT, read without checking it. */
export function claims(token: string): Json {
    try {
        return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as Json;
    } catch {
        throw new Error('not a JWT (contents withheld)');
    }
}

// ---------------------------------------------------------------------------------------------------------------- tokens

/**
 * A key pair that lives only in this process, and tokens signed with it. Mint tokens only for the run's own users:
 * a provider that trusts this key accepts a token for any existing ILM user name.
 */
export interface Signer {
    issuer: string;
    /** The public key as an inline JWK set (base64 of the JSON), for a provider's `jwkSet`. */
    jwkSet: string;
    token(username: string, act?: unknown): string;
}

export function newSigner(issuer: string, audience: string): Signer {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = randomUUID();
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
    return {
        issuer,
        jwkSet: Buffer.from(JSON.stringify({ keys: [jwk] })).toString('base64'),
        token(username, act) {
            const now = Math.floor(Date.now() / 1000);
            const payload: Json = {
                iss: issuer, sub: randomUUID(), username, aud: audience, iat: now, nbf: now - 1, exp: now + 300, jti: randomUUID(),
            };
            if (act !== undefined) payload.act = act;
            const unsigned = [{ alg: 'RS256', typ: 'JWT', kid }, payload].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');
            return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
        },
    };
}

// ------------------------------------------------------------------------------------------------------------- Keycloak

export interface DelegationRealm {
    issuer: string;
    /** The realm's signing keys as an inline JWK set (base64 of the JSON), so Core does not fetch them itself. */
    jwkSet: string;
    actorClientId: string;
    /** The actor's service-account user id: the `act.sub` of the delegation token. */
    actorSubject: string;
    subjectToken: string;
    delegateToken: string;
    dispose(): Promise<void>;
}

/**
 * A disposable realm on the platform's Keycloak (its `token-exchange-delegation` and `parameterized-scopes` features
 * are on wherever MCP signs in through it): an actor client with a service account and standard token exchange, a
 * subject client with the password grant, and a user with the ILM user's name. A hardcoded `may_act` mapper stands in
 * for the consent and FGAP v2 policy of a production realm, so the exchange is deterministic. The realm is deleted by
 * `dispose`, also when provisioning fails half way.
 */
export interface KeycloakAdmin {
    keycloakUrl: string;
    adminUsername: string;
    adminPassword: string;
}

async function tokenOf(url: string, realm: string, form: Record<string, string>): Promise<string> {
    const data = await json(`${url}/realms/${realm}/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams(form) });
    if (typeof data.access_token !== 'string') throw new Error(`realm ${realm}: no access token in the answer (contents withheld)`);
    return data.access_token as string;
}

/** Admin API headers with a fresh master-realm token: it lives about a minute, so every admin step takes its own. */
async function adminHeaders(o: KeycloakAdmin): Promise<Record<string, string>> {
    const token = await tokenOf(o.keycloakUrl.replace(/\/$/, ''), 'master', {
        grant_type: 'password', client_id: 'admin-cli', username: o.adminUsername, password: o.adminPassword,
    });
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/** Deletes the realms whose name starts with `prefix` that the test admin can see (those an earlier run left). */
export async function sweepRealms(o: KeycloakAdmin, prefix: string): Promise<string[]> {
    const url = o.keycloakUrl.replace(/\/$/, '');
    const headers = await adminHeaders(o);
    const stale = (await json<Json[]>(`${url}/admin/realms?briefRepresentation=true`, { headers }))
        .map((r) => String(r.realm)).filter((name) => name.startsWith(prefix));
    for (const name of stale) await http(`${url}/admin/realms/${encodeURIComponent(name)}`, { method: 'DELETE', headers }, [204, 404]);
    return stale;
}

export async function provisionDelegationRealm(o: KeycloakAdmin & { realm: string; username: string }): Promise<DelegationRealm> {
    const url = o.keycloakUrl.replace(/\/$/, '');
    const headers = await adminHeaders(o);
    const base = `${url}/admin/realms/${encodeURIComponent(o.realm)}`;
    const dispose = async (): Promise<void> => {
        await http(base, { method: 'DELETE', headers: await adminHeaders(o) }, [204, 404]);
    };
    const actorClientId = `${o.realm}-actor`;
    const subjectClientId = `${o.realm}-subject`;
    const [actorId, subjectId, actorSecret, subjectSecret, password] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const audienceMapper = {
        name: 'actor-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
        config: { 'included.client.audience': actorClientId, 'access.token.claim': 'true' },
    };
    await http(`${url}/admin/realms`, {
        method: 'POST', headers, body: JSON.stringify({
            realm: o.realm, enabled: true,
            clients: [
                {
                    id: actorId, clientId: actorClientId, secret: actorSecret, protocol: 'openid-connect', publicClient: false,
                    serviceAccountsEnabled: true, standardFlowEnabled: false, attributes: { 'standard.token.exchange.enabled': 'true' },
                    protocolMappers: [audienceMapper],
                },
                {
                    id: subjectId, clientId: subjectClientId, secret: subjectSecret, protocol: 'openid-connect', publicClient: false,
                    directAccessGrantsEnabled: true, standardFlowEnabled: false, protocolMappers: [audienceMapper],
                },
            ],
            users: [{
                username: o.username, enabled: true, emailVerified: true, firstName: 'Delegation', lastName: 'Fixture',
                email: `${o.username}@example.test`, credentials: [{ type: 'password', value: password, temporary: false }],
            }],
        }),
    });
    try {
        const actor = await json(`${base}/clients/${actorId}/service-account-user`, { headers });
        await http(`${base}/clients/${subjectId}/protocol-mappers/models`, {
            method: 'POST', headers, body: JSON.stringify({
                name: 'disposable-may-act', protocol: 'openid-connect', protocolMapper: 'oidc-hardcoded-claim-mapper',
                config: {
                    'claim.name': 'may_act', 'claim.value': JSON.stringify({ sub: actor.id, client_id: actorClientId }),
                    'jsonType.label': 'JSON', 'access.token.claim': 'true',
                },
            }),
        });
        const discovery = await json(`${url}/realms/${o.realm}/.well-known/openid-configuration`);
        const certs = await json<{ keys: Json[] }>(discovery.jwks_uri as string);
        const signing = certs.keys.filter((k) => k.use === 'sig' && k.alg === 'RS256');
        if (!signing.length) throw new Error(`realm ${o.realm}: no RS256 signing key`);
        const subjectToken = await tokenOf(url, o.realm, {
            grant_type: 'password', client_id: subjectClientId, client_secret: subjectSecret, username: o.username, password, scope: 'openid',
        });
        const actorToken = await tokenOf(url, o.realm, { grant_type: 'client_credentials', client_id: actorClientId, client_secret: actorSecret });
        const delegateToken = await tokenOf(url, o.realm, {
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', client_id: actorClientId, client_secret: actorSecret,
            subject_token: subjectToken, actor_token: actorToken,
            subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            actor_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        });
        return {
            issuer: discovery.issuer as string,
            jwkSet: Buffer.from(JSON.stringify({ keys: signing })).toString('base64'),
            actorClientId, actorSubject: actor.id as string, subjectToken, delegateToken, dispose,
        };
    } catch (error) {
        try {
            await dispose();
        } catch {
            throw new Error(`Keycloak provisioning failed and realm ${o.realm} could not be deleted (details withheld)`);
        }
        throw error;
    }
}

// ------------------------------------------------------------------------------------------------------------ ILM calls

export interface Invocation {
    status: number;
    /** The unique User-Agent of this request, which its audit record carries as `source.userAgent`. */
    marker: string;
}

/** Calls an ILM path with a bearer token; the User-Agent marks the request for its audit record. */
export async function invoke(baseUrl: string, path: string, token: string): Promise<Invocation> {
    const marker = `ilm-delegation/${randomUUID()}`;
    const { status } = await http(`${baseUrl.replace(/\/$/, '')}${path}`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': marker, Accept: 'application/json' },
    }, [200, 401, 403]);
    return { status, marker };
}

const providerPath = (name: string): string => `/api/v1/settings/authentication/oauth2Providers/${encodeURIComponent(name)}`;

export async function putProvider(admin: APIRequestContext, name: string, settings: Json): Promise<void> {
    await sendOk(admin, 'PUT', providerPath(name), settings);
}

export async function removeProvider(admin: APIRequestContext, name: string): Promise<void> {
    const answer = await send(admin, 'DELETE', providerPath(name));
    if (![200, 204, 404].includes(answer.status)) throw new Error(`DELETE provider ${name} answered ${answer.status}`);
}

/** The names of the OAuth2 providers whose name starts with `prefix`, for a sweep of providers an earlier run left. */
export async function providersStartingWith(admin: APIRequestContext, prefix: string): Promise<string[]> {
    const settings = (await sendOk(admin, 'GET', '/api/v1/settings/authentication')).json as Json;
    return Object.keys(settings.oauth2Providers ?? {}).filter((name) => name.startsWith(prefix));
}

/**
 * Repeats the call until it answers `status` on every try of a row (several Core instances follow a settings change
 * one by one), within the settings spread time.
 */
export async function untilStatus(call: () => Promise<Invocation>, status: number, what: string, inARow = 3): Promise<Invocation> {
    const deadline = Date.now() + SETTINGS_SPREAD_MS + 20_000;
    let streak = 0;
    let last: Invocation | undefined;
    while (Date.now() < deadline) {
        last = await call();
        streak = last.status === status ? streak + 1 : 0;
        if (streak >= inARow) return last;
        await sleep(1_000);
    }
    throw new Error(`${what}: did not answer ${status} ${inARow} times in a row within ${SETTINGS_SPREAD_MS + 20_000} ms (last ${last?.status})`);
}

// ------------------------------------------------------------------------------------------------------------ audit log

/** The audit log settings this test needs: every module and resource, written to the database. */
export async function enableFullAudit(admin: APIRequestContext): Promise<Json> {
    const logging = (await sendOk(admin, 'GET', '/api/v1/settings/logging')).json as Json;
    await sendOk(admin, 'PUT', '/api/v1/settings/logging', {
        ...logging,
        auditLogs: { ...logging.auditLogs, logAllModules: true, logAllResources: true, output: 'DATABASE' },
    });
    return logging;
}

export async function restoreLogging(admin: APIRequestContext, logging: Json): Promise<void> {
    await sendOk(admin, 'PUT', '/api/v1/settings/logging', logging);
}

export const DELEGATE_FIELD = 'AUDIT_LOG_ACTOR_DELEGATE_IDENTIFIER';
const delegateFilter = (identifier: string): Json[] => [{ fieldSource: 'property', fieldIdentifier: DELEGATE_FIELD, condition: 'EQUALS', value: identifier }];

async function auditPage(admin: APIRequestContext, filters: Json[]): Promise<Json[]> {
    const answer = await sendOk(admin, 'POST', '/api/v1/auditLogs', { pageNumber: 1, itemsPerPage: 1000, filters });
    return ((answer.json as Json).items ?? []) as Json[];
}

async function pollAudit(admin: APIRequestContext, matches: (item: Json) => boolean, what: string, timeoutMs = 30_000): Promise<Json[]> {
    const deadline = Date.now() + timeoutMs;
    do {
        const found = (await auditPage(admin, [])).filter(matches);
        if (found.length) return found;
        await sleep(500);
    } while (Date.now() < deadline);
    throw new Error(`no audit record within ${timeoutMs} ms: ${what}`);
}

/** The audit records of one marked request. */
export const auditOf = (admin: APIRequestContext, call: Invocation): Promise<Json[]> =>
    pollAudit(admin, (item) => item.source?.userAgent === call.marker, `request ${call.marker}`);

/** The highest audit record id now, so a later failure record can be told apart from earlier ones. */
export async function auditWatermark(admin: APIRequestContext): Promise<number> {
    return (await auditPage(admin, [])).reduce((max, item) => Math.max(max, Number(item.id)), 0);
}

/**
 * A failed authentication after `afterId` whose message names the provider and the delegate. Authentication filters
 * refuse before the request's source is recorded, so the User-Agent marker cannot find these.
 */
export const refusalAudit = (admin: APIRequestContext, afterId: number, provider: string, delegate: string): Promise<Json[]> =>
    pollAudit(admin, (item) => Number(item.id) > afterId && item.operationResult === 'failure'
        && String(item.message ?? '').includes(provider) && String(item.message ?? '').includes(delegate), `refusal of ${delegate} by ${provider}`);

export const auditFilteredByDelegate = (admin: APIRequestContext, identifier: string): Promise<Json[]> => auditPage(admin, delegateFilter(identifier));

export async function auditSearchFields(admin: APIRequestContext): Promise<string[]> {
    const groups = (await sendOk(admin, 'GET', '/api/v1/auditLogs/search')).json as Json[];
    return groups.flatMap((g) => ((g.searchFieldData ?? []) as Json[]).map((f) => String(f.fieldIdentifier)));
}

/** The rows of the audit export filtered by delegate (ZIP or plain CSV, comma-separated, with headers). */
export async function exportByDelegate(admin: APIRequestContext, identifier: string): Promise<Array<Record<string, string>>> {
    const answer = await admin.post('/api/v1/auditLogs/export', { data: delegateFilter(identifier) });
    if (!answer.ok()) throw new Error(`audit export answered ${answer.status()}`);
    return csvRows(unzipFirst(await answer.body()));
}

/** The first entry of a ZIP file (stored or deflated), or the bytes themselves when they are not a ZIP. */
function unzipFirst(body: Buffer): Buffer {
    if (body.readUInt16LE(0) !== 0x4b50) return body;
    const method = body.readUInt16LE(8);
    const central = body.lastIndexOf(Buffer.from('504b0102', 'hex'));
    const size = central >= 0 ? body.readUInt32LE(central + 20) : body.readUInt32LE(18);
    const start = 30 + body.readUInt16LE(26) + body.readUInt16LE(28);
    const data = body.subarray(start, start + size);
    if (method === 0) return data;
    if (method === 8) return inflateRawSync(data);
    throw new Error(`audit export: ZIP compression method ${method} is not supported`);
}

function csvRows(bytes: Buffer, separator = ','): Array<Record<string, string>> {
    const text = bytes.toString('utf8').replace(/^﻿/, '');
    const rows: string[][] = [];
    let row: string[] = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            if (quoted && text[i + 1] === '"') {
                value += '"';
                i++;
            } else quoted = !quoted;
        } else if (!quoted && (ch === separator || ch === '\n')) {
            row.push(value.replace(/\r$/, ''));
            value = '';
            if (ch === '\n') {
                rows.push(row);
                row = [];
            }
        } else value += ch;
    }
    if (value || row.length) rows.push([...row, value]);
    const header = rows.shift() ?? [];
    return rows.map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ''])));
}

/** True when any issued token, or its signature, appears in the value (audit records and exports must hold neither). */
export function leaksToken(value: unknown, tokens: string[]): boolean {
    const text = JSON.stringify(value);
    return tokens.some((token) => text.includes(token) || text.includes(token.split('.')[2] ?? '\u0000'));
}
