/**
 * specLint/parseSpec — reads a spec's source with the TypeScript compiler API (never a hand-written bracket scanner):
 * its test blocks with titles, tags and `testMeta()` ids, the names its code uses, and the tag rules specGuards checks
 * (`@bug:` only with `test.fail()`, one suite tag per test). The compiler (the `typescript` devDependency, TypeScript 6;
 * the native TypeScript 7 has no JavaScript compiler API) is loaded lazily, so specs that import `testMeta` never load it.
 */
import type * as TS from 'typescript';
import { idTag } from '../tags';

/** The test declaration forms Playwright 1.58 knows: `test(…)`, `test.only / skip / fixme / fail(title, …, body)`. */
export type TestKind = 'test' | 'only' | 'skip' | 'fixme' | 'fail';

export interface TestBlock {
    title: string;
    /** The whole call, from `test` to the closing parenthesis. */
    body: string;
    kind: TestKind;
    /** Titles of the enclosing `test.describe` calls, outermost first. */
    describes: string[];
    /** Every tag the test carries: `@words` in its title and its describes' titles, and the `tag` details of all of them
     *  (string literals, `tags.<name>`, `tags.bug(…)`, `testMeta({ … })`). */
    tags: string[];
    /** 1-based line of the call. */
    line: number;
    /** The `id` of a literal `testMeta({ id: '…' })` in the test's details (the ledger id, independent of the title). */
    id?: string;
}

export const DECLARATION_FORMS = new Set(['only', 'skip', 'fixme', 'fail']);
const DESCRIBE_MODIFIERS = new Set(['only', 'skip', 'fixme', 'serial', 'parallel']);
const TITLE_TAG = /@[\w:#.-]+/g;

export function typescript(): typeof TS {
    return require('typescript') as typeof TS;
}

/** `test`, `test.<form>` or `test.describe[.<modifier>[.<modifier>]]` of a call expression. */
export function calleeKind(ts: typeof TS, call: TS.CallExpression): { kind: TestKind } | { describe: true } | undefined {
    const c = call.expression;
    if (ts.isIdentifier(c) && c.text === 'test') return { kind: 'test' };
    if (!ts.isPropertyAccessExpression(c)) return undefined;
    const name = c.name.text;
    const target = c.expression;
    if (ts.isIdentifier(target) && target.text === 'test') {
        if (name === 'describe') return { describe: true };
        if (DECLARATION_FORMS.has(name)) return { kind: name as TestKind };
        return undefined;
    }
    // test.describe.<modifier>[.<modifier>] (`test.describe.serial`, `test.describe.serial.only`, `test.describe.parallel.only`).
    let t: TS.Expression = c;
    while (ts.isPropertyAccessExpression(t) && DESCRIBE_MODIFIERS.has(t.name.text)) t = t.expression;
    if (t !== c && ts.isPropertyAccessExpression(t) && t.name.text === 'describe' && ts.isIdentifier(t.expression) && t.expression.text === 'test') return { describe: true };
    return undefined;
}

/** The title argument: a string or template literal (a declaration); anything else (a boolean condition) is a modifier. */
export function titleOf(ts: typeof TS, sf: TS.SourceFile, arg: TS.Expression | undefined): string | undefined {
    if (!arg) return undefined;
    if (ts.isStringLiteralLike(arg)) return arg.text;
    if (ts.isTemplateExpression(arg)) return arg.getText(sf).slice(1, -1);
    return undefined;
}

export const hasFunctionArg = (ts: typeof TS, call: TS.CallExpression): boolean => call.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));

const SIMPLE_TAGS: Record<string, string> = { regression: '@regression', api: '@api', gate: '@gate', phaseB: '@phaseB', local: '@local', slow: '@slow' };

/** Tags a details expression carries (best effort over the forms the suite uses). */
function tagsOf(ts: typeof TS, sf: TS.SourceFile, node: TS.Node | undefined): string[] {
    if (!node) return [];
    if (ts.isStringLiteralLike(node)) return node.text.startsWith('@') ? [node.text] : [];
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((e) => tagsOf(ts, sf, ts.isSpreadElement(e) ? e.expression : e));
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'tags') {
        return SIMPLE_TAGS[node.name.text] ? [SIMPLE_TAGS[node.name.text]] : [];
    }
    if (ts.isCallExpression(node)) {
        const c = node.expression;
        if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'tags') {
            const arg = node.arguments[0];
            const value = arg && ts.isStringLiteralLike(arg) ? arg.text : '?';
            return [`@${c.name.text}:${value}`];
        }
        if (ts.isIdentifier(c) && c.text === 'testMeta') return metaTags(ts, sf, node.arguments[0]);
        return [];
    }
    if (ts.isObjectLiteralExpression(node)) {
        const out: string[] = [];
        for (const p of node.properties) {
            if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'tag') out.push(...tagsOf(ts, sf, p.initializer));
            else if (ts.isSpreadAssignment(p)) out.push(...tagsOf(ts, sf, p.expression));
        }
        return out;
    }
    return [];
}

