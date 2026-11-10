/**
 * Credential helpers of the configuration-resources API specs: Basic attribute builders, own credentials, create probes recorded in the
 * ledger before any assertion, and the secret scan. A test password is `randomSecret()`, never a literal.
 */
import type { APIRequestContext } from '@playwright/test';
import * as crypto from 'crypto';
import { describeHealth, findConnector, healthByVersion, requiredConnectors } from '../platform/connectorApi';
import { assertGuarded } from '../guard/types';
import type { GuardedApi } from '../guard/types';
import { readJsonOk, send, readAnswer } from './searchApi';
import { checkOwnership } from '../ledger/ownership';
import { rowsNamed } from '../listReads';
import { requiredCustomAttributes } from '../customAttributes';
import { recordCreated } from '../ledger/ledger';
import { createOwn, probeCollectionCreate } from '../ownCrud';
import { runName, ownName } from '../ledger/runState';
import type { OwnRef } from '../ledger/ledger';
import { hasRunFamilyPrefix } from '../run/runId';
import { ApiAnswer } from '../apiReads';
import { DEFAULT_CREDENTIAL_CONNECTOR, settings } from '../run/settings';
import { JsonObject } from '../json';


/** A fresh random password for one credential; alphabet `[A-Za-z0-9_-]`, no JSON escape applies. */
export const randomSecret = (): string => `qa-${crypto.randomBytes(12).toString('base64url')}`;

/** True when `secret` occurs in `text`; an empty secret never counts. */
export const containsSecret = (text: string, secret: string): boolean => secret.length > 0 && text.includes(secret);


export interface CredentialConnector {
    uuid: string;
    name: string;
    /** The Basic kind's `username` / `password` definitions, read live through core. */
    usernameDef: JsonObject;
    passwordDef: JsonObject;
}

export function credentialConnectorName(env: NodeJS.ProcessEnv = process.env): string {
    const named = settings(env).credentialConnectorOverride;
    if (named) return named;
    return requiredConnectors(env).find((n) => /credential/i.test(n)) ?? DEFAULT_CREDENTIAL_CONNECTOR;
}

export function basicDefinitions(list: unknown): { usernameDef: JsonObject; passwordDef: JsonObject } | { problem: string } {
    if (!Array.isArray(list)) return { problem: 'the Basic attribute list is not an array' };
    const defs = (list as JsonObject[]).filter((a) => !a.type || a.type === 'data');
    const usernameDef = defs.find((a) => a.name === 'username');
    const passwordDef = defs.find((a) => a.name === 'password');
    if (!usernameDef || !passwordDef) return { problem: 'the Basic kind has no username / password data attributes' };
    if (typeof usernameDef.uuid !== 'string' || typeof passwordDef.uuid !== 'string') return { problem: 'a Basic attribute definition carries no uuid' };
    if (String(passwordDef.contentType).toLowerCase() !== 'secret') return { problem: `the Basic password attribute has content type ${String(passwordDef.contentType)}, not secret` };
    return { usernameDef, passwordDef };
}

/** The credential connector, live, with its Basic definitions; `skip` names why the tier cannot run the credential rows. Reads only. */
export async function credentialSetup(api: APIRequestContext, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: CredentialConnector; skip?: undefined } | { ok?: undefined; skip: string }> {
    const name = credentialConnectorName(env);
    const connector = await findConnector(api, name);
    if (!connector) return { skip: `connector ${name} is not registered on this tier (REG_CREDENTIAL_CONNECTOR names another one)` };
    const health = await healthByVersion(api, connector);
    if (!health.healthy) return { skip: `${describeHealth(health)} — environment blocker (the credential rows need a live connector)` };
    const read = await readAnswer(api, `/api/v1/connectors/${connector.uuid}/attributes/credentialProvider/Basic`);
    if (read.status !== 200) return { skip: `${name}: the Basic attribute definitions read answered ${read.status}` };
    const defs = basicDefinitions(read.json);
    if ('problem' in defs) return { skip: `${name}: ${defs.problem}` };
    return { ok: { uuid: connector.uuid, name, ...defs } };
}

