/**
 * credentialKinds — own credentials of the kinds ApiKey and SoftKeyStore, built from the connector's live attribute definitions; secrets
 * are generated per call and in no log, builders return `{ problem }` instead of
 * throwing, and a create that should be refused goes through `probeCredential`.
 */
import type { APIRequestContext } from '@playwright/test';
import { fileAttr, secretAttr, stringAttr, type AttributeRequest } from '../../attributeTypes';
import { requestAttributesFrom, requiredCustomAttributes, UnfillableAttributeError } from '../customAttributes';
import { findCredentialConnector } from '../platform/connectorLookup';
import { createOwn } from '../ownCrud';
import { ownName, runName } from '../ledger/runState';
import type { GuardedApi } from '../guard/types';
import type { OwnRef } from '../ledger/ledger';
import type { JsonObject } from '../json';
import { randomSecret } from './credentialsApi';
import { readAnswer, readJsonOk } from './searchApi';

export type CredentialKind = 'ApiKey' | 'SoftKeyStore';

export const dataDefinitions = (defs: JsonObject[]): JsonObject[] => defs.filter((d) => !d.type || /^data$/i.test(String(d.type)));

const propertiesOf = (def: JsonObject): JsonObject => (def.properties && typeof def.properties === 'object' ? (def.properties as JsonObject) : {});

export const requiredNames = (defs: JsonObject[]): string[] => dataDefinitions(defs).filter((d) => propertiesOf(d).required === true).map((d) => String(d.name));

export interface KindConnector {
    uuid: string;
    name: string;
    defs: JsonObject[];
}

/** The connected credential connector that offers the kind, with its definitions; `skip` names why the tier cannot run the rows. Reads only. */
export async function kindConnector(api: APIRequestContext, kind: CredentialKind, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: KindConnector; skip?: undefined } | { ok?: undefined; skip: string }> {
    const connector = await findCredentialConnector(api, kind, env);
    if (!connector) return { skip: `no connected credential connector offers the kind ${kind} on this tier (REG_CREDENTIAL_CONNECTOR names the one to use)` };
    const answer = await readAnswer(api, `/api/v1/connectors/${connector.uuid}/attributes/credentialProvider/${kind}`);
            // Only "the kind is not offered" (404) skips; any other non-200 is a failed read.
    if (answer.status === 404) return { skip: `${connector.name}: the connector does not offer the kind ${kind} (the attribute definitions read answered 404)` };
    if (answer.status !== 200) throw new Error(`GET /api/v1/connectors/${connector.uuid}/attributes/credentialProvider/${kind} answered ${answer.status} ${answer.text.slice(0, 200)}`);
    const defs = readJsonOk<unknown>(answer, `GET ${kind} credential attributes`);
    if (!Array.isArray(defs) || !dataDefinitions(defs as JsonObject[]).length) return { skip: `${connector.name}: the ${kind} kind lists no data attribute` };
    return { ok: { ...connector, defs: defs as JsonObject[] } };
}

export interface BuiltAttributes {
    attributes: JsonObject[];
    secrets: string[];
}

/**
 * The request attributes of an ApiKey credential: each secret-typed attribute gets its own generated value (masking is proven for each),
 * other required ones a placeholder; an unfillable type is a `problem`.
 */
export function apiKeyAttributes(defs: JsonObject[]): BuiltAttributes | { problem: string } {
    const values: Record<string, unknown> = {};
    const secrets: string[] = [];
    for (const d of dataDefinitions(defs)) {
        if (String(d.contentType).toLowerCase() !== 'secret') continue;
        const secret = randomSecret();
        values[String(d.name)] = secret;
        secrets.push(secret);
    }
    try {
        return { attributes: requestAttributesFrom(defs as never, values, 'qa'), secrets };
    } catch (e) {
        if (e instanceof UnfillableAttributeError) return { problem: e.message };
        throw e;
    }
}

export const SOFT_KEY_STORE = { type: 'keyStoreType', passwordName: 'keyStorePassword', keyStore: 'keyStore' } as const;

/**
 * The request attributes of a SoftKeyStore credential: type PKCS12, the password and the PKCS#12 file; a definition the kind no longer
 * lists is a `problem`.
 */
export function softKeyStoreAttributes(defs: JsonObject[], keyStore: { password: string; p12: Buffer; fileName?: string }): BuiltAttributes | { problem: string } {
    const uuidOf = (name: string): string | undefined => {
        const uuid = dataDefinitions(defs).find((d) => d.name === name)?.uuid;
        return typeof uuid === 'string' ? uuid : undefined;
    };
    const missing = Object.values(SOFT_KEY_STORE).filter((name) => !uuidOf(name));
    if (missing.length) return { problem: `the SoftKeyStore kind lists no attribute ${missing.join(', ')}` };
    const attributes: AttributeRequest[] = [
        stringAttr(SOFT_KEY_STORE.type, uuidOf(SOFT_KEY_STORE.type)!, 'PKCS12', true),
        secretAttr(SOFT_KEY_STORE.passwordName, uuidOf(SOFT_KEY_STORE.passwordName)!, keyStore.password),
        fileAttr(SOFT_KEY_STORE.keyStore, uuidOf(SOFT_KEY_STORE.keyStore)!, keyStore.p12.toString('base64'), keyStore.fileName ?? 'keystore.p12', 'application/x-pkcs12'),
    ];
    return { attributes: attributes as unknown as JsonObject[], secrets: [keyStore.password] };
}

export const withoutAttribute = (attributes: JsonObject[], name: string): JsonObject[] => attributes.filter((a) => a.name !== name);

export const omittableRequired = (defs: JsonObject[], attributes: JsonObject[]): string[] => {
    const required = requiredNames(defs);
    return attributes.map((a) => String(a.name)).filter((n) => required.includes(n));
};

export async function kindBody(api: GuardedApi, connector: Pick<KindConnector, 'uuid'>, kind: CredentialKind, name: string, attributes: JsonObject[]): Promise<JsonObject> {
    return { name, connectorUuid: connector.uuid, kind, attributes, customAttributes: await requiredCustomAttributes(api, 'credentials', runName('ca')) };
}

export interface OwnKindCredential extends OwnRef {
    credentialKind: CredentialKind;
    createText: string;
}

export async function createOwnKindCredential(api: GuardedApi, spec: string, suffix: string, o: { connector: Pick<KindConnector, 'uuid'>; kind: CredentialKind; attributes: JsonObject[]; note?: string }): Promise<OwnKindCredential> {
    const name = ownName(suffix);
    const { name: _name, ...rest } = await kindBody(api, o.connector, o.kind, name, o.attributes);
    const created = await createOwn(api, spec, { type: 'credentials', path: '/api/v1/credentials', name, note: o.note ?? `own ${o.kind} credential`, body: rest });
    if (created.answer.status !== 201) throw new Error(`creating the own ${o.kind} credential answered ${created.answer.status} ${created.answer.text.slice(0, 300)}`);
    const { answer, ...ref } = created;
    return { ...ref, credentialKind: o.kind, createText: answer.text };
}
