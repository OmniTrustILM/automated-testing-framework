/**
 * B0 fix pass 4 — the spec rules of the deny-by-default lint (utils/regression/tags.ts `rawMutations`), round-4
 * minors: imports by ALLOW-LIST (relative imports inside the suite, `@playwright/test` for types only, the node
 * built-ins SPEC_BUILTINS), `process.env` writes, fs writes / removals and `createRequire` in tests/**. Every probe of
 * rev4/lint.spec.ts is a row here, plus the URL check of a literal raw POST (N2: judged like `allowListedPost`).
 */
import { expect, test } from '@playwright/test';
import { rawMutations } from '../../utils/regression/tags';

const HEAD = "import { test, expect } from '../../fixtures/testFixtures';\n";
const rules = (src: string, file = 'tests/api/probe.api.spec.ts') => [...new Set(rawMutations(src, file, { spec: true }).map((h) => h.rule))].sort();

test('rev4/lint: every probe is flagged with the rule that covers it; the controls stay clean', () => {
    const probes: Array<[string, string, string[]]> = [
        ['control: raw delete via the request fixture', "test('x', async ({ request }) => { await request.delete('/api/v1/roles/1'); });", ['raw-request-use']],
        ['node-fetch DELETE', "import nodeFetch from 'node-fetch';\ntest('x', async ({ api }) => { await nodeFetch('https://t/api/v1/roles/1', { method: 'DELETE' }); });", ['spec-import']],
        ['node-fetch default named fetch', "import fetch from 'node-fetch';\ntest('x', async ({ api }) => { await fetch('https://t/api/v1/roles/1', { method: 'DELETE' }); });", ['spec-import']],
        ['openid-client / isomorphic-ws imports', "import * as oc from 'openid-client';\nimport WebSocket from 'isomorphic-ws';\ntest('x', async ({ api }) => { });", ['spec-import']],
        ['global fetch DELETE', "test('x', async ({ api }) => { await fetch('https://t/api/v1/roles/1', { method: 'DELETE' }); });", ['fetch-method']],
        ['globalThis.fetch DELETE', "test('x', async ({ api }) => { await globalThis.fetch('https://t/api/v1/roles/1', { method: 'DELETE' }); });", ['fetch-method']],
        ['page.evaluate fetch', "test('x', async ({ page }) => { await page.evaluate(() => fetch('/api/v1/roles/1', { method: 'DELETE' })); });", ['fetch-method']],
        ['page.evaluate XHR', "test('x', async ({ page }) => { await page.evaluate(() => { const x = new XMLHttpRequest(); }); });", ['raw-xhr']],
        ['context.request.delete', "test('x', async ({ context }) => { await context.request.delete('/api/v1/roles/1'); });", ['context-method']],
        ['playwright.request.newContext', "test('x', async ({ playwright }) => { const c = await playwright.request.newContext(); await c.delete('/api/v1/roles/1'); });", ['context-method']],
        ['browser.newContext().request', "test('x', async ({ browser }) => { const c = await browser.newContext(); await c.request.delete('/api/v1/roles/1'); });", ['context-method']],
        ['process.env.TIER_KIND assignment', "test('x', async ({ api }) => { process.env.TIER_KIND = 'local'; });", ['env-write']],
        ['fs write of the proof / ledger', "import * as fs from 'fs';\ntest('x', async ({ api }) => { fs.writeFileSync('/tmp/x', '1'); fs.appendFileSync('/tmp/y', '1'); });", ['fs-write']],
        ['dynamic import of node:http', "test('x', async ({ api }) => { const h = await import('node:http'); });", ['raw-network']],
        ['worker_threads / vm / dgram imports', "import * as vm from 'vm';\nimport * as dgram from 'dgram';\nimport { Worker } from 'worker_threads';\ntest('x', async ({ api }) => { });", ['spec-import']],
        ['node:child_process via require', "const cp = require('node:child_process');\ntest('x', async ({ api }) => { });", ['raw-process']],
        ['http via createRequire', "import { createRequire } from 'module';\nconst r = createRequire(__filename);\nconst h = r('http');\ntest('x', async ({ api }) => { });", ['spec-import']],
        ['@kubernetes/client-node import', "import * as k8s from '@kubernetes/client-node';\ntest('x', async ({ api }) => { });", ['raw-network']],
        // Controls (not flagged by these rules; the runtime guard or describeLocal cover them).
        ['control: api.fetch with a Request object (runtime guard)', "test('x', async ({ api }) => { await api.fetch('/api/v1/roles/1', { method: 'DELETE' }); });", []],
        ['control: apiGuardOptions only in a comment', "// apiGuardOptions\ntest('x', async ({ api }) => { });", []],
        ['control: recordCreated / runTeardown / tier imports (relative, inside the suite)', "import { recordCreated } from '../../utils/regression/regressionRun';\nimport { removeOwnObject } from '../../utils/regression/runTeardown';\nimport { isLocalTier } from '../../utils/regression/tier';\ntest('x', async ({ api }) => { });", []],
        ['control: crypto / path / fs reads / type imports', "import { randomUUID } from 'crypto';\nimport * as path from 'path';\nimport * as fs from 'fs';\nimport type { APIResponse } from '@playwright/test';\nimport { Page } from '@playwright/test';\ntest('x', async ({ api }) => { fs.readFileSync(path.join('a', randomUUID())); });", []],
    ];
    const wrong: string[] = [];
    for (const [name, body, expected] of probes) {
        const got = rules(HEAD + body);
        if (JSON.stringify(got) !== JSON.stringify([...expected].sort())) wrong.push(`${name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }
    expect(wrong).toEqual([]);
});

test('spec-import: relative imports stay inside the suite; @playwright/test for types only; built-ins by allow-list; dynamic module names refused', () => {
    const flagged = (src: string) => rawMutations(HEAD + src, 'tests/api/probe.api.spec.ts').filter((h) => h.rule === 'spec-import').length;
    expect(flagged("import { x } from '../../node_modules/undici/index';")).toBe(1);
    expect(flagged("import { x } from '../../../outside/thing';")).toBe(1);
    expect(flagged("import { x } from '../../utils/regression/pki';")).toBe(0);
    expect(flagged("import { expect as e } from '@playwright/test';")).toBe(1);
    expect(flagged("import { chromium, devices } from '@playwright/test';")).toBe(2);
    expect(flagged("import { type Page, APIResponse } from '@playwright/test';")).toBe(0);
    expect(flagged("export { test } from '@playwright/test';")).toBe(1);
    expect(flagged("import ws = require('ws');")).toBe(1);
    expect(flagged("const m = require(name);")).toBe(1);
    expect(flagged("const m = await import(name);")).toBe(1);
    expect(flagged("import * as inspector from 'node:inspector';")).toBe(1);
    expect(flagged("const b = process.binding('fs');")).toBe(1);
    expect(flagged("const r = process.mainModule.require;")).toBe(1);
    for (const ok of ['assert', 'node:buffer', 'crypto', 'fs', 'fs/promises', 'os', 'path', 'string_decoder', 'timers', 'timers/promises', 'url', 'util', 'zlib']) {
        expect(flagged(`import * as m from '${ok}';`), ok).toBe(0);
    }
    // Helpers (spec: false) are not bound by the spec allow-list.
    expect(rawMutations("import WebSocket from 'ws';", 'utils/regression/x.ts', { spec: false }).filter((h) => h.rule === 'spec-import')).toEqual([]);
});

test('env-write: every way to change process.env from a spec is flagged; reads are fine', () => {
    const flagged = (src: string) => rawMutations(HEAD + src, 'tests/regression/X.spec.ts').filter((h) => h.rule === 'env-write').length;
    expect(flagged("process.env.TIER_KIND = 'local';")).toBe(1);
    expect(flagged("process.env['BASE_URL'] = 'x';")).toBe(1);
    expect(flagged("process.env.REG_RUN_ID ??= 'x';")).toBe(1);
    expect(flagged("process.env.X += 'y';")).toBe(1);
    expect(flagged("delete process.env.API_TEARDOWN_DRY_RUN;")).toBe(1);
    expect(flagged("Object.assign(process.env, { TIER_KIND: 'local' });")).toBe(1);
    expect(flagged("Object.defineProperty(process.env, 'TIER_KIND', { value: 'local' });")).toBe(1);
    expect(flagged("Reflect.set(process.env, 'TIER_KIND', 'local');")).toBe(1);
    expect(flagged("process.env = { TIER_KIND: 'local' };")).toBe(1);
    expect(flagged("const e = process.env;\ne.TIER_KIND = 'local';")).toBe(1);
    expect(flagged("const { env } = process;\nenv['TIER_KIND'] = 'local';")).toBe(1);
    expect(flagged("const kind = process.env.TIER_KIND ?? 'shared';\nconst copy = { ...process.env };\ncopy.TIER_KIND = 'x';")).toBe(0);
});

test('fs-write: write / append / rm / unlink / rename / copy / mkdir / open on any fs binding; reads are fine', () => {
    const flagged = (src: string) => rawMutations(HEAD + src, 'tests/api/X.api.spec.ts').filter((h) => h.rule === 'fs-write').length;
    expect(flagged("import * as fs from 'fs';\nfs.writeFileSync('a', 'b');")).toBe(1);
    expect(flagged("import fs from 'node:fs';\nfs.rmSync('a', { force: true });")).toBe(1);
    expect(flagged("import { writeFileSync, rmSync, readFileSync } from 'fs';")).toBe(2);
    expect(flagged("import { promises } from 'fs';\nawait promises.writeFile('a', 'b');")).toBe(1);
    expect(flagged("import * as fs from 'fs';\nawait fs.promises.unlink('a');")).toBe(1);
    expect(flagged("import * as fsp from 'fs/promises';\nawait fsp.rename('a', 'b');")).toBe(1);
    expect(flagged("const fs = require('fs');\nfs.appendFileSync('a', 'b');")).toBe(1);
    expect(flagged("import * as fs from 'fs';\nconst f = fs;\nf.copyFileSync('a', 'b');")).toBe(1);
    expect(flagged("import * as fs from 'fs';\nconst { mkdirSync, existsSync } = fs;")).toBe(1);
    expect(flagged("import * as fs from 'fs';\nfs['unlinkSync']('a');")).toBe(1);
    expect(flagged("import * as fs from 'fs';\nfs[name]('a');")).toBe(1);
    expect(flagged("import * as fs from 'fs';\nconst s = fs.createWriteStream('a');")).toBe(1);
    expect(flagged("import * as fs from 'fs';\nconst t = fs.readFileSync('a', 'utf8');\nfs.existsSync('b');\nfs.statSync('c');")).toBe(0);
    // Helpers write the ledger, run state and proofs by design: the rule is spec-only.
    expect(rawMutations("import * as fs from 'fs';\nfs.writeFileSync('a', 'b');", 'utils/regression/x.ts', { spec: false }).filter((h) => h.rule === 'fs-write')).toEqual([]);
});

test('N2 in the lint: a literal raw POST is judged like allowListedPost (tab-split, dotted, encoded paths are not read-only POSTs)', () => {
    const flagged = (url: string) => rawMutations(`${HEAD}test('x', async ({ request }) => {}); const raw = ctx(); await raw.post(${url});`, 'tests/api/X.api.spec.ts')
        .filter((h) => h.rule === 'context-method').length;
    expect(flagged("'/api/v1/certificates'")).toBe(0);
    expect(flagged("'/api/v1/protocols/acme/raProfile/x/new-order'")).toBe(0);
    expect(flagged('`/api/v1/protocols/acme/${name}/new-order`')).toBe(0);
    expect(flagged("'/api/v1/protocols/acme/x/.\\t./.\\t./auditLogs/purge'")).toBe(1);
    expect(flagged("'/api/v1/protocols/acme/x/../../auditLogs/purge'")).toBe(1);
    expect(flagged("'/api/v1/protocols/acme/x/%2e%2e/auditLogs/purge'")).toBe(1);
    expect(flagged("'/api/v1/workflows/events/x/../../../cboms/sync'")).toBe(1);
    expect(flagged("'https://elsewhere.example.test/api/v1/certificates'")).toBe(1);
    expect(flagged("'/api/v1/certificates/'")).toBe(1);
});