/**
 * Values of a Basic credential's attributes: `undefined` leaves the attribute out, `null` lists it without content, a string is its content
 * (the password as a secret).
 */
export interface BasicValues {
    username?: string | null;
    password?: string | null;
}

/**
 * The request attributes of a Basic credential in the current contract;
 * `withUuid: false` builds the legacy by-name shape that core#2512 reports.
 */
export function basicAttributes(c: Pick<CredentialConnector, 'usernameDef' | 'passwordDef'>, values: BasicValues, opts: { withUuid?: boolean } = {}): JsonObject[] {
    const withUuid = opts.withUuid !== false;
    const one = (def: JsonObject, value: string | null | undefined, wrap: (v: string) => unknown): JsonObject[] => {
        if (value === undefined) return [];
        const attribute: JsonObject = { version: 'v2', ...(withUuid ? { uuid: def.uuid } : {}), name: def.name, contentType: String(def.contentType).toLowerCase() };
        if (value !== null) attribute.content = [{ data: wrap(value) }];
        return [attribute];
    };
    return [...one(c.usernameDef, values.username, (v) => v), ...one(c.passwordDef, values.password, (v) => ({ secret: v }))];
}

export function credentialBody(c: Pick<CredentialConnector, 'uuid'>, name: unknown, attributes: JsonObject[], customAttributes: JsonObject[], over: JsonObject = {}): JsonObject {
    return { name, connectorUuid: c.uuid, kind: 'Basic', attributes, customAttributes, ...over };
}


export async function findRowByUuid(api: APIRequestContext, listUrl: '/api/v1/credentials' | '/api/v1/groups', uuid: string): Promise<JsonObject | undefined> {
    const rows = readJsonOk<JsonObject[]>(await readAnswer(api, listUrl), `GET ${listUrl}`);
    if (!Array.isArray(rows)) throw new Error(`GET ${listUrl} did not answer a list`);
    return rows.find((r) => r?.uuid === uuid);
}

/**
 * Records every row named exactly `name` that a REFUSED create left behind
 * (core#2512) and is not in the ledger yet, so the teardown removes it.
 */
export async function adoptByName(
    api: APIRequestContext, listUrl: '/api/v1/credentials' | '/api/v1/groups' | '/api/v1/raProfiles', type: 'credentials' | 'groups' | 'raProfiles',
    name: string, spec: string, note: string, parents?: Record<string, string>,
): Promise<JsonObject[]> {
    const rows = await rowsNamed(api, listUrl, name);
    for (const r of rows) {
        if (typeof r.uuid === 'string' && !checkOwnership({ uuid: r.uuid }).own) recordCreated(type, { uuid: r.uuid, name }, { spec, note, parents });
    }
    return rows;
}

export type DeletableKind = 'credentials' | 'groups';

/** `DELETE /v1/credentials|groups/{uuid}` through the guard; status and body never throw. */
export async function deleteConfigObject(api: GuardedApi, kind: DeletableKind, uuid: string): Promise<ApiAnswer> {
    return send(assertGuarded(api, 'deleteConfigObject'), 'DELETE', `/api/v1/${kind}/${uuid}`);
}

export async function bulkDeleteObjects(api: GuardedApi, kind: DeletableKind, uuids: string[]): Promise<ApiAnswer> {
    return send(assertGuarded(api, 'bulkDeleteObjects'), 'DELETE', `/api/v1/${kind}`, { data: uuids });
}

export const readObject = (api: APIRequestContext, kind: DeletableKind, uuid: string): Promise<ApiAnswer> => readAnswer(api, `/api/v1/${kind}/${uuid}`);


export async function probeCredential(api: GuardedApi, spec: string, body: JsonObject, note = 'credential create probe'): Promise<ApiAnswer> {
    return probeCollectionCreate(api, spec, { type: 'credentials', path: '/api/v1/credentials', body, note });
}

export interface OwnCredential extends OwnRef {
    username: string;
    password: string;
    createText: string;
}

export interface BasicCredentialOptions {
    connector: Pick<CredentialConnector, 'uuid' | 'name'> & Partial<Pick<CredentialConnector, 'usernameDef' | 'passwordDef'>>;
    username?: string;
    password?: string;
    note?: string;
}

