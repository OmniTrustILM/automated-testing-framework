/**
 * commonNames — unit tests of the unique name suffix and of the certificate common name builders.
 *
 * Checks the suffix is short, base 36 and unique; a common name over 64 characters or with a DNS label over 63, and a DNS
 * name over 253, is refused; every name the specs and helpers build through a builder (found by scanning the sources) stays
 * inside the limits. A name the CA refuses for length would fail a live test for the wrong reason. Pure calls.
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { UNIQUE_SUFFIX_LENGTH, uniqueSuffix } from '../../utils/regression/text';
import { checkedCommonName, checkedDnsName, ownCommonName, ownName, runCommonName, runId } from '../../utils/regression/ledger/runState';
import { leafCommonName } from '../../utils/regression/discovery/tlsTarget';
import { rigCertificateSuffix } from '../../utils/regression/events/notificationDeliveryFixtures';
import { reservedWebhookUrl } from '../../utils/regression/events/notificationAttributes';

test('uniqueSuffix: at most ten characters of base 36', () => {
    expect(UNIQUE_SUFFIX_LENGTH).toBeLessThanOrEqual(10);
    for (let i = 0; i < 1000; i++) expect(uniqueSuffix()).toMatch(new RegExp(`^[a-z0-9]{${UNIQUE_SUFFIX_LENGTH}}$`));
});

test('uniqueSuffix: no repeat over ten thousand calls', () => {
    expect(new Set(Array.from({ length: 10_000 }, () => uniqueSuffix())).size).toBe(10_000);
});

test('ownCommonName: run-prefixed, ends with the domain and stays within the limits', () => {
    const name = ownCommonName('unit');
    expect(name.startsWith(`${runId()}-unit-`)).toBe(true);
    expect(name.endsWith('.example.test')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(runCommonName('unit', 'ca.test')).toBe(`${runId()}-unit.ca.test`);
});

test('checkedCommonName: 64 characters pass, 65 are refused', () => {
    expect(checkedCommonName(`${'a'.repeat(30)}.${'b'.repeat(33)}`)).toHaveLength(64);
    expect(() => checkedCommonName(`${'a'.repeat(30)}.${'b'.repeat(34)}`)).toThrow(/65 characters.*limit is 64/);
});

test('checkedCommonName: a DNS label of 64 characters is refused', () => {
    expect(() => checkedCommonName('a'.repeat(64))).toThrow(/DNS label is 64 characters/);
    expect(() => checkedCommonName(`${'a'.repeat(64)}.x`)).toThrow(/DNS label is 64 characters/);
});

test('ownCommonName: a suffix too long for the limit throws', () => {
    const room = 64 - ownName('').length - '.example.test'.length;
    expect(() => ownCommonName('x'.repeat(room + 1))).toThrow(/limit is 64/);
    expect(() => ownCommonName('x'.repeat(room))).not.toThrow();
});

/** A run id of the longest shape the runner generates: `qa-reg-<yyyymmdd>-<hhmmss>-<4 random>`. */
const LONGEST_RUN_ID = 'qa-reg-20261022-235959-zzzz';
/** How many characters below the limit a name built from run state must stay, so a longer run id or suffix still fits. */
const ROOM = 4;

/** The stems every spec passes to `startTlsTarget` today (`stem` and `leafStems`), with both discovery generations. */
const TLS_STEMS = ['scan', 'unit', 'scanv1', 'scanv2', 'stop', 'dedup', 'sch-v1', 'sch-v2', 'bat-v1', 'bat-v2', 'hit-a', 'hit-b', 'hit-c', 'miss'];

test('the run id used for the length checks has the longest shape and 27 characters', () => {
    expect(LONGEST_RUN_ID).toHaveLength(27);
});

test('leafCommonName: every stem the specs pass builds a legal leaf name with room to spare', () => {
    const unique = 'a'.repeat(UNIQUE_SUFFIX_LENGTH);
    for (const stem of TLS_STEMS) {
        for (const index of [1, 7, 8]) {
            const name = leafCommonName(stem, unique, index, LONGEST_RUN_ID);
            expect(name.length, `${stem} #${index}: ${name}`).toBeLessThanOrEqual(64 - ROOM);
        }
    }
});

