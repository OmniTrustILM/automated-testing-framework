/**
 * titleLint — the title and details rules over a spec source (tests/unit/specGuards.spec.ts runs them over tests/regression
 * and tests/api): a test title says the expected behaviour in words; the ledger id and the table row live in
 * `testMeta({ id, row })`, so `--grep @<id>` and the census still find the test.
 *
 * Test and describe calls are found with the TypeScript compiler API (loaded lazily), like the other spec checks.
 */
import type * as TS from 'typescript';
import { calleeKind as parsedKind, DECLARATION_FORMS, hasFunctionArg, titleOf, typescript } from './parseSpec';

/** `test` (any declaration form) or `describe` (any modifier chain) of a call expression. */
function calleeKind(ts: typeof TS, call: TS.CallExpression): 'test' | 'describe' | undefined {
    const k = parsedKind(ts, call);
    return k === undefined ? undefined : 'describe' in k ? 'describe' : 'test';
}

/** `test.fixme / skip / fail / only('<title>', details?)`: a declaration without a body (a string first argument). */
function isTitleOnlyDeclaration(ts: typeof TS, call: TS.CallExpression): boolean {
    const c = call.expression;
    return ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'test' && DECLARATION_FORMS.has(c.name.text)
        && !!call.arguments[0] && (ts.isStringLiteralLike(call.arguments[0]) || ts.isTemplateExpression(call.arguments[0]));
}

