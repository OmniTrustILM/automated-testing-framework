/**
 * customAttributes — the request attributes the helpers send for custom and required attributes: the response →
 * request copy (`toRequestAttribute`), the one filler of required custom attributes and its version / contentType
 * rules. Pure, no environment.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { attributeRequest } from '../../utils/regression/inventory/seedOwnedObjects';
import { requiredAttributeItems, requiredCustomAttributes, toRequestAttribute } from '../../utils/regression/customAttributes';

type Json = Record<string, any>;

test('toRequestAttribute copies uuid, name, content type, content and the version (v2 when absent)', () => {
    const content = [{ reference: 'EE', data: { id: 1, name: 'EE' } }];
    expect(toRequestAttribute({ version: 'v3', uuid: 'u', name: 'n', label: 'L', type: 'data', contentType: 'object', content })).toEqual({ version: 'v3', uuid: 'u', name: 'n', contentType: 'object', content });
    expect(toRequestAttribute({ uuid: 'u', name: 'n', contentType: 'string', content: [{ data: 'x' }] }).version).toBe('v2');
});

// ------------------------------------------------------------------ requiredAttributeItems: the one required-custom-attribute filler

const NOW = new Date('2026-10-15T13:45:56.789Z');
const def = (o: Json): Json => ({ uuid: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'attr', properties: { required: true }, ...o });

// requiredAttributeItems: version v3 by default (the definition's own kept) and the contentType on the attribute AND on every
// item
test('requiredAttributeItems defaults to v3 and sets the contentType on attribute and every item', () => {
    const out = requiredAttributeItems([def({ contentType: 'string' }), def({ contentType: 'string', version: 'v2', uuid: 'aaaaaaaa-0000-4000-8000-000000000002' })], 'users', 'val', NOW);
    expect(out[0]).toMatchObject({ version: 'v3', contentType: 'string', content: [{ data: 'val', contentType: 'string' }] });
    expect(out[1].version).toBe('v2');
});

// requiredAttributeItems: one value per content type (string, text, codeblock, integer, float, boolean, date, time, datetime)
test('requiredAttributeItems fills one value per content type, from string to datetime', () => {
    const data = (contentType: string): unknown => requiredAttributeItems([def({ contentType })], 'groups', 'val', NOW)[0].content[0].data;
    expect(['string', 'text', 'codeblock'].map(data)).toEqual(['val', 'val', 'val']);
    expect(['integer', 'float'].map(data)).toEqual([1, 1]);
    expect(data('boolean')).toBe(true);
    expect(data('date')).toBe('2026-10-15');
    expect(data('time'), 'HH:mm:ss (core TimeAttributeContentV3)').toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(data('time')).toBe('13:45:56');
    expect(data('datetime')).toBe('2026-10-15T13:45:56');
    for (const t of ['time', 'datetime', 'date']) expect(requiredAttributeItems([def({ contentType: t })], 'groups', 'val', NOW)[0].content[0].contentType).toBe(t);
});

// requiredAttributeItems: a list copies its first predefined item as is and completes the contentType; optional attributes are
// left out; an unfillable type throws
test('requiredAttributeItems copies the first predefined list item, skips optional, throws if unfillable', () => {
    const list = def({ contentType: 'string', properties: { required: true, list: true }, content: [{ reference: 'r1', data: 'd1', contentType: 'string' }, { reference: 'r2', data: 'd2' }] });
    expect(requiredAttributeItems([list], 'users', 'val', NOW)[0].content).toEqual([{ reference: 'r1', data: 'd1', contentType: 'string' }]);
    const noType = def({ contentType: 'string', properties: { required: true, list: true }, content: [{ reference: 'r2', data: 'd2' }] });
    expect(requiredAttributeItems([noType], 'users', 'val', NOW)[0].content).toEqual([{ reference: 'r2', data: 'd2', contentType: 'string' }]);
    expect(requiredAttributeItems([def({ contentType: 'string', properties: { required: false } })], 'users', 'val', NOW)).toEqual([]);
    expect(() => requiredAttributeItems([def({ contentType: 'secret' })], 'users', 'val', NOW)).toThrow(/cannot fill/);
});

// ------------------------------------------------------------------ every caller of the one filler sends v3 items with the contentType

function fakeApi(handler: (url: string) => { status: number; body?: unknown }) {
    const calls: string[] = [];
    const get = async (url: string) => {
        calls.push(url);
        const r = handler(url);
        return { status: () => r.status, headers: () => ({}), ok: () => r.status >= 200 && r.status < 300, json: async () => r.body, text: async () => JSON.stringify(r.body ?? '') };
    };
    return { api: { get } as any, calls };
}

const U = (n: number): string => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DEFS: Json[] = [
    { uuid: U(1), name: 't', version: 3, contentType: 'time', properties: { required: true } },
    { uuid: U(2), name: 'dt', version: 3, contentType: 'datetime', properties: { required: true } },
    { uuid: U(3), name: 's', contentType: 'string', properties: { required: true } },
    { uuid: U(4), name: 'o', contentType: 'string', properties: { required: false } },
];
const definitions = () => fakeApi((url) => (url.includes('/attributes/custom/resources/') ? { status: 200, body: DEFS } : { status: 404, body: {} }));

for (const [label, fill] of [
    ['regressionApi.requiredCustomAttributes', (api: any) => requiredCustomAttributes(api, 'groups', 'val')],
] as const) {
    // ${label} is the one filler: a time and a datetime definition give v3 items with the contentType on the attribute and the item
    test(`${label} is the one filler: time and datetime definitions give v3 items`, async () => {
        const { api } = definitions();
        const out = await fill(api);
        expect(out.map((a: Json) => [a.name, a.version, a.contentType, a.content[0].contentType])).toEqual([['t', 'v3', 'time', 'time'], ['dt', 'v3', 'datetime', 'datetime'], ['s', 'v3', 'string', 'string']]);
        expect(out[0].content[0].data).toMatch(/^\d\d:\d\d:\d\d$/);
        expect(out[1].content[0].data).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    });
}

test('inventoryOwn.attributeRequest sends version v3 and the contentType on every item', () => {
    expect(attributeRequest({ uuid: U(9), name: 'n', contentType: 'string', data: ['a', 'b'] })).toEqual({
        version: 'v3', uuid: U(9), name: 'n', contentType: 'string', content: [{ data: 'a', contentType: 'string' }, { data: 'b', contentType: 'string' }],
    });
});
test('attributeRequest: a predefined-list value carries reference, data and contentType, like the list item it picks', () => {
    expect(attributeRequest({ uuid: U(9), name: 'pick', contentType: 'string', data: ['a', 'c'], list: true }).content).toEqual([
        { reference: 'a', data: 'a', contentType: 'string' },
        { reference: 'c', data: 'c', contentType: 'string' },
    ]);
    expect(attributeRequest({ uuid: U(9), name: 'txt', contentType: 'string', data: ['red'] }).content, 'a free value has no reference').toEqual([{ data: 'red', contentType: 'string' }]);
});


// ------------------------------------------------------------------ a fifth copy fails the suite

/** Functions of utils/ that read connector attribute DEFINITIONS (not custom attributes) and fill their own required ones: a different contract (v2 data attributes). */
const CONNECTOR_ATTRIBUTE_FILLERS = new Set(['requestAttributesFrom', 'signatureAttributesFrom']);

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