test('every stem a spec passes to startTlsTarget is in the literal list above', () => {
    const dir = path.join(__dirname, '..', 'regression');
    const found = new Set<string>();
    for (const area of fs.readdirSync(dir)) {
        const areaDir = path.join(dir, area);
        if (!fs.statSync(areaDir).isDirectory()) continue;
        for (const file of fs.readdirSync(areaDir).filter((f) => f.endsWith('.spec.ts'))) {
            const text = fs.readFileSync(path.join(areaDir, file), 'utf8');
            for (const m of text.matchAll(/\bstem: ['`]([^'`]+)['`]/g)) found.add(m[1].replace('${generation}', 'v1'));
            for (const m of text.matchAll(/leafStems: \[([^\]]*)\]/g)) for (const s of m[1].matchAll(/'([^']+)'/g)) found.add(s[1]);
        }
    }
    // The main-flow branch holds no discovery spec: then there is nothing to scan; the secondary tree holds them all.
    const discovery = fs.existsSync(path.join(dir, '08-discovery'));
    expect(found.size, 'the discovery specs pass their stems').toBeGreaterThan(discovery ? 5 : -1);
    for (const stem of found) expect(TLS_STEMS.includes(stem) || TLS_STEMS.includes(stem.replace('v1', 'v2')), `stem ${stem} is not in the list`).toBe(true);
});

test('leafCommonName: a stem too long for the run id is refused with the limit named', () => {
    const unique = 'a'.repeat(UNIQUE_SUFFIX_LENGTH);
    expect(() => leafCommonName('scan-batch-v1', unique, 1, LONGEST_RUN_ID)).toThrow(/66 characters.*limit is 64/);
    expect(() => leafCommonName('scan-sched-v2', unique, 1, LONGEST_RUN_ID)).toThrow(/limit is 64/);
});

/** The longest unique part `ownName` adds (`-` and the suffix). */
const UNIQUE_PART = 'a'.repeat(UNIQUE_SUFFIX_LENGTH);

/** Every `.ts` file of the specs and helpers that can build a common name. */
function sourceFiles(): string[] {
    const root = path.join(__dirname, '..', '..');
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.ts')) out.push(full);
        }
    };
    for (const dir of [['tests', 'regression'], ['tests', 'api'], ['utils', 'regression']]) walk(path.join(root, ...dir));
    return out;
}

/** The rows (`key: '…'` or `row: '…'`) of the table a `for (const <loop> of TABLE)` loop walks, found before `at` in the text. */
function tableValues(text: string, at: number, loop: string, field: 'key' | 'row'): string[] {
    const loops = [...text.slice(0, at).matchAll(new RegExp(`for \\(const ${loop} of (\\w+)\\)`, 'g'))];
    if (loops.length === 0) return [];
    const table = loops[loops.length - 1][1];
    const start = text.search(new RegExp(`const ${table}\\b[^=\\n]*=\\s*\\[`));
    if (start < 0) return [];
    const end = text.slice(start).search(/\n\s*\];/);
    return [...text.slice(start, end < 0 ? undefined : start + end).matchAll(new RegExp(`\\b${field}: '([^']+)'`, 'g'))].map((m) => m[1]);
}

/** The values a `${...}` placeholder of a suffix can take at this place of the file; a placeholder nobody can resolve is an error. */
function placeholderValues(expression: string, text: string, at: number): string[] {
    if (expression === 'row.key') return tableValues(text, at, 'row', 'key');
    if (expression === 'r.row') return tableValues(text, at, 'r', 'row');
    if (expression === 'generation') return ['v1', 'v2'];
    if (expression === 'n') return [...text.matchAll(/for \(const n of \[([^\]]*)\]/g)].flatMap((m) => m[1].split(',').map((x) => x.trim()));
    throw new Error(`cannot resolve the placeholder \${${expression}}: use a literal suffix or teach this test the placeholder`);
}

/** The suffix literal, with each placeholder replaced by every value it can take. */
function expandSuffix(literal: string, text: string, at: number): string[] {
    let variants = [literal];
    for (const m of literal.matchAll(/\$\{([^}]+)\}/g)) {
        const values = placeholderValues(m[1], text, at);
        expect(values.length, `no value for \${${m[1]}}`).toBeGreaterThan(0);
        variants = variants.flatMap((v) => values.map((value) => v.replace(m[0], value)));
    }
    return variants;
}

/** A call that ends in `checkedCommonName`, how to find its suffix literal, and the name it builds from a suffix. */
interface Builder {
    label: string;
    find: RegExp;
    build: (suffix: string) => string;
}

