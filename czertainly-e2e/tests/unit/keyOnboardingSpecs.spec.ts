/**
 * keyOnboardingSpecs — static checks over tests/key-onboarding/*.spec.ts (the `@dev-tests` block).
 *
 * Checks every spec calls describeLocalOnly and every test and describe carries devTests(...); no provisioning reader runs
 * at module scope (Playwright lists tests before the setup writes the summary); no password-like literal; every recordCreated
 * uses ledgerSpec; every removal from the inventory is followed by a recordDeleted in the same test or hook (a test expecting
 * the 422 refusal is exempt), as the run-end teardown leaves behind what the ledger does not know.
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { onboardedKey } from '../../utils/keyOnboarding/provisioning';

const DIR = path.join(__dirname, '..', 'key-onboarding');
const specs = fs.readdirSync(DIR).filter((f) => f.endsWith('.spec.ts')).sort();

/** Readers of the summary (provisioning.ts): forbidden outside a test, hook or helper body. */
const READERS = ['readSummary', 'provisioningOrSkip', 'summaryFile'];

/** Index of the closer matching the opener at `open`, skipping strings, templates, comments and escapes. */
function closerOf(src: string, open: number): number {
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const stack: string[] = [pairs[src[open]]];
    let i = open + 1;
    const skipQuoted = (q: string): void => {
        i++;
        while (i < src.length && src[i] !== q) {
            if (src[i] === '\\') i++;
            else if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
                i = closerOf(src, i + 1);
            }
            i++;
        }
    };
    while (i < src.length && stack.length) {
        const c = src[i];
        if (c === '\\') i++;
        else if (c === "'" || c === '"' || c === '`') skipQuoted(c);
        else if (c === '/' && src[i + 1] === '/') i = src.indexOf('\n', i);
        else if (c === '/' && src[i + 1] === '*') i = src.indexOf('*/', i) + 1;
        else if (pairs[c]) stack.push(pairs[c]);
        else if (c === stack[stack.length - 1]) stack.pop();
        if (i < 0) throw new Error('unterminated comment');
        i++;
    }
    return i - 1;
}

interface Call { name: string; start: number; end: number; args: string }

function calls(src: string, pattern: RegExp): Call[] {
    const found: Call[] = [];
    for (const m of src.matchAll(pattern)) {
        const open = m.index! + m[0].length - 1;
        const end = closerOf(src, open);
        found.push({ name: m[1], start: m.index!, end, args: src.slice(open + 1, end) });
    }
    return found;
}

