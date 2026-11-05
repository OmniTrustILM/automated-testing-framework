/**
 * titleLint — the title and details rules over a spec source: a test title says the expected behaviour in words; the ledger id
 * and the table row live in `testMeta({ id, row })`.
 */
import type * as TS from 'typescript';
import { calleeKind as parsedKind, DECLARATION_FORMS, hasFunctionArg, titleOf, typescript } from './parseSpec';

function calleeKind(ts: typeof TS, call: TS.CallExpression): 'test' | 'describe' | undefined {
    const k = parsedKind(ts, call);
    return k === undefined ? undefined : 'describe' in k ? 'describe' : 'test';
}

function isTitleOnlyDeclaration(ts: typeof TS, call: TS.CallExpression): boolean {
    const c = call.expression;
    return ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'test' && DECLARATION_FORMS.has(c.name.text)
        && !!call.arguments[0] && (ts.isStringLiteralLike(call.arguments[0]) || ts.isTemplateExpression(call.arguments[0]));
}

export const TITLE_MAX = 100;
const ID_PREFIX = /^(?:REG|API)-[A-Z]+-\d{2}/;
const ID_ANYWHERE = /\b(?:REG|API)-[A-Z]+-\d{2}/;
const ACRONYM = /^[A-Z][A-Z0-9_#.-]*[A-Z0-9]s?(?![\w])/;
const INNER_CAPITAL = /^[A-Z][a-z]*[A-Z0-9][\w#.-]*(?![\w])/;
export const TITLE_PROPER_NOUNS = new Set(['Basic', 'Kubernetes', 'Keycloak']);

/** The rules of one test title, as written or as listed (`literal` = the text a length and clause check can see). */
export function testTitleProblems(title: string, literal = title): string[] {
    const out: string[] = [];
    if (ID_PREFIX.test(title)) out.push('id prefix in the title');
    if (literal.length > TITLE_MAX) out.push(`title longer than ${TITLE_MAX} (${literal.length})`);
    if (literal.includes('; ')) out.push('two clauses joined by "; "');
    const first = title.split(/\s/)[0];
    if (/^[A-Z]/.test(title) && !ACRONYM.test(title) && !INNER_CAPITAL.test(title) && !TITLE_PROPER_NOUNS.has(first)) out.push('title starts upper-case');
    return out;
}

export function describeTitleProblems(title: string): string[] {
    return [...(title.includes('@') ? ['describe title carries a tag'] : []), ...(ID_ANYWHERE.test(title) ? ['describe title carries an id'] : [])];
}

const literalText = (title: string): string => title.replace(/\$\{[^}]*\}/g, '');

/**
 * Title and details problems of one spec source: no `@` or id in describe titles, test titles one lower-case clause of at most TITLE_MAX
 * characters, unique per file, details from `testMeta()`.
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

/** The literal `row` of the first `testMeta({ … })` in a test call's source, else undefined. */
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

export const testKey = (b: { id?: string; body: string }): string | undefined => {
    const row = metaRowOf(b.body);
    return b.id === undefined ? undefined : row === undefined ? b.id : `${b.id}[${row}]`;
};

/** Seed codes and placeholders a listed title must not carry (`<P>`, `T(C03)`, `[a]`, `C03`): the code stays in `testMeta`. */
export const SEED_CODE_PATTERNS: ReadonlyArray<{ re: RegExp; what: string }> = [
    { re: /<(?:[A-Z]{1,3}|…|\.\.\.)>/, what: 'a placeholder (<P>, <…>)' },
    { re: /T\(C\d/, what: 'a seed function code (T(C…))' },
    { re: /\{C\d/, what: 'a seed set code ({C…})' },
    { re: /\[[a-z]\](?!\w)/, what: 'a bare row tag ([a])' },
    { re: /\bC\d{2}\b/, what: 'a seed code (C01 … C24)' },
];

export function seedCodeProblems(title: string): string[] {
    return SEED_CODE_PATTERNS.filter((p) => p.re.test(title)).map((p) => `${p.what} in the title`);
}

export interface ListedSuite {
    title: string;
    file?: string;
    specs?: Array<{ title: string; file?: string; line?: number; column?: number }>;
    suites?: ListedSuite[];
}

/**
 * The title rules over the LISTED titles of a `--list --reporter=json`
 * report: what the static lint cannot read (template values, variables).
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