/** The `id` of `testMeta({ id: '…' })` (a literal string only), else undefined. */
function metaIdOf(ts: typeof TS, node: TS.Node): string | undefined {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'testMeta') return undefined;
    const arg = node.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
    for (const p of arg.properties) {
        if (ts.isPropertyAssignment(p) && p.name.getText(arg.getSourceFile()) === 'id' && ts.isStringLiteralLike(p.initializer)) return p.initializer.text;
    }
    return undefined;
}

/** The tags `testMeta({ … })` adds, read from its literal argument (id, prio, local, gate, phaseB, bug). */
function metaTags(ts: typeof TS, sf: TS.SourceFile, arg: TS.Expression | undefined): string[] {
    if (!arg || !ts.isObjectLiteralExpression(arg)) return [];
    const out: string[] = [];
    for (const p of arg.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = p.name.getText(sf);
        const v = p.initializer;
        const isTrue = v.kind === ts.SyntaxKind.TrueKeyword;
        if (['local', 'gate', 'phaseB', 'slow'].includes(key) && isTrue) out.push(SIMPLE_TAGS[key]);
        if (key === 'prio' && ts.isStringLiteralLike(v)) out.push(`@p${v.text.slice(1)}`);
        if (key === 'id' && ts.isStringLiteralLike(v)) out.push(idTag(v.text));
        if (key === 'bug') {
            const refs = ts.isArrayLiteralExpression(v) ? v.elements : [v];
            for (const r of refs) out.push(`@bug:${ts.isStringLiteralLike(r) ? r.text : '?'}`);
        }
    }
    return out;
}

/** Every test declaration of a spec source (describes excluded, `test.step` / modifiers ignored), with its tags. */
export function testBlocks(src: string, fileName = 'spec.ts'): TestBlock[] {
    const ts = typescript();
    const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const blocks: TestBlock[] = [];
    const visit = (node: TS.Node, describes: Array<{ title: string; tags: string[] }>): void => {
        if (ts.isCallExpression(node)) {
            const k = calleeKind(ts, node);
            const title = titleOf(ts, sf, node.arguments[0]);
            if (k && title !== undefined && hasFunctionArg(ts, node)) {
                const ownTags = [...(title.match(TITLE_TAG) ?? []), ...node.arguments.slice(1).filter((a) => !ts.isArrowFunction(a) && !ts.isFunctionExpression(a)).flatMap((a) => tagsOf(ts, sf, a))];
                if ('describe' in k) {
                    const inner = [...describes, { title, tags: ownTags }];
                    node.arguments.forEach((a) => visit(a, inner));
                    return;
                }
                const id = node.arguments.slice(1).map((a) => metaIdOf(ts, a)).find((v) => v !== undefined);
                blocks.push({
                    ...(id !== undefined ? { id } : {}),
                    title,
                    body: src.slice(node.getStart(sf), node.getEnd()),
                    kind: k.kind,
                    describes: describes.map((d) => d.title),
                    tags: [...new Set([...describes.flatMap((d) => d.tags), ...ownTags])],
                    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                });
            }
        }
        ts.forEachChild(node, (child) => visit(child, describes));
    };
    visit(sf, []);
    return blocks;
}

/** Every identifier and string literal of a source (comments excluded): a code-level marker search. */
export function codeNames(src: string, fileName = 'spec.ts'): Set<string> {
    const ts = typescript();
    const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const out = new Set<string>();
    const visit = (n: TS.Node): void => {
        if (ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isPrivateIdentifier(n)) out.add(n.text);
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

const BUG_TAG = /@bug:|\btags\.bug\(|\bbug\s*:\s*['"[]/;

/**
 * Titles of tests that carry a `@bug` tag (literal, `tags.bug(…)`, `testMeta({ bug })`, or inherited from a describe) but
 * never call `test.fail(`. `test.fixme` / `test.skip` declarations are included: a skipped test is never a bug marker.
 */
export function bugTagsWithoutFail(src: string): string[] {
    return testBlocks(src)
        .filter((b) => (BUG_TAG.test(b.body) || b.tags.some((t) => t.startsWith('@bug:'))) && b.kind !== 'fail' && !/\btest\.fail\s*\(/.test(b.body))
        .map((b) => b.title);
}

/** Tests that do not carry exactly one suite tag (`@regression` or `@api`), with what they carry. */
export function suiteTagProblems(src: string): string[] {
    return testBlocks(src)
        .map((b) => ({ b, suite: b.tags.filter((t) => t === '@regression' || t === '@api') }))
        .filter(({ suite }) => new Set(suite).size !== 1)
        .map(({ b, suite }) => `${b.title} (line ${b.line}): ${suite.length ? [...new Set(suite)].join(' + ') : 'no suite tag'}`);
}
