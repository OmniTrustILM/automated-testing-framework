/**
 * credentialKinds — own credentials of the kinds ApiKey and SoftKeyStore, built from the connector's live attribute definitions.
 *
 * WHAT: finds the connected v1 credential connector that offers a kind and reads that kind's attribute definitions; builds the request
 *       attributes of an ApiKey credential (every secret attribute gets a generated value, every other required one a placeholder or its
 *       first listed option) and of a SoftKeyStore credential (the PKCS#12 keystore, its password and its type); drops one attribute to
 *       make a request that must be refused; creates an own credential of the kind.
 * WHY: the Basic kind has helpers and tests; the other two kinds of the credential provider had none, and a kind that cannot be created
 *      or loses its secret masking is a defect the Basic rows would not show.
 * HOW: attribute names and uuids come from `GET /v1/connectors/{uuid}/attributes/credentialProvider/{kind}`, never from constants of the
 *      suite beyond the SoftKeyStore attribute names the connector documents. Secrets and the keystore are generated per call and are in
 *      no log. The create is recorded in the ledger before any assertion (`createOwn`); a refused create is a probe whose accepted answer is
 *      recorded (`probeCredential`). Pure builders return `{ problem }` instead of throwing, so a spec can skip with the reason before it writes.
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

/** The data attribute definitions of a kind (the info and group definitions are no input). */
export const dataDefinitions = (defs: JsonObject[]): JsonObject[] => defs.filter((d) => !d.type || /^data$/i.test(String(d.type)));

const propertiesOf = (def: JsonObject): JsonObject => (def.properties && typeof def.properties === 'object' ? (def.properties as JsonObject) : {});

/** The names of the data attributes the kind requires. */
export const requiredNames = (defs: JsonObject[]): string[] => dataDefinitions(defs).filter((d) => propertiesOf(d).required === true).map((d) => String(d.name));

export interface KindConnector {
    uuid: string;
    name: string;
    /** The kind's attribute definitions, read live through core. */
    defs: JsonObject[];
}

/**
 * The connected credential connector that offers the kind, with its definitions; `skip` names the reason when the tier cannot run the rows
 * (no connector with the kind, the kind not offered, or no data attribute). A read that fails throws. Reads only.
 */
export async function kindConnector(api: APIRequestContext, kind: CredentialKind, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: KindConnector; skip?: undefined } | { ok?: undefined; skip: string }> {
    const connector = await findCredentialConnector(api, kind, env);
    if (!connector) return { skip: `no connected credential connector offers the kind ${kind} on this tier (REG_CREDENTIAL_CONNECTOR names the one to use)` };
    const answer = await readAnswer(api, `/api/v1/connectors/${connector.uuid}/attributes/credentialProvider/${kind}`);
    // Only "the kind is not offered" (404) is a skip; any other answer that is not 200 is a failed read and fails the test.
    if (answer.status === 404) return { skip: `${connector.name}: the connector does not offer the kind ${kind} (the attribute definitions read answered 404)` };
    if (answer.status !== 200) throw new Error(`GET /api/v1/connectors/${connector.uuid}/attributes/credentialProvider/${kind} answered ${answer.status} ${answer.text.slice(0, 200)}`);
    const defs = readJsonOk<unknown>(answer, `GET ${kind} credential attributes`);
    if (!Array.isArray(defs) || !dataDefinitions(defs as JsonObject[]).length) return { skip: `${connector.name}: the ${kind} kind lists no data attribute` };
    return { ok: { ...connector, defs: defs as JsonObject[] } };
}

export interface BuiltAttributes {
    attributes: JsonObject[];
    /** The generated secret values, so a test can prove none of them comes back. */
    secrets: string[];
}

/**
 * The request attributes of an ApiKey credential: every secret-typed data attribute is filled with its own generated value (so masking can
 * be proven for each), the other required ones with a placeholder or their first option. A required attribute of a type the suite cannot
 * fill is a `problem`.
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

/** The SoftKeyStore attribute names the credential provider documents. */
export const SOFT_KEY_STORE = { type: 'keyStoreType', passwordName: 'keyStorePassword', keyStore: 'keyStore' } as const;

/**
 * The request attributes of a SoftKeyStore credential: type PKCS12, the keystore password and the PKCS#12 file. A definition the kind no
 * longer lists is a `problem`.
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

/** The attributes without the one named (a request that must be refused: the required attribute is missing). */
export const withoutAttribute = (attributes: JsonObject[], name: string): JsonObject[] => attributes.filter((a) => a.name !== name);

/** The names of the built attributes that the kind requires: the ones whose omission must be refused. */
export const omittableRequired = (defs: JsonObject[], attributes: JsonObject[]): string[] => {
    const required = requiredNames(defs);
    return attributes.map((a) => String(a.name)).filter((n) => required.includes(n));
};

/** A `POST /v1/credentials` body of a kind. */
export async function kindBody(api: GuardedApi, connector: Pick<KindConnector, 'uuid'>, kind: CredentialKind, name: string, attributes: JsonObject[]): Promise<JsonObject> {
    return { name, connectorUuid: connector.uuid, kind, attributes, customAttributes: await requiredCustomAttributes(api, 'credentials', runName('ca')) };
}

export interface OwnKindCredential extends OwnRef {
    credentialKind: CredentialKind;
    /** The raw text of the 201 answer (a secret must not be in it). */
    createText: string;
}

/** A NEW own credential of the kind (201 required; ledger first): run-prefixed unique name. */
export async function createOwnKindCredential(api: GuardedApi, spec: string, suffix: string, o: { connector: Pick<KindConnector, 'uuid'>; kind: CredentialKind; attributes: JsonObject[]; note?: string }): Promise<OwnKindCredential> {
    const name = ownName(suffix);
    const { name: _name, ...rest } = await kindBody(api, o.connector, o.kind, name, o.attributes);
    const created = await createOwn(api, spec, { type: 'credentials', path: '/api/v1/credentials', name, note: o.note ?? `own ${o.kind} credential`, body: rest });
    if (created.answer.status !== 201) throw new Error(`creating the own ${o.kind} credential answered ${created.answer.status} ${created.answer.text.slice(0, 300)}`);
    const { answer, ...ref } = created;
    return { ...ref, credentialKind: o.kind, createText: answer.text };
}