export async function createOwnBasicCredential(api: GuardedApi, spec: string, suffix: string, o: BasicCredentialOptions): Promise<OwnCredential> {
    let defs = o.connector.usernameDef && o.connector.passwordDef ? { usernameDef: o.connector.usernameDef, passwordDef: o.connector.passwordDef } : undefined;
    if (!defs) {
        const read = readJsonOk<unknown>(await readAnswer(api, `/api/v1/connectors/${o.connector.uuid}/attributes/credentialProvider/Basic`), 'GET Basic credential attributes');
        const found = basicDefinitions(read);
        if ('problem' in found) throw new Error(`${o.connector.name}: ${found.problem}`);
        defs = found;
    }
    const username = o.username ?? ownName('cu');
    const password = o.password ?? randomSecret();
    const created = await createOwn(api, spec, {
        type: 'credentials',
        path: '/api/v1/credentials',
        name: ownName(suffix),
        note: o.note ?? 'own Basic credential (API prerequisite)',
        body: credentialBody(o.connector, undefined, basicAttributes(defs, { username, password }), await requiredCustomAttributes(api, 'credentials', runName('ca'))),
    });
    if (created.answer.status !== 201) throw new Error(`creating the own credential answered ${created.answer.status} ${created.answer.text.slice(0, 300)}`);
    const { answer, ...ref } = created;
    return { ...ref, username, password, createText: answer.text };
}

export const readCredential = (api: APIRequestContext, uuid: string): Promise<ApiAnswer> => readAnswer(api, `/api/v1/credentials/${uuid}`);

export const attributeOf = (detail: JsonObject | undefined, name: string): JsonObject | undefined => (Array.isArray(detail?.attributes) ? (detail!.attributes as JsonObject[]).find((a) => a?.name === name) : undefined);

export const contentWithData = (attribute: JsonObject | undefined): JsonObject[] =>
    (Array.isArray(attribute?.content) ? (attribute!.content as JsonObject[]) : []).filter((item) => item && item.data !== undefined && item.data !== null);

/** `PUT /v1/credentials/{own}` with attributes and the tier's required custom attributes; `over` adds members. */
export async function putCredential(api: GuardedApi, uuid: string, attributes: JsonObject[], customAttributes: JsonObject[], over: JsonObject = {}): Promise<ApiAnswer> {
    return send(assertGuarded(api, 'putCredential'), 'PUT', `/api/v1/credentials/${uuid}`, { data: { attributes, customAttributes, ...over } });
}

export async function setCredentialEnabled(api: GuardedApi, uuid: string, enabled: boolean): Promise<ApiAnswer> {
    return send(assertGuarded(api, 'setCredentialEnabled'), 'PATCH', `/api/v1/credentials/${uuid}/${enabled ? 'enable' : 'disable'}`);
}

export const valuesOf = (detail: JsonObject | undefined, key: 'customAttributes' | 'attributes', name: string): unknown[] => {
    const list = Array.isArray(detail?.[key]) ? (detail![key] as JsonObject[]) : [];
    const attribute = list.find((a) => a?.name === name);
    return (Array.isArray(attribute?.content) ? (attribute!.content as JsonObject[]) : []).map((c) => c?.data);
};


/**
 * The first pre-existing connector (by name) that has function groups but not
 * `credentialProvider`, or undefined; reads only, run-family names skipped.
 */
export async function connectorWithoutCredentialGroup(api: APIRequestContext): Promise<{ uuid: string; name: string } | undefined> {
    const rows = readJsonOk<JsonObject[]>(await readAnswer(api, '/api/v1/connectors'), 'GET /v1/connectors');
    const sorted = (Array.isArray(rows) ? rows : []).filter((r) => typeof r?.uuid === 'string' && !hasRunFamilyPrefix(String(r.name))).sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
    const hit = sorted.find((r) => Array.isArray(r.functionGroups) && r.functionGroups.length > 0 && !r.functionGroups.some((g: JsonObject) => g?.functionGroupCode === 'credentialProvider'));
    return hit ? { uuid: String(hit.uuid), name: String(hit.name) } : undefined;
}
