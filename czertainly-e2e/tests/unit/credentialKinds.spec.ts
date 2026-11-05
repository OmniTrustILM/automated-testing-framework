/**
 * credentialKinds — the request builders for credentials of the kinds ApiKey and SoftKeyStore.
 *
 * Checks `dataDefinitions`, `requiredNames`, `apiKeyAttributes` (a generated value for every secret attribute,
 * placeholders for the other required ones, a problem for a type the suite cannot fill), `softKeyStoreAttributes` (type,
 * password and the PKCS#12 file; a missing definition is a problem), `withoutAttribute` and `omittableRequired`.
 *
 * The rows build requests from the connector's live definitions, so a builder that throws, reuses a secret or sends the
 * wrong shape would fail a row on a healthy tier. Pure; secrets are generated per test.
 */
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiKeyAttributes, dataDefinitions, omittableRequired, requiredNames, SOFT_KEY_STORE, softKeyStoreAttributes, withoutAttribute } from '../../utils/regression/inventory/credentialKinds';
import { containsSecret } from '../../utils/regression/inventory/credentialsApi';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const def = (n: number, name: string, contentType: string, required: boolean, extra: object = {}) => ({ uuid: U(n), name, type: 'data', contentType, properties: { label: name, required }, ...extra });

const API_KEY_DEFS = [def(1, 'apiKey', 'secret', true), def(2, 'headerName', 'string', true), def(3, 'note', 'string', false), { uuid: U(4), name: 'info', type: 'info', contentType: 'text' }];

test('dataDefinitions drops the info definitions and requiredNames lists the required data attributes', () => {
    expect(dataDefinitions(API_KEY_DEFS).map((d) => d.name)).toEqual(['apiKey', 'headerName', 'note']);
    expect(requiredNames(API_KEY_DEFS)).toEqual(['apiKey', 'headerName']);
});

test('apiKeyAttributes fills every secret with its own generated value and the other required attributes with a placeholder', () => {
    const built = apiKeyAttributes([...API_KEY_DEFS, def(5, 'second', 'secret', false)]);
    if ('problem' in built) throw new Error(built.problem);
    expect(built.attributes.map((a) => a.name).sort(), 'the optional string is left out, the optional secret is filled').toEqual(['apiKey', 'headerName', 'second']);
    expect(built.secrets).toHaveLength(2);
    expect(new Set(built.secrets).size, 'one value per secret').toBe(2);
    const api = built.attributes.find((a) => a.name === 'apiKey')!;
    expect(api).toMatchObject({ uuid: U(1), contentType: 'secret', content: [{ data: { secret: built.secrets[0] } }] });
    expect(built.attributes.find((a) => a.name === 'headerName')).toMatchObject({ contentType: 'string', content: [{ data: 'qa' }] });
    expect(containsSecret(JSON.stringify(built.attributes), built.secrets[1])).toBe(true);
});

test('apiKeyAttributes names a required attribute of a type the suite cannot fill instead of throwing', () => {
    const built = apiKeyAttributes([def(1, 'blob', 'file', true)]);
    expect(built).toEqual({ problem: expect.stringContaining('required attribute blob has content type file') });
});

test('softKeyStoreAttributes builds type, password and file from the live uuids and names a missing definition', () => {
    const defs = [def(1, SOFT_KEY_STORE.type, 'string', true), def(2, SOFT_KEY_STORE.passwordName, 'secret', true), def(3, SOFT_KEY_STORE.keyStore, 'file', true)];
    const password = `qa-${randomBytes(9).toString('base64url')}`;
    const p12 = randomBytes(24);
    const built = softKeyStoreAttributes(defs, { password, p12 });
    if ('problem' in built) throw new Error(built.problem);
    expect(built.secrets).toEqual([password]);
    expect(built.attributes).toEqual([
        { name: 'keyStoreType', uuid: U(1), version: 'v2', contentType: 'string', content: [{ data: 'PKCS12', reference: 'PKCS12' }] },
        { name: 'keyStorePassword', uuid: U(2), version: 'v2', contentType: 'secret', content: [{ data: { secret: password } }] },
        { name: 'keyStore', uuid: U(3), version: 'v2', contentType: 'file', content: [{ data: { content: p12.toString('base64'), fileName: 'keystore.p12', mimeType: 'application/x-pkcs12' } }] },
    ]);
    expect(softKeyStoreAttributes(defs.slice(0, 2), { password, p12 })).toEqual({ problem: 'the SoftKeyStore kind lists no attribute keyStore' });
});

test('withoutAttribute drops one attribute by name and omittableRequired keeps the built attributes the kind requires', () => {
    const built = apiKeyAttributes(API_KEY_DEFS);
    if ('problem' in built) throw new Error(built.problem);
    expect(withoutAttribute(built.attributes, 'apiKey').map((a) => a.name)).toEqual(['headerName']);
    expect(withoutAttribute(built.attributes, 'unknown')).toEqual(built.attributes);
    expect(omittableRequired(API_KEY_DEFS, built.attributes)).toEqual(['apiKey', 'headerName']);
    expect(omittableRequired(API_KEY_DEFS, withoutAttribute(built.attributes, 'headerName'))).toEqual(['apiKey']);
});
