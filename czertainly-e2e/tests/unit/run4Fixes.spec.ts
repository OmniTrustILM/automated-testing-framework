/**
 * Fix pass after live run 4 (2026-10-15) — unit rows:
 * - G6: ONE filler of required custom attributes (`regressionApi.requiredCustomAttributes`): every former copy delegates to it and sends the v3 item
 *   (`time`, `datetime`, version, item contentType); a scan of utils/ fails when a further copy appears;
 * - G9: `waitForSecretState` polls the API state (inactive -> active), stops on failed, times out with the detail.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { requiredCustomFor } from '../../utils/regression/inventoryConfigApi';
import { attributeRequest, requiredAttributeValues } from '../../utils/regression/inventoryOwn';
import { requiredCustomAttributesOf, waitForSecretState } from '../../utils/regression/platformApi';

type Json = Record<string, any>;

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
    ['inventoryOwn.requiredAttributeValues', (api: any) => requiredAttributeValues(api, 'groups', 'val')],
    ['inventoryConfigApi.requiredCustomFor', (api: any) => requiredCustomFor(api, 'groups', 'val')],
    ['platformApi.requiredCustomAttributesOf', (api: any) => requiredCustomAttributesOf(api, 'groups', 'val')],
] as const) {
    test(`${label} delegates to the one filler: a time and a datetime definition give v3 items with the contentType on the attribute and the item`, async () => {
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

test('utils/ holds ONE required-custom-attribute filler (regressionApi.requiredAttributeItems): no other function builds `content: [{ data ... }]` items from required attribute definitions', () => {
    const utils = path.resolve(__dirname, '../../utils');
    const shared = path.join(utils, 'regression', 'regressionApi.ts');
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
    expect(offenders, 'a second copy of the filler: call regressionApi.requiredCustomAttributes instead (live runs 2-4)').toEqual([]);
});

// ------------------------------------------------------------------ G9

test('waitForSecretState: inactive, then active -> the detail; polls the API state', async () => {
    const states = ['inactive', 'inactive', 'active'];
    const { api, calls } = fakeApi(() => ({ status: 200, body: { state: states.shift() ?? 'active', enabled: false } }));
    const detail = await waitForSecretState(api, U(7), 'active', 5_000, 1);
    expect(detail.state).toBe('active');
    expect(calls).toEqual(Array(3).fill(`/api/v1/secrets/${U(7)}`));
});

test('waitForSecretState: failed stops at once; a secret that stays inactive times out with the detail', async () => {
    const failed = fakeApi(() => ({ status: 200, body: { state: 'failed' } }));
    await expect(waitForSecretState(failed.api, U(7), 'active', 5_000, 1)).rejects.toThrow(/is failed/);
    expect(failed.calls).toHaveLength(1);
    const stuck = fakeApi(() => ({ status: 200, body: { state: 'inactive' } }));
    await expect(waitForSecretState(stuck.api, U(7), 'active', 30, 5)).rejects.toThrow(/still inactive after 30 ms/);
});
