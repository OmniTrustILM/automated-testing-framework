/**
 * B0 fix pass 5 — the round-5 minors outside the wire: the spec lint (rev5/p8, r5/P10: `globalThis.process`, `eval`,
 * `Function`, string timers, process.env handed away, request options, `test.use`), the ledger shapes (recordCreated,
 * recordDerived, recordDeleted, parents, parseLedger) and the docker gates under REG_UNIT_NO_DOCKER (rev5/p6, r5/P8:
 * REG_DOCKER_BIN only an absolute fake inside the test output / temp directory; `requireTool('docker')` gated too).
 * No real docker runs here: a logging fake `docker` is put FIRST on PATH, and the refused cases must leave its log empty.
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { ledgerFile, ledgerUuidProblem, parentsProblem, parseLedger, readLedger, recordCreated, recordDeleted, recordDerived } from '../../utils/regression/regressionRun';
import { rawMutations } from '../../utils/regression/tags';
import { dockerContainerProof } from '../../utils/regression/tier';
import { requireTool, unitDockerBinProblem } from '../../utils/regression/tools';

const HEAD = "import { test, expect } from '../../fixtures/testFixtures';\n";
const T = (body: string) => `test('x', async ({ api }) => { ${body} });`;
const rules = (src: string) => [...new Set(rawMutations(HEAD + src, 'tests/api/probe.api.spec.ts', { spec: true }).map((h) => h.rule))].sort();
const U1 = '00000000-0000-4000-8000-0000000000e1';

test('lint (rev5/p8, r5/P10): process through globalThis / global / aliases, dynamic code, process.env handed away', () => {
    const flagged: Array<[string, string, string]> = [
        ['globalThis.process.env write', T("globalThis.process.env.TIER_KIND = 'local';"), 'env-write'],
        ['global.process element access', T("global['process'].env.TIER_KIND = 'local';"), 'env-write'],
        ['a process alias', T("const p = globalThis.process; p.env.BASE_URL = 'x';"), 'env-write'],
        ['an alias of an alias', T("const p = process; const q = p; q.env['TIER_KIND'] = 'local';"), 'env-write'],
        ['destructured env of globalThis.process', T("const { env } = globalThis.process; env.TIER_KIND = 'local';"), 'env-write'],
        ['process.env handed to a helper (rev5/p8)', "function set(e: any) { e.TIER_KIND = 'local'; }\n" + T('set(process.env);'), 'env-write'],
        ['globalThis.process.binding', T("globalThis.process.binding('fs');"), 'spec-import'],
        ['eval', T("eval(\"process.env.TIER_KIND='local'\");"), 'dynamic-code'],
        ['indirect eval', T("(0, eval)('1');"), 'dynamic-code'],
        ['globalThis.eval', T("globalThis.eval('1');"), 'dynamic-code'],
        ['new Function', T("new Function('return process')().env.TIER_KIND = 'local';"), 'dynamic-code'],
        ['Function()', T("Function('return 1')();"), 'dynamic-code'],
        ['globalThis.Function', T("const F = globalThis.Function; F('x');"), 'dynamic-code'],
        ['the constructor of a function', T("(() => 1).constructor('return process')();"), 'dynamic-code'],
        ['constructor of a constructor', T("[].constructor.constructor('return 1')();"), 'dynamic-code'],
        ['new x.constructor', T("new (async () => 1).constructor('return 1');"), 'dynamic-code'],
        ['setTimeout with a string', T("setTimeout('1', 0);"), 'dynamic-code'],
        ['setInterval with a template', T('setInterval(`x`, 10);'), 'dynamic-code'],
        ['setTimeout with a concatenation', T("const a = 'x'; setTimeout('p' + a, 0);"), 'dynamic-code'],
    ];
    for (const [name, src, rule] of flagged) expect(rules(src), name).toContain(rule);
    const clean: Array<[string, string]> = [
        ['a key read', T('const k = process.env.TIER_KIND; expect(k).toBeDefined();')],
        ['Object.keys / entries / JSON.stringify of process.env', T('Object.keys(process.env); Object.entries(process.env); JSON.stringify(process.env);')],
        ['a suite helper reading the environment', "import { isLocalTier } from '../../utils/regression/tier';\n" + T('isLocalTier(process.env);')],
        ['Function as a type', "type Cb = Function;\n" + T('const f: Cb | undefined = undefined; expect(f).toBeUndefined();')],
        ['a timer with a callback', T('setTimeout(() => undefined, 1);')],
        ['a property named eval in a literal', T('const o = { eval: 1 }; expect(o).toBeDefined();')],
    ];
    for (const [name, src] of clean) expect(rules(src), name).toEqual([]);
});

test('lint: request options the guard does not forward, and test.use overriding a context fixture', () => {
    const flagged: Array<[string, string, string]> = [
        ['url key (rev5/p8)', T("await api.post('/api/v1/roles/own/users', { data: [], url: '/api/v1/roles/foreign/users' });"), 'request-option'],
        ['request key', T("await api.post('/api/v1/roles/own/users', { request: undefined });"), 'request-option'],
        ['encodedParams', T("await api.delete('/api/v1/roles/own', { encodedParams: 'x=1' });"), 'request-option'],
        ['method on get (rev5/p8)', T("await api.get('/api/v1/roles', { method: 'DELETE' } as any);"), 'request-option'],
        ['__testHookLookup', T("await api.get('/api/v1/roles', { __testHookLookup: {} } as never);"), 'request-option'],
        ['test.use({ api }) (rev5/p8)', 'test.use({ api: undefined as any });\n' + T(''), 'fixture-extend'],
        ['test.use({ request })', 'test.use({ request: undefined as any });\n' + T(''), 'fixture-extend'],
        ['test.use(options)', 'const o = {};\ntest.use(o);\n' + T(''), 'fixture-extend'],
    ];
    for (const [name, src, rule] of flagged) expect(rules(src), name).toContain(rule);
    const clean: Array<[string, string]> = [
        ['forwarded options', T("await api.post('/api/v1/roles', { data: {}, params: { a: 1 }, headers: { accept: 'x' }, timeout: 1, failOnStatusCode: false, maxRetries: 0 });")],
        ['method on fetch', T("await api.fetch('/api/v1/roles', { method: 'GET', identityOverride: true, headers: { authorization: 'Bearer x' } });")],
        ['test.use of an option', "test.use({ locale: 'en-GB' });\n" + T('')],
    ];
    for (const [name, src] of clean) expect(rules(src), name).toEqual([]);
});

test('ledger shapes: a canonical uuid (or <namespace>/<name> for k8s) and canonical parents, or nothing is recorded / read', ({}, testInfo) => {
    const saved = process.env.REG_STATE_DIR;
    process.env.REG_STATE_DIR = testInfo.outputPath('state');
    try {
        const bad = [` ${U1}`, `${U1} `, U1.replace(/-/g, ''), 'AAAAAAAAAAAAAAAAAAAAAA', `urn:uuid:${U1}`, '0-0-4000-8000-1', `${U1}/../settings`, '', 'u-1'];
        for (const uuid of bad) {
            expect(ledgerUuidProblem('roles', uuid), JSON.stringify(uuid)).toBeDefined();
            expect(() => recordCreated('roles', { uuid, name: 'qa-reg-x' }, 'T'), JSON.stringify(uuid)).toThrow(/not a canonical uuid/);
            expect(() => recordDerived('certificates', { uuid, name: 'x' }, 'T', '2026-10-14T00:00:00.000Z'), JSON.stringify(uuid)).toThrow(/not a canonical uuid/);
            expect(() => recordDeleted('roles', { uuid, name: 'x' }, 'T'), JSON.stringify(uuid)).toThrow(/not a canonical uuid/);
        }
        expect(() => recordCreated('roles', { uuid: U1, name: 'qa-reg-x' }, 'T', undefined, { authority: '../x' })).toThrow(/parent/);
        expect(() => recordCreated('roles', { uuid: U1, name: 'qa-reg-x' }, 'T', undefined, { raProfiles: [U1, 'x'] })).toThrow(/parent/);
        expect(() => recordCreated('k8s:Issuer', { uuid: U1, name: 'qa-reg-x' }, 'T')).toThrow(/namespace/);
        expect(() => recordCreated('k8s:Issuer', { uuid: 'ns/Bad_Name', name: 'qa-reg-x' }, 'T')).toThrow(/namespace/);
        expect(fs.existsSync(ledgerFile()), 'nothing was written').toBe(false);
        // Valid shapes are written (either case of a canonical uuid; a k8s namespaced name).
        recordCreated('roles', { uuid: U1.toUpperCase(), name: 'qa-reg-x' }, 'T', undefined, { authority: U1 });
        recordCreated('k8s:Issuer', { uuid: 'ns-1/qa-reg-x-issuer', name: 'qa-reg-x-issuer' }, 'T');
        expect(readLedger().map((l) => l.uuid)).toEqual([U1.toUpperCase(), 'ns-1/qa-reg-x-issuer']);
        expect(parentsProblem({ raProfiles: [] }), 'an empty parent list').toBeDefined();
        expect(parentsProblem(['x'])).toBeDefined();
        expect(parentsProblem(undefined)).toBeUndefined();
    } finally {
        if (saved === undefined) delete process.env.REG_STATE_DIR;
        else process.env.REG_STATE_DIR = saved;
    }
    // parseLedger: a hand-edited line with a forged id or parent proves nothing.
    const line = (o: Record<string, unknown>) => JSON.stringify({ at: 'a', runId: 'r', type: 'roles', name: 'r-x', spec: 'T', event: 'created', ...o });
    const parsed = parseLedger([
        line({ uuid: U1 }), line({ uuid: ` ${U1}` }), line({ uuid: `${U1}/x` }), line({ uuid: U1, parents: { authority: 'a/../b' } }),
        line({ uuid: U1, type: 'k8s:Issuer' }), line({ uuid: 'ns/name', type: 'k8s:Issuer' }), line({ uuid: 5 }),
    ].join('\n'));
    expect(parsed.map((l) => `${l.type} ${l.uuid}`)).toEqual([`roles ${U1}`, 'k8s:Issuer ns/name']);
});

test('docker gates (rev5/p6, r5/P8): under REG_UNIT_NO_DOCKER only an absolute fake inside the test output runs; requireTool too', ({}, testInfo) => {
    expect(process.env.REG_UNIT_NO_DOCKER, 'set by playwright.unit.config.ts').toBe('1');
    // A logging fake named `docker`, FIRST on PATH: if anything ran "docker" by name, its log would say so.
    const bin = testInfo.outputPath('bin');
    fs.mkdirSync(bin, { recursive: true });
    const log = testInfo.outputPath('docker-calls.log');
    fs.writeFileSync(log, '');
    const fake = path.join(bin, 'docker');
    fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\necho 'Docker version 0.0.0-fake'\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    const savedBin = process.env.REG_DOCKER_BIN;
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    delete process.env.REG_DOCKER_BIN;
    try {
        const calls = () => fs.readFileSync(log, 'utf8').trim();
        // Refused without running anything: a bare name, a system path, a symlink that leaves the test output.
        expect(unitDockerBinProblem('docker')).toMatch(/absolute path/);
        expect(unitDockerBinProblem('/usr/local/bin/docker')).toMatch(/inside the test output/);
        const link = path.join(bin, 'docker-link');
        fs.symlinkSync('/usr/bin/true', link);
        expect(unitDockerBinProblem(link), 'a symlink is judged by its target').toMatch(/inside the test output/);
        expect(requireTool('docker'), 'requireTool with the default name').toMatch(/disabled under the unit tests/);
        expect(requireTool('docker', '/usr/local/bin/docker')).toMatch(/disabled under the unit tests/);
        expect(dockerContainerProof(8280, undefined, { REG_DOCKER_BIN: 'docker' })).toEqual({ ok: false, error: expect.stringMatching(/absolute path/) });
        expect(dockerContainerProof(8280, undefined, { REG_DOCKER_BIN: link })).toEqual({ ok: false, error: expect.stringMatching(/inside the test output/) });
        expect(dockerContainerProof(8280, undefined, {})).toEqual({ ok: false, error: expect.stringMatching(/disabled under the unit tests/) });
        expect(calls(), 'nothing named docker ran').toBe('');
        // The fake itself, named by its absolute path inside the test output, does run.
        expect(unitDockerBinProblem(fake)).toBeUndefined();
        expect(requireTool('docker', fake)).toBeUndefined();
        dockerContainerProof(8280, undefined, { REG_DOCKER_BIN: fake });
        expect(calls().split('\n')).toEqual(['--version', 'ps --format {{json .}}']);
    } finally {
        process.env.PATH = savedPath;
        if (savedBin === undefined) delete process.env.REG_DOCKER_BIN;
        else process.env.REG_DOCKER_BIN = savedBin;
    }
});

test('micro-pass: skipped ledger lines are reported in ONE warning per read — a count and the run-id prefixes, never an id', () => {
    const warnings: string[] = [];
    const saved = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
        const line = (o: Record<string, unknown>) => JSON.stringify({ at: 'a', type: 'roles', name: 'n', spec: 'T', event: 'created', ...o });
        const bad = [
            line({ runId: 'qa-man-20261009-101500-aa11', uuid: 'manual-role-7' }), line({ runId: 'qa-man-20261009-101500-aa11', uuid: 'MAN-LEAK-ID' }),
            line({ runId: 'qa-neg-20261010-090000-bb22', uuid: ' 00000000-0000-4000-8000-000000000001' }),
            line({ runId: 'qa-neg-20261010-090000-bb22', uuid: U1, parents: { authority: 'NEG-LEAK-PARENT' } }),
            line({ run: 'qa-man-legacy', uuid: 'x/../settings' }), line({ uuid: 'no-run-id-line' }),
        ];
        const good = [line({ runId: 'qa-reg-20261014-120000-cd34', uuid: U1 })];
        const parsed = parseLedger([...bad, ...good, '{broken', 'null'].join('\n'));
        expect(parsed.map((l) => l.uuid)).toEqual([U1]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('skipped 6 line(s) whose id or parents have the wrong shape (run-id prefixes: (no run id), qa-man, qa-neg) and 2 unreadable line(s) of the ledger');
        for (const leak of ['manual-role-7', 'MAN-LEAK-ID', 'NEG-LEAK-PARENT', 'settings', '20261009', 'aa11', 'no-run-id-line']) expect(warnings[0]).not.toContain(leak);
        // A uuid-shaped or free-form run id is reported as `(other)`, never in part (1.5.0 reviews: F6 Fable, F10 Sonnet).
        warnings.length = 0;
        parseLedger([
            line({ runId: '11111111-0000-4000-8000-000000000001', uuid: 'odd-1' }),
            line({ runId: 'abcdefgh-ijklmnop', uuid: 'odd-2' }),
            line({ runId: 'qa-rev3-20261013-x', uuid: 'odd-3' }),
        ].join('\n'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('(run-id prefixes: (other), qa-rev3)');
        for (const leak of ['11111111', 'abcdefgh', 'ijklmnop', 'odd-']) expect(warnings[0]).not.toContain(leak);
        // A clean ledger: no warning at all.
        warnings.length = 0;
        parseLedger(good.join('\n'));
        expect(warnings).toEqual([]);
    } finally {
        console.warn = saved;
    }
});