/** The longest test title (the listed title; for a template title the lint measures its literal text). */
export const TITLE_MAX = 100;
const ID_PREFIX = /^(?:REG|API)-[A-Z]+-\d{2}/;
/** A ledger id anywhere in a describe title (`REG-PROT-01 ACME issue and revoke`). */
const ID_ANYWHERE = /\b(?:REG|API)-[A-Z]+-\d{2}/;
/** A first word that may keep its capital: an acronym or code token (API, ACME, RA, ML-DSA, PKCS#7, NOT_AFTER, PUTs). */
const ACRONYM = /^[A-Z][A-Z0-9_#.-]*[A-Z0-9]s?(?![\w])/;
/** A term with an inner capital or digit (OpenAPI, IPv6, GetCACert, Base64): a name, not a sentence start. */
const INNER_CAPITAL = /^[A-Z][a-z]*[A-Z0-9][\w#.-]*(?![\w])/;
/** Proper nouns a title may start with (product and scheme names). "A" is never one: the article is lower-case. */
export const TITLE_PROPER_NOUNS = new Set(['Basic', 'Kubernetes', 'Keycloak']);

/**
 * The rules of one test title, as written or as listed (`literal` = the text a length and clause check can see; for a
 * listed title, the title itself).
 */
export function testTitleProblems(title: string, literal = title): string[] {
    const out: string[] = [];
    if (ID_PREFIX.test(title)) out.push('id prefix in the title');
    if (literal.length > TITLE_MAX) out.push(`title longer than ${TITLE_MAX} (${literal.length})`);
    if (literal.includes('; ')) out.push('two clauses joined by "; "');
    const first = title.split(/\s/)[0];
    if (/^[A-Z]/.test(title) && !ACRONYM.test(title) && !INNER_CAPITAL.test(title) && !TITLE_PROPER_NOUNS.has(first)) out.push('title starts upper-case');
    return out;
}

/** The rules of one describe title: no tag (it goes in the details) and no ledger id. */
export function describeTitleProblems(title: string): string[] {
    return [...(title.includes('@') ? ['describe title carries a tag'] : []), ...(ID_ANYWHERE.test(title) ? ['describe title carries an id'] : [])];
}

/** The static text of a title as testBlocks returns it: a template's `${…}` parts count as nothing. */
const literalText = (title: string): string => title.replace(/\$\{[^}]*\}/g, '');

/**
 * Title and details problems of one spec source: describe titles carry no `@` (the tag goes in the details) and no id, test
 * titles carry no id prefix, are at most TITLE_MAX characters, hold one clause (no "; " join) and start lower-case
 * unless the first word is an acronym or a proper noun; titles are unique inside the file; every test's details come
 * from `testMeta()` (directly, a `…Meta(…)` helper of the file that calls testMeta(), or a constant initialised by one).
 */
export function titleProblems(src: string, fileName = 'spec.ts'): string[] {
    const ts = typescript();
    const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const out: string[] = [];
    const callsMeta = (n: TS.Node): boolean => {
        let found = false;
        const v = (m: TS.Node): void => {
            if (found) return;
            if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && m.expression.text === 'testMeta') found = true;
            else ts.forEachChild(m, v);
        };
        v(n);
        return found;
    };
    // Local declarations a details argument may name: `const details = testMeta(…)`, `const rowMeta = (…) => testMeta(…)`.
    const metaNames = new Set<string>();
    const collect = (n: TS.Node): void => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && callsMeta(n.initializer)) metaNames.add(n.name.text);
        if (ts.isFunctionDeclaration(n) && n.name && n.body && callsMeta(n.body)) metaNames.add(n.name.text);
        ts.forEachChild(n, collect);
    };
    collect(sf);
    const isMetaDetails = (a: TS.Expression): boolean => {
        if (ts.isCallExpression(a) && ts.isIdentifier(a.expression)) return a.expression.text === 'testMeta' || metaNames.has(a.expression.text);
        if (ts.isIdentifier(a)) return metaNames.has(a.text);
        if (ts.isObjectLiteralExpression(a)) return a.properties.some((p) => ts.isSpreadAssignment(p) && isMetaDetails(p.expression));
        return false;
    };
    const seen = new Map<string, number>();
    const visit = (node: TS.Node): void => {
        if (ts.isCallExpression(node)) {
            const k = calleeKind(ts, node);
            const title = titleOf(ts, sf, node.arguments[0]);
            if (k && title !== undefined && (hasFunctionArg(ts, node) || (k === 'test' && isTitleOnlyDeclaration(ts, node)))) {
                const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
                const at = `line ${line}: ${title.slice(0, 80)}`;
                if (k === 'describe') {
                    for (const p of describeTitleProblems(title)) out.push(`${p} (${at})`);
                } else {
                    for (const p of testTitleProblems(title, literalText(title))) out.push(`${p} (${at})`);
                    if (seen.has(title) && !title.includes('${')) out.push(`duplicate title, first at line ${seen.get(title)} (${at})`);
                    else seen.set(title, line);
                    const details = node.arguments.slice(1).filter((a) => !ts.isArrowFunction(a) && !ts.isFunctionExpression(a));
                    if (!details.some(isMetaDetails)) out.push(`no testMeta() details (${at})`);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

/**
 * The literal `row` of the first `testMeta({ … })` in a test call's source (the `body` of a parsed test block), else
 * undefined: the row a structure check names a test by, now that the title no longer carries it.
 */
export function metaRowOf(body: string): string | undefined {
    const ts = typescript();
    const sf = ts.createSourceFile('block.ts', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let row: string | undefined;
    const visit = (n: TS.Node): void => {
        if (row !== undefined) return;
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'testMeta' && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
            for (const p of n.arguments[0].properties) {
                if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'row' && ts.isStringLiteralLike(p.initializer)) row = p.initializer.text;
            }
            return;
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return row;
}

/** `id[row]` of a parsed test block (its testMeta() id and literal row), the id alone without a row. */
export const testKey = (b: { id?: string; body: string }): string | undefined => {
    const row = metaRowOf(b.body);
    return b.id === undefined ? undefined : row === undefined ? b.id : `${b.id}[${row}]`;
};

/**
 * Seed codes and placeholders a listed title must not carry: the code stays in `testMeta({ row, rule })`, the title says it
 * in words. `<P>` / `<…>` (a prefix or value placeholder), `T(C03)` / `{C03, …}` (a seed function or set), a bare
 * one-letter row tag `[a]`, and a seed certificate code `C03`.
 */
export const SEED_CODE_PATTERNS: ReadonlyArray<{ re: RegExp; what: string }> = [
    { re: /<(?:[A-Z]{1,3}|…|\.\.\.)>/, what: 'a placeholder (<P>, <…>)' },
    { re: /T\(C\d/, what: 'a seed function code (T(C…))' },
    { re: /\{C\d/, what: 'a seed set code ({C…})' },
    { re: /\[[a-z]\](?!\w)/, what: 'a bare row tag ([a])' },
    { re: /\bC\d{2}\b/, what: 'a seed code (C01 … C24)' },
];

/** The seed-code and placeholder rules of one listed title. */
export function seedCodeProblems(title: string): string[] {
    return SEED_CODE_PATTERNS.filter((p) => p.re.test(title)).map((p) => `${p.what} in the title`);
}

/** The parts of a Playwright `--list --reporter=json` report the runtime check reads. */
export interface ListedSuite {
    title: string;
    file?: string;
    specs?: Array<{ title: string; file?: string; line?: number; column?: number }>;
    suites?: ListedSuite[];
}

/**
 * The title rules over the LISTED titles of a `--list --reporter=json` report: what the static lint cannot read
 * (template values, a title from a variable or a table, an alias of `test`). Describe titles (the suites below the
 * file level) and test titles; a test title is unique per file and carries no seed code or placeholder.
 */
export function listedTitleProblems(root: { suites: ListedSuite[] }): string[] {
    const out: string[] = [];
    const seen = new Map<string, string>();
    const walk = (s: ListedSuite, file: string, depth: number): void => {
        if (depth > 0) for (const p of describeTitleProblems(s.title)) out.push(`${file}: ${p}: ${s.title}`);
        for (const spec of s.specs ?? []) {
            const where = `${file}:${spec.line ?? '?'}`;
            for (const p of [...testTitleProblems(spec.title), ...seedCodeProblems(spec.title)]) out.push(`${where}: ${p}: ${spec.title.slice(0, 100)}`);
            const key = `${file}\u0000${spec.title}`;
            const at = `${spec.line}:${spec.column}`;
            if (seen.has(key) && seen.get(key) !== at) out.push(`${where}: duplicate title in the file: ${spec.title.slice(0, 100)}`);
            else seen.set(key, at);
        }
        for (const child of s.suites ?? []) walk(child, file, depth + 1);
    };
    for (const s of root.suites) walk(s, s.file ?? s.title, 0);
    return [...new Set(out)];
}
