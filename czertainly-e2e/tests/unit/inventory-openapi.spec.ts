/**
 * utils/regression/inventoryOpenapi.ts (API-GEN-23…25): the OpenAPI reader and validator on a SMALL inline document — a missing
 * required member, a wrong type, an enum violation, a bad date-time, null where forbidden / allowed (3.1 `type: [x, "null"]`), nested
 * $ref, arrays, extra members (reported), formats, the paging invariants and the zone-designator scan. No file outside the sandbox.
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import {
    dateTimeZoneProblems, describeViolations, isBase64, openapiSource, OpenApiDocument, OpenApiValidator, pageProblems, pageRows, parseOpenApi,
} from '../../utils/regression/inventoryOpenapi';

const DOC: OpenApiDocument = {
    openapi: '3.1.0',
    paths: {
        '/v1/things/{uuid}': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } } } } },
        '/v1/things': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Thing' } } } } } } } },
        '/v1/page': { post: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Page' } } } } } } },
    },
    components: {
        schemas: {
            State: { type: 'string', enum: ['issued', 'revoked'] },
            Owner: { type: 'object', required: ['uuid'], properties: { uuid: { type: 'string', format: 'uuid' }, name: { type: 'string' } } },
            Thing: {
                type: 'object',
                required: ['uuid', 'state', 'created'],
                properties: {
                    uuid: { type: 'string', format: 'uuid' },
                    state: { $ref: '#/components/schemas/State', description: 'the state' },
                    created: { type: 'string', format: 'date-time' },
                    size: { type: 'integer', format: 'int64' },
                    note: { type: ['string', 'null'] },
                    owner: { $ref: '#/components/schemas/Owner' },
                    tags: { type: 'array', items: { type: 'string' } },
                    content: { type: 'string', format: 'byte' },
                },
            },
            Page: { type: 'object', properties: { things: { type: 'array', items: { $ref: '#/components/schemas/Thing' } }, totalItems: { type: 'integer' } } },
        },
    },
};

const GOOD = { uuid: '11111111-2222-4333-8444-555555555555', state: 'issued', created: '2026-10-14T10:00:00.000Z', size: 12, note: null, owner: { uuid: '11111111-2222-4333-8444-555555555556', name: 'x' }, tags: ['a'], content: 'AAEC' };
const THING = { kind: 'component', name: 'Thing' } as const;
const v = new OpenApiValidator(DOC);
const problems = (instance: unknown) => v.validate(THING, instance).map((x) => `${x.instancePath} ${x.message}`);

test('a conforming instance has no violation; the response schema of an operation resolves like the component', () => {
    expect(v.validate(THING, GOOD)).toEqual([]);
    const use = { kind: 'response', path: '/v1/things/{uuid}', method: 'get', status: '200' } as const;
    expect(v.has(use)).toBe(true);
    expect(v.validate(use, GOOD)).toEqual([]);
    expect(v.validate(use, { ...GOOD, state: 'nope' })).toHaveLength(1);
    const list = { kind: 'response', path: '/v1/things', method: 'get', status: '200' } as const;
    expect(v.validate(list, [GOOD, GOOD])).toEqual([]);
    expect(v.validate(list, [GOOD, { ...GOOD, uuid: 'x' }])[0].instancePath).toBe('/1/uuid');
    expect(v.has({ kind: 'component', name: 'Missing' })).toBe(false);
    expect(v.has({ kind: 'response', path: '/v1/none', method: 'get', status: '200' })).toBe(false);
});

test('violations name the instance pointer, the keyword and the offending value', () => {
    expect(problems({ ...GOOD, uuid: undefined }).join('|')).toMatch(/required property 'uuid'/);
    expect(problems({ ...GOOD, size: 'big' }).join('|')).toMatch(/\/size must be integer/);
    const e = v.validate(THING, { ...GOOD, state: 'archived' });
    expect(e[0]).toMatchObject({ instancePath: '/state', value: 'archived' });
    expect(e[0].message).toMatch(/allowed values/);
    expect(problems({ ...GOOD, created: '2026-10-14 10:00' }).join('|')).toMatch(/\/created must match format "date-time"/);
    expect(problems({ ...GOOD, created: '2026-10-14T10:00:00' }).join('|'), 'a date-time without a zone designator is refused by the format').toMatch(/format "date-time"/);
    expect(problems({ ...GOOD, owner: { name: 'no uuid' } }).join('|'), 'a nested $ref is checked').toMatch(/\/owner must have required property 'uuid'/);
    expect(problems({ ...GOOD, tags: ['a', 3] }).join('|')).toMatch(/\/tags\/1 must be string/);
    expect(problems({ ...GOOD, content: 'not base64!' }).join('|')).toMatch(/format "byte"/);
    expect(describeViolations('detail', v.validate(THING, { ...GOOD, state: 'x', size: 'y' }), 1)).toMatch(/… 1 more/);
});

test('null: forbidden where the schema says a plain type, allowed where the 3.1 type list includes "null"', () => {
    expect(problems({ ...GOOD, note: null })).toEqual([]);
    expect(problems({ ...GOOD, size: null }).join('|')).toMatch(/\/size must be integer/);
    expect(problems({ ...GOOD, owner: null }).join('|')).toMatch(/\/owner must be object/);
});

test('extraMembers reports members the schema does not declare (nested and in arrays), and fails nothing', () => {
    const extra = { ...GOOD, surprise: 1, owner: { ...GOOD.owner, nick: 'z' } };
    expect(v.validate(THING, extra)).toEqual([]);
    expect(v.extraMembers(THING, extra).sort()).toEqual(['/owner/nick', '/surprise']);
    const list = { kind: 'response', path: '/v1/things', method: 'get', status: '200' } as const;
    expect(v.extraMembers(list, [GOOD, { ...GOOD, more: true }])).toEqual(['/1/more']);
    expect(v.extraMembers(THING, GOOD)).toEqual([]);
});

test('parseOpenApi and openapiSource: a named reason for every unusable input, never a throw', () => {
    expect(parseOpenApi('not json')).toMatchObject({ problem: expect.stringMatching(/not JSON/) });
    expect(parseOpenApi('{"swagger":"2.0","paths":{"/a":{}}}')).toMatchObject({ problem: expect.stringMatching(/OpenAPI 3/) });
    expect(parseOpenApi('{"openapi":"3.1.0","paths":{}}')).toMatchObject({ problem: expect.stringMatching(/no paths/) });
    expect('doc' in parseOpenApi(JSON.stringify(DOC))).toBe(true);
    expect(openapiSource({})).toMatchObject({ skip: expect.stringMatching(/REG_OPENAPI_FILE is not set/) });
    expect(openapiSource({ REG_OPENAPI_FILE: '/no/such/file.json' })).toMatchObject({ skip: expect.stringMatching(/cannot be read/) });
});

test('openapiSource reads the file named by REG_OPENAPI_FILE and caches it per modification time', ({}, testInfo) => {
    const file = testInfo.outputPath('doc.json');
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(DOC));
    const first = openapiSource({ REG_OPENAPI_FILE: file });
    expect('doc' in first && first.doc.paths['/v1/page']).toBeTruthy();
    const second = openapiSource({ REG_OPENAPI_FILE: file });
    expect('doc' in first && 'doc' in second && first.doc === second.doc, 'the parsed document is cached per file and mtime').toBe(true);
    fs.writeFileSync(file, 'garbage');
    expect(openapiSource({ REG_OPENAPI_FILE: file })).toMatchObject({ skip: expect.stringMatching(/not JSON/) });
});

test('pageProblems: totalPages = ceil(totalItems / itemsPerPage), rows <= itemsPerPage, integers; a non-page is no problem', () => {
    const page = (o: object) => ({ things: [1, 2, 3], totalItems: 25, itemsPerPage: 10, pageNumber: 1, totalPages: 3, ...o });
    expect(pageProblems(page({}))).toEqual([]);
    expect(pageProblems(page({ totalPages: 2 })).join('|')).toMatch(/totalPages 2 ≠ ceil\(totalItems 25 \/ itemsPerPage 10\) = 3/);
    expect(pageProblems(page({ itemsPerPage: 2 })).join('|')).toMatch(/3 rows on a page of itemsPerPage 2/);
    expect(pageProblems(page({ totalItems: '25' })).join('|')).toMatch(/totalItems is not a non-negative integer/);
    expect(pageProblems(page({ totalItems: 0, totalPages: 0, things: [] }))).toEqual([]);
    expect(pageProblems([1, 2])).toEqual([]);
    expect(pageProblems({ foo: 1 })).toEqual([]);
    expect(pageRows(page({}))).toMatchObject({ member: 'things' });
    expect(pageRows([])).toBeUndefined();
});

test('dateTimeZoneProblems finds a date-time without a zone designator anywhere; isBase64', () => {
    expect(dateTimeZoneProblems({ a: '2026-10-14T10:00:00Z', b: ['2026-10-14T10:00:00+02:00'], c: '2026-10-14', d: 'text' })).toEqual([]);
    expect(dateTimeZoneProblems({ a: { b: '2026-10-14T10:00:00' } })).toEqual(['/a/b: 2026-10-14T10:00:00']);
    expect(isBase64('AAEC')).toBe(true);
    expect(isBase64('AAE')).toBe(false);
    expect(isBase64('A A E C')).toBe(false);
});
