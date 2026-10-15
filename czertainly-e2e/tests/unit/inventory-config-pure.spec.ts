/**
 * inventory-config (pure) — the pure parts of utils/regression/inventoryConfigApi.ts and the secret hygiene of the
 * configuration-resources spec (API-GEN-17 … 20, 28): attribute builders, the history text parser, the secret scan, the
 * connector / authority arms. No environment, no network; the wire (every request through the guard) is in
 * inventory-config-wire.spec.ts.
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    attributeOf, basicAttributes, basicDefinitions, changeKey, containsSecret, contentWithData, createdUuid, credentialBody, credentialConnectorName,
    emptyArm, groupChanges, groupEventCount, groupUuidsOf, labelOf, missingArm, parseGroupChange, randomSecret, requestVersion, requiredNotFound,
    requiredNotSet, stamp, valuesOf,
} from '../../utils/regression/inventoryConfigApi';
import type { Probe } from '../../utils/regression/inventoryApi';
import { testBlocks } from '../../utils/regression/tags';
import { randomBytes } from 'node:crypto';
// Run-scoped generated test passwords (merge follow-up 2026-10-15): no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;

const ROOT = path.resolve(__dirname, '..', '..');
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const USERNAME_DEF = { uuid: U(1), name: 'username', type: 'data', contentType: 'string', properties: { label: 'Username', required: true } };
const PASSWORD_DEF = { uuid: U(2), name: 'password', type: 'data', contentType: 'secret', properties: { label: 'Password', required: true } };
const defs = { usernameDef: USERNAME_DEF, passwordDef: PASSWORD_DEF };

const probe = (status: number, json: unknown): Probe => ({ status, contentType: 'application/json', headers: {}, text: JSON.stringify(json ?? ''), json, ms: 0 });

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

test('stamp: unique across calls made in the same millisecond', () => {
    expect(new Set(Array.from({ length: 500 }, () => stamp())).size).toBe(500);
});

test('the spec and the helper hold no literal password: the only literal secret value is the empty string of the Q9 pin', () => {
    for (const rel of ['tests/api/API-GEN-17-config-resources.api.spec.ts', 'utils/regression/inventoryConfigApi.ts']) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        const literal = [...src.matchAll(/\b(?:password|secret)\s*:\s*(['"`])([^'"`]*)\1/gi)].map((m) => m[2]).filter((v) => v !== '');
        expect(literal, `${rel}: a password / secret given as a string literal`).toEqual([]);
    }
});

// ------------------------------------------------------------------ the credential connector

test('credentialConnectorName: REG_CREDENTIAL_CONNECTOR, else the credential entry of REG_REQUIRED_CONNECTORS, else the default', () => {
    expect(credentialConnectorName({ REG_CREDENTIAL_CONNECTOR: ' My-Credential ' } as NodeJS.ProcessEnv)).toBe('My-Credential');
    expect(credentialConnectorName({ REG_REQUIRED_CONNECTORS: 'EJBCA-NG-Connector, Other-Credential-Connector' } as NodeJS.ProcessEnv)).toBe('Other-Credential-Connector');
    expect(credentialConnectorName({ REG_REQUIRED_CONNECTORS: 'EJBCA-NG-Connector' } as NodeJS.ProcessEnv)).toBe('Common-Credential-Connector');
    expect(credentialConnectorName({} as NodeJS.ProcessEnv)).toBe('Common-Credential-Connector');
});

test('labelOf: the label core prints in "Required attribute <label> not found." (properties.label, else label, else name)', () => {
    expect(labelOf(USERNAME_DEF)).toBe('Username');
    expect(labelOf({ name: 'x', label: 'Top label' })).toBe('Top label');
    expect(labelOf({ name: 'only-name' })).toBe('only-name');
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

test('groupUuidsOf: the uuids of the groups of a certificate detail, sorted; none when the member is missing', () => {
    expect(groupUuidsOf({ groups: [{ uuid: U(3) }, { uuid: U(2) }] })).toEqual([U(2), U(3)]);
    expect(groupUuidsOf({})).toEqual([]);
    expect(groupUuidsOf({ groups: [] })).toEqual([]);
});

// ------------------------------------------------------------------ the group history

test('parseGroupChange: "<old> -> <new>", each side group names joined with ", " in no defined order, "undefined" = no group; a message without the arrow is not a change', () => {
    expect(parseGroupChange('undefined -> a')).toEqual({ from: [], to: ['a'] });
    expect(parseGroupChange('b, a -> c')).toEqual({ from: ['a', 'b'], to: ['c'] });
    expect(parseGroupChange('c -> undefined')).toEqual({ from: ['c'], to: [] });
    expect(parseGroupChange('undefined -> undefined')).toEqual({ from: [], to: [] });
    expect(parseGroupChange('Certificate has been archived.')).toBeUndefined();
});

test('groupChanges / changeKey / groupEventCount: successful Update Group events only; the key is order-free and reads like the history text', () => {
    const events = [
        { event: 'Upload Certificate', status: 'SUCCESS', message: 'x -> y' },
        { event: 'Update Group', status: 'SUCCESS', message: 'undefined -> g2, g1' },
        { event: 'Update Group', status: 'SUCCESS', message: 'g1, g2 -> g3' },
        { event: 'Update Group', status: 'FAILED', message: 'g3 -> undefined' },
        { event: 'Update Group', status: 'SUCCESS', message: 'g3 -> undefined' },
        { event: 'Update Group', status: 'SUCCESS' },
    ];
    expect(groupChanges(events).map(changeKey)).toEqual(['undefined -> g1, g2', 'g1, g2 -> g3', 'g3 -> undefined']);
    expect(groupEventCount(events), 'every Update Group event counts for the no-op check').toBe(5);
    expect(groupEventCount([])).toBe(0);
});

// ------------------------------------------------------------------ RA profile arms

test('requestVersion / missingArm / emptyArm: the required attribute is left out, or listed without content; the other attributes stay', () => {
    expect(requestVersion({ version: 3 })).toBe('v3');
    expect(requestVersion({ version: 'v3' })).toBe('v3');
    expect(requestVersion({ version: 2 })).toBe('v2');
    expect(requestVersion({})).toBe('v2');
    const target = { uuid: U(7), name: 'template', contentType: 'OBJECT', version: 2 };
    const base = [{ version: 'v2', uuid: U(8), name: 'other', contentType: 'string', content: [{ data: 'x' }] }, { version: 'v2', uuid: U(7), name: 'template', contentType: 'object', content: [{ data: { id: 1 } }] }];
    expect(missingArm(base, target).map((a) => a.name)).toEqual(['other']);
    expect(missingArm([], target)).toEqual([]);
    const empty = emptyArm(base, target);
    expect(empty.map((a) => a.name)).toEqual(['other', 'template']);
    expect(empty[1], 'listed, no content member, content type lower-cased').toEqual({ version: 'v2', uuid: U(7), name: 'template', contentType: 'object' });
    expect(base, 'the base attributes are not changed').toHaveLength(2);
});

test('the connector texts the rows expect (AttributeDefinitionUtils:388 and :397)', () => {
    expect(requiredNotFound('Username')).toBe('Required attribute Username not found.');
    expect(requiredNotSet('Password')).toBe('Value of required attribute Password not set.');
});

// ------------------------------------------------------------------ the spec's declarations (ids, priorities, pins, the bug row, the local row, the guard-request row)

test('the spec declares the ledger ids 17 / 18 / 19 / 20 / 28 as `<ID>[<row>]` rows with the tags the batch rules ask for', () => {
    const rel = 'tests/api/API-GEN-17-config-resources.api.spec.ts';
    const blocks = testBlocks(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel);
    const ids = new Set(blocks.map((b) => /^(API-GEN-\d+)\[[a-z0-9-]+\]: /.exec(b.title)?.[1]));
    expect([...ids].sort(), 'every title is <ID>[<row>]: <behaviour> of the five ledger ids (21 / 22 / 30 are P2 / blocked rows, left out)').toEqual(['API-GEN-17', 'API-GEN-18', 'API-GEN-19', 'API-GEN-20', 'API-GEN-28']);
    expect(new Set(blocks.map((b) => b.title.split(':')[0])).size, 'no duplicate row').toBe(blocks.length);
    for (const b of blocks) {
        expect(b.tags, b.title).toContain('@api');
        expect(b.tags.filter((t) => /^@p[123]$/.test(t)), b.title).toHaveLength(1);
    }
    // The pins are P2 tests of their own; the bug row calls test.fail() before its failing step.
    const pins = blocks.filter((b) => /\bpin:\s*'Q\d+'/.test(b.body));
    expect(pins.map((b) => [b.title.split(':')[0], /\bpin:\s*'(Q\d+)'/.exec(b.body)![1], b.tags.filter((t) => /^@p[123]$/.test(t))])).toEqual([
        ['API-GEN-18[empty-password]', 'Q9', ['@p2']],
        ['API-GEN-19[pin-q8]', 'Q8', ['@p2']],
    ]);
    const bugs = blocks.filter((b) => b.tags.some((t) => t.startsWith('@bug:')));
    expect(bugs.map((b) => [b.title.split(':')[0], b.tags.filter((t) => t.startsWith('@bug:'))])).toEqual([['API-GEN-18[attribute-by-name]', ['@bug:core#2512']]]);
    expect(bugs[0].body).toMatch(/\btest\.fail\(/);
    expect(bugs[0].body.indexOf('test.fail('), 'test.fail() sits right before the failing step: after the ledger adoption, before the orphan assertion').toBeGreaterThan(bugs[0].body.indexOf('adoptByName('));
    // The unknown-group arm is the only @local row and lives under describeLocal(test).
    const local = blocks.filter((b) => b.tags.includes('@local'));
    expect(local.map((b) => b.title.split(':')[0])).toEqual(['API-GEN-20[unknown-group]']);
    expect(local[0].describes.join(' / ')).toContain('(local stack)');
    expect(fs.readFileSync(path.join(ROOT, rel), 'utf8')).toMatch(/describeLocal\(test\);/);
    // No fixme is left: the malformed-uuid row waited for guard request GR-1, accepted as GD-13 and merged.
    expect(blocks.filter((b) => b.kind === 'fixme').map((b) => b.title)).toEqual([]);
});