/** Top-level blocks of a file: a block starts at a column-0 `function` / `export` / `const` line. */
function blocks(text: string): Array<{ name: string; body: string }> {
    const out: Array<{ name: string; body: string }> = [];
    let cur: { name: string; lines: string[] } | undefined;
    for (const line of text.split('\n')) {
        const m = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*[:=])/.exec(line);
        if (m) {
            if (cur) out.push({ name: cur.name, body: cur.lines.join('\n') });
            cur = { name: m[1] ?? m[2], lines: [] };
        }
        cur?.lines.push(line);
    }
    if (cur) out.push({ name: cur.name, body: cur.lines.join('\n') });
    return out;
}

// utils/ holds ONE required-custom-attribute filler (customAttributes.requiredAttributeItems): no other function builds
// `content: [{ data ... }]` items from required attribute definitions
test('utils/ holds one required-custom-attribute filler and no other function builds its content items', () => {
    const utils = path.resolve(__dirname, '../../utils');
    const shared = path.join(utils, 'regression', 'customAttributes.ts');
    const offenders: string[] = [];
    for (const file of sourceFiles(utils)) {
        if (file === shared) continue;
        for (const b of blocks(fs.readFileSync(file, 'utf8'))) {
            if (CONNECTOR_ATTRIBUTE_FILLERS.has(b.name)) continue;
            const code = b.body.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
            const readsRequired = /properties\??\.required/.test(code) || /attributes\/custom\/resources\/\$\{[^}]*\}[`'"]/.test(code);
            const buildsItems = /content:\s*\[\s*\{\s*data/.test(code) || /content:\s*\[\s*item\s*\]/.test(code);
            const callsShared = /requiredAttributeItems|requiredCustomAttributes\b/.test(code);
            if (readsRequired && buildsItems && !callsShared) offenders.push(`${path.relative(utils, file)}: ${b.name}`);
            if (/required custom attribute .* cannot fill/.test(code)) offenders.push(`${path.relative(utils, file)}: ${b.name} (own "cannot fill" error)`);
        }
    }
    expect(offenders, 'a second copy of the filler: call customAttributes.requiredCustomAttributes instead (live runs 2-4)').toEqual([]);
});
