/**
 * Unit tests of utils/regression/inventory/credentialsApi.ts: the secret helpers, the credential connector name,
 * the Basic attribute definitions and builders, the request body and the readers of a created credential.
 * No environment, no network; the requests on the wire are in credentialsAndGroupsWire.spec.ts.
 */
import { expect, test } from '@playwright/test';
import { attributeOf, basicAttributes, basicDefinitions, containsSecret, contentWithData, credentialBody, credentialConnectorName, randomSecret, valuesOf } from '../../utils/regression/inventory/credentialsApi';
import { randomBytes } from 'node:crypto';
import { ApiAnswer } from '../../utils/regression/apiReads';
import { fakeAnswer } from './helpers/fakeAnswer';
import { createdUuid } from '../../utils/regression/ownCrud';

// Run-scoped generated test passwords (merge follow-up 2026-10-15): no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const USERNAME_DEF = { uuid: U(1), name: 'username', type: 'data', contentType: 'string', properties: { label: 'Username', required: true } };
const PASSWORD_DEF = { uuid: U(2), name: 'password', type: 'data', contentType: 'secret', properties: { label: 'Password', required: true } };
const defs = { usernameDef: USERNAME_DEF, passwordDef: PASSWORD_DEF };

const probe = (status: number, json: unknown): ApiAnswer => fakeAnswer(status, JSON.stringify(json ?? ''), { json });

// ------------------------------------------------------------------ secrets and names

test('randomSecret: a fresh value per call from node:crypto, in the JSON-safe alphabet; containsSecret finds it in a body text and ignores an empty secret', () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomSecret()));
    expect(seen.size, 'no repeat in 200 calls').toBe(200);
    for (const s of seen) expect(s).toMatch(/^qa-[A-Za-z0-9_-]{16}$/);
    const secret = randomSecret();
    expect(containsSecret(JSON.stringify({ attributes: [{ content: [{ data: { secret } }] }] }), secret)).toBe(true);
    expect(containsSecret(JSON.stringify({ attributes: [{ content: [{}] }] }), secret)).toBe(false);
    expect(containsSecret('anything', ''), 'an empty secret never counts as a leak').toBe(false);
});

// ------------------------------------------------------------------ the credential connector

test('credentialConnectorName: REG_CREDENTIAL_CONNECTOR, else the credential entry of REG_REQUIRED_CONNECTORS, else the default', () => {
    expect(credentialConnectorName({ REG_CREDENTIAL_CONNECTOR: ' My-Credential ' } as NodeJS.ProcessEnv)).toBe('My-Credential');
    expect(credentialConnectorName({ REG_REQUIRED_CONNECTORS: 'EJBCA-NG-Connector, Other-Credential-Connector' } as NodeJS.ProcessEnv)).toBe('Other-Credential-Connector');
    expect(credentialConnectorName({ REG_REQUIRED_CONNECTORS: 'EJBCA-NG-Connector' } as NodeJS.ProcessEnv)).toBe('Common-Credential-Connector');
    expect(credentialConnectorName({} as NodeJS.ProcessEnv)).toBe('Common-Credential-Connector');
});

test('basicDefinitions: username + password data attributes with uuids and a secret password; anything else is a named problem', () => {
    expect(basicDefinitions([USERNAME_DEF, PASSWORD_DEF])).toEqual({ usernameDef: USERNAME_DEF, passwordDef: PASSWORD_DEF });
    expect(basicDefinitions([{ ...USERNAME_DEF, type: 'info' }, PASSWORD_DEF])).toEqual({ problem: expect.stringContaining('no username / password') });
    expect(basicDefinitions([USERNAME_DEF])).toEqual({ problem: expect.stringContaining('no username / password') });
    expect(basicDefinitions([USERNAME_DEF, { ...PASSWORD_DEF, contentType: 'string' }])).toEqual({ problem: expect.stringContaining('not secret') });
    expect(basicDefinitions([{ ...USERNAME_DEF, uuid: undefined }, PASSWORD_DEF])).toEqual({ problem: expect.stringContaining('no uuid') });
    expect(basicDefinitions({})).toEqual({ problem: expect.stringContaining('not an array') });
});