const BUILDERS: Builder[] = [
    { label: 'ownCommonName', find: /\bownCommonName\([^\n]*?(['"`])(.*?)\1/g, build: (s) => `${LONGEST_RUN_ID}-${s}-${UNIQUE_PART}.example.test` },
    { label: 'certificateName', find: /\bcertificateName\([^\n]*?(['"`])(.*?)\1/g, build: (s) => `${LONGEST_RUN_ID}-${s}-${UNIQUE_PART}.example.test` },
    { label: 'eventCertificate', find: /\beventCertificate\(\s*(['"`])(.*?)\1/g, build: (s) => `${LONGEST_RUN_ID}-${s}-${UNIQUE_PART}.example.test` },
    { label: 'buildRig', find: /\bbuildRig\(\s*[^,]+,\s*[^,]+,\s*(['"`])(.*?)\1/g, build: (s) => `${LONGEST_RUN_ID}-${rigCertificateSuffix(s)}-${UNIQUE_PART}.example.test` },
    { label: 'certificate options', find: /\b(?:issue|submit|register)OwnCertificate\([^\n;]*?\bsuffix: (['"`])(.*?)\1/g, build: (s) => `${LONGEST_RUN_ID}-${s}-${UNIQUE_PART}.example.test` },
    { label: 'runCommonName', find: /\brunCommonName\(\s*(['"`])(.*?)\1/g, build: (s) => `${LONGEST_RUN_ID}-${s}.example.test` },
    { label: 'importCn', find: /\bimportCn\(\s*(['"`])(.*?)\1/g, build: (s) => `${LONGEST_RUN_ID}-imp-${s}-${UNIQUE_PART}` },
];

test('every suffix a spec or helper passes to a common name builder stays inside the limit with room to spare', () => {
    const counts = new Map<string, number>();
    const tooLong: string[] = [];
    for (const file of sourceFiles()) {
        const text = fs.readFileSync(file, 'utf8');
        for (const builder of BUILDERS) {
            for (const m of text.matchAll(builder.find)) {
                for (const suffix of expandSuffix(m[2], text, m.index ?? 0)) {
                    counts.set(builder.label, (counts.get(builder.label) ?? 0) + 1);
                    const name = builder.build(suffix);
                    try {
                        checkedCommonName(name);
                    } catch (error) {
                        tooLong.push(`${path.relative(path.join(__dirname, '..', '..'), file)}: ${builder.label}('${suffix}') -> ${(error as Error).message}`);
                        continue;
                    }
                    if (name.length > 64 - ROOM) tooLong.push(`${path.relative(path.join(__dirname, '..', '..'), file)}: ${builder.label}('${suffix}') is ${name.length} characters, the margin allows ${64 - ROOM}`);
                }
            }
        }
    }
    // A builder the tree calls by name must be seen by its pattern (else the pattern is stale); a builder the tree does not
    // call at all (the main-flow branch has no workflow spec) has nothing to scan.
    const isSpec = (f: string): boolean => /[\\/]tests[\\/](regression|api)[\\/]/.test(f);
    const called = (label: string): boolean => sourceFiles().filter(isSpec).some((f) => fs.readFileSync(f, 'utf8').includes(`${label}(`));
    for (const builder of BUILDERS) if (called(builder.label)) expect(counts.get(builder.label) ?? 0, `the scan found no ${builder.label} call: its pattern is stale`).toBeGreaterThan(0);
    expect(tooLong).toEqual([]);
});

test('the scan sees an over-long suffix: it fails with the file and the call named', () => {
    const name = BUILDERS[0].build('x'.repeat(20));
    expect(() => checkedCommonName(name)).toThrow(/limit is 64/);
    const text = "const ROWS = [\n    { key: 'group' },\n    { key: 'ra' },\n];\nconst other = [\n    { key: 'unrelated' },\n];\nfor (const row of ROWS) {\n    eventCertificate(`wf09-cert-${row.key}`);\n}";
    const found = [...text.matchAll(BUILDERS[2].find)].flatMap((m) => expandSuffix(m[2], text, m.index ?? 0));
    expect(found).toEqual(['wf09-cert-group', 'wf09-cert-ra']);
    expect(found.map((s) => BUILDERS[2].build(s).length)).toEqual([66, 63]);
});

test('the certificate of a notification rig keeps a short suffix', () => {
    expect(BUILDERS[3].build('wf27-1').length).toBeLessThanOrEqual(64 - ROOM);
});

test('checkedDnsName: 253 characters pass, 254 are refused', () => {
    const label = 'a'.repeat(63);
    const longest = `${label}.${label}.${label}.${'b'.repeat(61)}`;
    expect(longest).toHaveLength(253);
    expect(checkedDnsName(longest)).toBe(longest);
    expect(() => checkedDnsName(`${longest}b`)).toThrow(/DNS name is 254 characters, the limit is 253/);
});

test('checkedDnsName: a label of 64 characters is refused, 63 pass, and 64 characters in total are not a limit', () => {
    expect(() => checkedDnsName(`${'a'.repeat(64)}.example.test`)).toThrow(/DNS label is 64 characters/);
    expect(checkedDnsName(`${'a'.repeat(63)}.example.test`)).toHaveLength(76);
});

test('the names built for DNS use stay legal: ACME identifier, certificate common name and DNS name, webhook host', () => {
    const acme = `${ownName('acme')}.example.test`;
    expect(checkedDnsName(acme)).toBe(acme);
    const host = new URL(reservedWebhookUrl()).hostname;
    expect(checkedDnsName(host)).toBe(host);
    expect(() => reservedWebhookUrl('x'.repeat(70))).toThrow(/DNS label is/);
    expect(() => checkedCommonName(`${LONGEST_RUN_ID}-cm-${uniqueSuffix()}.example.test`)).not.toThrow();
});