const TEST_CALLS = /(?<![.\w])(test(?:\.describe)?)\(/g;
const BODY_CALLS = /(?<![.\w])(test(?:\.(?:beforeAll|afterAll|beforeEach|afterEach))?)\(/g;
const HEADER = (call: Call): string => call.args.slice(0, call.args.indexOf('=>'));

/** Spans where a reader may run: bodies of tests / hooks and of function declarations. */
function bodySpans(src: string): Array<[number, number]> {
    const spans: Array<[number, number]> = calls(src, BODY_CALLS).map((c) => [c.start, c.end]);
    for (const m of src.matchAll(/\bfunction\s+\w+\s*\([^)]*\)[^{]*\{/g)) {
        const open = m.index! + m[0].length - 1;
        spans.push([m.index!, closerOf(src, open)]);
    }
    return spans;
}

test('the block has its four specs, in file order', () => {
    expect(specs.map((s) => s.slice(0, 2))).toEqual(['10', '20', '25', '30']);
});

/** The end of the innermost test or hook body that contains `at` (the end of the source for a module-scope call). */
function bodyEnd(src: string, at: number): number {
    const spans = calls(src, BODY_CALLS).filter((c) => at > c.start && at < c.end).sort((a, b) => b.start - a.start);
    return spans.length ? spans[0].end : src.length;
}

for (const spec of specs) {
    const src = fs.readFileSync(path.join(DIR, spec), 'utf8');

    test(`${spec}: calls describeLocalOnly(test) before any test`, () => {
        const at = src.indexOf('describeLocalOnly(test)');
        expect(at, 'describeLocalOnly(test) is called').toBeGreaterThan(-1);
        expect(at, 'before the first test or describe').toBeLessThan(src.search(/(?<![.\w])test(\.describe)?\(/));
    });

    test(`${spec}: every test and describe carries devTests(…)`, () => {
        const tests = calls(src, TEST_CALLS);
        expect(tests.length, 'the spec declares tests').toBeGreaterThan(0);
        const untagged = tests.filter((c) => !HEADER(c).includes('devTests(')).map((c) => src.slice(c.start, c.start + 80).split('\n')[0]);
        expect(untagged).toEqual([]);
    });

    test(`${spec}: no provisioning reader runs at module scope`, () => {
        const spans = bodySpans(src);
        const reader = new RegExp(`\\b(${READERS.join('|')})\\(`, 'g');
        const offenders: string[] = [];
        for (const m of src.matchAll(reader)) {
            const at = m.index!;
            // The import line and a function's own declaration are not calls.
            if (/^\s*(import|export)\b/.test(src.slice(src.lastIndexOf('\n', at) + 1, at + 1))) continue;
            if (!spans.some(([a, b]) => at > a && at < b)) offenders.push(`${m[1]} at line ${src.slice(0, at).split('\n').length}`);
        }
        expect(offenders).toEqual([]);
    });

    test(`${spec}: no password-like literal`, () => {
        const literal = /\bpass(?:word|phrase)\w*\s*[:=]\s*(['"`])(?:(?!\1).)+\1/i;
        expect(literal.test(src), 'a password is generated or read from the summary').toBe(false);
    });

    test(`${spec}: every recordCreated uses ledgerSpec`, () => {
        const offenders = calls(src, /(?<![.\w])(recordCreated)\(/g)
            .filter((c) => !/ledgerSpec\(\w+\)/.test(c.args))
            .map((c) => `line ${src.slice(0, c.start).split('\n').length}`);
        expect(offenders).toEqual([]);
    });

    test(`${spec}: every removal from the inventory is followed by a recordDeleted`, () => {
        const offenders: string[] = [];
        for (const m of src.matchAll(/\.(removeKeysFromInventory|removeKeyFromInventory)\(/g)) {
            const at = m.index!;
            const rest = src.slice(at, bodyEnd(src, at));
            const refusal = /toBe\(422\)/.test(rest);
            if (!refusal && !/recordDeleted\(/.test(rest)) offenders.push(`${m[1]} at line ${src.slice(0, at).split('\n').length}`);
        }
        expect(offenders).toEqual([]);
    });
}

test('the scanner understands the shapes the specs use', () => {
    const sample = "test(`a (${x}) 'q'`, devTests(), async ({ a }) => { f(')'); /* ) */ });\ntest.skip(true, 'r');";
    const found = calls(sample, TEST_CALLS);
    expect(found).toHaveLength(1);
    expect(found[0].args.endsWith('});')).toBe(false);
    expect(HEADER(found[0])).toContain('devTests(');
});

// The ledger name of an onboarded key is the platform's own answer; a result without it fails instead of a guessed name.
test('onboardedKey: the uuid and name of an onboarded result, or a clear failure when the answer lacks either', () => {
    const uuid = '55555555-5555-4555-8555-555555555555';
    expect(onboardedKey({ keyHandle: 'h1', onboarded: true, intoExistingKey: false, keyUuid: uuid, keyName: 'qa-reg-x-ko-rsa' })).toEqual({ uuid, name: 'qa-reg-x-ko-rsa' });
    expect(() => onboardedKey({ keyHandle: 'h2', onboarded: true, intoExistingKey: false, keyName: 'n' })).toThrow(/h2 reports onboarded without a key uuid/);
    expect(() => onboardedKey({ keyHandle: 'h3', onboarded: true, intoExistingKey: false, keyUuid: uuid })).toThrow(/h3 reports onboarded without a key name/);
});
