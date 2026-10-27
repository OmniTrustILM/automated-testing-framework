/**
 * attributeVersion — `requestVersion` turns core's numeric definition version (3 / 2) and its string forms into
 * "v3" / "v2", and every helper that copies an attribute definition sends the string form. Pure.
 */
import { expect, test } from '@playwright/test';
import type { AttributeDefinition } from '../../utils/regression/platform/cryptoAlgorithmCases';
import { requestVersion } from '../../utils/regression/attributeVersion';
import { requiredAttributeItems, toRequestAttribute, requestAttributesFrom, toRequestAttributes } from '../../utils/regression/customAttributes';

type Json = Record<string, any>;

const NOW = new Date('2026-10-15T13:45:56.789Z');
const def = (o: Json): Json => ({ uuid: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'attr', properties: { required: true }, ...o });

// ------------------------------------------------------------------ seen on a live tier: version is a NUMBER on the wire

// requestVersion turns core's NUMERIC definition version (3 / 2) and the string forms into "v3" / "v2"; absent follows the fallback
test('requestVersion turns numeric and string definition versions into v3 / v2; absent uses fallback', () => {
    expect([3, '3', 'v3', 'V3'].map((v) => requestVersion({ version: v }))).toEqual(['v3', 'v3', 'v3', 'v3']);
    expect([2, '2', 'v2'].map((v) => requestVersion({ version: v }))).toEqual(['v2', 'v2', 'v2']);
    expect(requestVersion({})).toBe('v2');
    expect(requestVersion(undefined, 'v3')).toBe('v3');
    expect(requestVersion({ version: 7 }, 'v3')).toBe('v3');
});

// every helper that copies a definition sends the STRING version (numeric fixtures, as core sends them)
test('every helper that copies a definition sends the string version, given numeric fixtures', () => {
    const required = requiredAttributeItems([def({ contentType: 'string', version: 3 }), def({ contentType: 'string', version: 2, uuid: 'aaaaaaaa-0000-4000-8000-000000000002' }), def({ contentType: 'string', uuid: 'aaaaaaaa-0000-4000-8000-000000000003' })], 'users', 'v', NOW);
    expect(required.map((a) => a.version)).toEqual(['v3', 'v2', 'v3']);
    expect(toRequestAttribute({ version: 3, uuid: 'u', name: 'n', contentType: 'string', content: [] }).version).toBe('v3');
    expect(toRequestAttribute({ version: 2, uuid: 'u', name: 'n', contentType: 'string', content: [] }).version).toBe('v2');
    expect(toRequestAttributes([{ version: 3, uuid: 'u', name: 'n', contentType: 'string', content: [], type: 'data' }])[0].version).toBe('v3');
    const filled = requestAttributesFrom([{ name: 'a', uuid: 'u', contentType: 'string', type: 'data', version: 3, properties: { required: true } } as AttributeDefinition]);
    expect(filled[0].version).toBe('v3');
    for (const a of [...required, ...filled]) expect(typeof a.version, 'never a number on the wire').toBe('string');
});

test('requestAttributesFrom: every v3 content item carries contentType (given, fallback, list copy); v2 items stay {data}', () => {
    const v3 = (extra: Record<string, unknown>) => ({ name: 'n', contentType: 'string', uuid: 'u', type: 'data', version: 3, properties: { required: true }, ...extra }) as AttributeDefinition;
    const out = requestAttributesFrom([
        v3({ name: 'given', contentType: 'string' }),
        v3({ name: 'pass', contentType: 'secret' }),
        v3({ name: 'str', contentType: 'string' }),
        v3({ name: 'flag', contentType: 'boolean' }),
        v3({ name: 'num', contentType: 'integer' }),
        v3({ name: 'list', contentType: 'string', properties: { required: true, list: true }, content: [{ reference: 'A', data: 'a' }] }),
        v3({ name: 'listOwn', contentType: 'string', properties: { required: true, list: true }, content: [{ reference: 'B', data: 'b', contentType: 'text' }] }),
    ], { given: 'g', pass: 's3cr3t' }, 'fb');
    expect(out.map((a) => [a.name, a.version, a.content])).toEqual([
        ['given', 'v3', [{ data: 'g', contentType: 'string' }]],
        ['pass', 'v3', [{ data: { secret: 's3cr3t' }, contentType: 'secret' }]],
        ['str', 'v3', [{ data: 'fb', contentType: 'string' }]],
        ['flag', 'v3', [{ data: false, contentType: 'boolean' }]],
        ['num', 'v3', [{ data: 1, contentType: 'integer' }]],
        ['list', 'v3', [{ reference: 'A', data: 'a', contentType: 'string' }]],
        ['listOwn', 'v3', [{ reference: 'B', data: 'b', contentType: 'text' }]],
    ]);
    const v2 = requestAttributesFrom([{ name: 'given', uuid: 'u', contentType: 'string', type: 'data', version: 2 } as AttributeDefinition, { name: 'str', uuid: 'u', contentType: 'string', type: 'data', version: 2, properties: { required: true } } as AttributeDefinition], { given: 'g' }, 'fb');
    expect(v2.map((a) => [a.version, a.content])).toEqual([['v2', [{ data: 'g' }]], ['v2', [{ data: 'fb' }]]]);
});