test('basicAttributes: the current contract (uuid + content [{ data }], the password as { secret }); omitted / content-less / empty values; the by-name shape has no uuid', () => {
    expect(basicAttributes(defs, { username: 'u1', password: GEN_PW_1 })).toEqual([
        { version: 'v2', uuid: U(1), name: 'username', contentType: 'string', content: [{ data: 'u1' }] },
        { version: 'v2', uuid: U(2), name: 'password', contentType: 'secret', content: [{ data: { secret: GEN_PW_1 } }] },
    ]);
    expect(basicAttributes(defs, { password: GEN_PW_1 }).map((a) => a.name), 'username undefined: left out').toEqual(['password']);
    expect(basicAttributes(defs, { username: 'u1' }).map((a) => a.name), 'password undefined: left out').toEqual(['username']);
    expect(basicAttributes(defs, {})).toEqual([]);
    const notSet = basicAttributes(defs, { username: 'u1', password: null });
    expect(notSet[1], 'null: listed without a content member').toEqual({ version: 'v2', uuid: U(2), name: 'password', contentType: 'secret' });
    expect('content' in notSet[1]).toBe(false);
    expect(basicAttributes(defs, { username: 'u1', password: '' })[1].content, 'the empty string is a secret of ""').toEqual([{ data: { secret: '' } }]);
    const byName = basicAttributes(defs, { username: 'u1', password: GEN_PW_1 }, { withUuid: false });
    expect(byName.every((a) => !('uuid' in a)), 'the legacy by-name shape (core#2512 trigger): no uuid').toBe(true);
    expect(byName.map((a) => a.name)).toEqual(['username', 'password']);
});

test('credentialBody: JSON of a body drops an undefined member, keeps null, and lets a row override anything', () => {
    const base = credentialBody({ uuid: U(9) }, 'n', [], []);
    expect(base).toEqual({ name: 'n', connectorUuid: U(9), kind: 'Basic', attributes: [], customAttributes: [] });
    expect(JSON.parse(JSON.stringify(credentialBody({ uuid: U(9) }, null, [], [], { connectorUuid: undefined })))).toEqual({ name: null, kind: 'Basic', attributes: [], customAttributes: [] });
    expect(credentialBody({ uuid: U(9) }, 'n', [], [], { kind: 'X', attributes: [{ a: 1 }] })).toMatchObject({ kind: 'X', attributes: [{ a: 1 }] });
});

// ------------------------------------------------------------------ response readers

test('attributeOf / contentWithData / valuesOf: a masked secret has no data item; a plain attribute exposes its values', () => {
    const detail = {
        attributes: [
            { name: 'username', contentType: 'string', content: [{ data: 'u1' }] },
            { name: 'password', contentType: 'secret', content: [{}] },
            { name: 'password2', contentType: 'secret', content: [{ data: null }, { reference: 'x' }] },
            { name: 'leaky', contentType: 'secret', content: [{ data: { secret: 'p' } }] },
        ],
        customAttributes: [{ name: 'c1', content: [{ data: 'v' }] }, { name: 'c2' }],
    };
    expect(attributeOf(detail, 'username')?.name).toBe('username');
    expect(attributeOf(detail, 'nope')).toBeUndefined();
    expect(attributeOf(undefined, 'x')).toBeUndefined();
    expect(contentWithData(attributeOf(detail, 'password'))).toEqual([]);
    expect(contentWithData(attributeOf(detail, 'password2'))).toEqual([]);
    expect(contentWithData(attributeOf(detail, 'leaky'))).toEqual([{ data: { secret: 'p' } }]);
    expect(valuesOf(detail, 'attributes', 'username')).toEqual(['u1']);
    expect(valuesOf(detail, 'customAttributes', 'c1')).toEqual(['v']);
    expect(valuesOf(detail, 'customAttributes', 'c2'), 'an attribute without content').toEqual([]);
    expect(valuesOf(detail, 'customAttributes', 'missing'), 'an attribute that is gone').toEqual([]);
    expect(valuesOf(undefined, 'attributes', 'x')).toEqual([]);
});

test('createdUuid: only a 2xx answer with a canonical uuid counts as a created object', () => {
    expect(createdUuid(probe(201, { uuid: U(5) }))).toBe(U(5));
    expect(createdUuid(probe(200, { uuid: U(5) }))).toBe(U(5));
    expect(createdUuid(probe(409, { uuid: U(5) }))).toBeUndefined();
    expect(createdUuid(probe(201, { uuid: 'not-a-uuid' }))).toBeUndefined();
    expect(createdUuid(probe(201, undefined))).toBeUndefined();
    expect(createdUuid(probe(422, ['x']))).toBeUndefined();
});
