/**
 * publicText — keeps the text a reader of this public repository sees free of private working notes.
 *
 * Comments, test titles, error messages and the README must explain the suite in plain words. Short ids that only make sense
 * next to private notes, names of the tools or people that wrote a change, and local file-system paths do not belong there.
 * `publicTextHits()` scans comments and string literals of every TypeScript file and the Markdown, JSON and ignore files.
 */
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import * as ts from 'typescript';

export interface PublicTextHit {
    file: string;
    line: number;
    /** Where the match sits: a TypeScript comment, a string, a `rule:` value, or plain text of a non-TypeScript file. */
    kind: 'comment' | 'string' | 'rule' | 'text';
    cls: string;
    match: string;
    text: string;
}

/** Pattern classes. Each regex is global; a match is reported unless the allow-lists below accept it. */
export const PUBLIC_TEXT_PATTERNS: { cls: string; re: RegExp }[] = [
    { cls: 'round-id', re: /\bfix[- ]pass(?:es)?\b|\bmicro-pass\b|\brev\d+\b|\bround[- ]?\d+\b|\bpass \d{1,2}\b|\bintegration pass\b|\blive run \d+\b|\bauthor decisions?\b/gi },
    // Finding numbers: R with two or more digits, F + digit, lower-case m / n + digit, G-n / GD-n / GH-n, any of them with a
    // `-n` suffix, in parentheses, or after the words finding, item or point. A single R, G, S or M + digit alone ("R5",
    // "G1 group", "S3 bucket") is ordinary text.
    {
        cls: 'finding-id',
        re: /\bR\d{2,}[a-z]?(?:-\d+)?\b|\b[RGSM]\d[a-z]?-\d+\b|\bF\d+[a-z]?(?:-\d+)?\b|\b[mn]\d+[a-z]?\b|\bG[DH]?-\d+\b|\((?:[RFGSMmn]\d+[a-z]?)(?:\s*[,\/;]\s*[RFGSMmn]?\d+[a-z]?)*\)|\b(?:[Rr]eview|[Ff]inding|[Ii]tem|[Pp]oint)\s+[RFGSMmn]\d+[a-z]?\b/g,
    },
    { cls: 'candidate-id', re: /\bC\d+[a-z]?\b/g },
    { cls: 'decision-id', re: /\b[QDO]\d+[a-z]?\b/g },
    { cls: 'plan-id', re: /§|\br\d+\b|\bB\d+(?:\.\d+)?[a-z]?\b|\b[TIE]\d+\b|\bTW\d+\b|\bW\d{1,2}\b|\bP-[A-Z]+\d+[a-z]?\b|(?<![\w-])[A-Z]-\d{2}\b(?![-\d])|\bSCP#\d+/g },
    { cls: 'plan-id', re: /\bphase[- ]?\d+[a-z]?\b/gi },
    // A reference into a private planning document (a possessive, or the word next to a row, a table or a section sign).
    { cls: 'plan-id', re: /\bthe plan's\b|\bplan\b(?=[^\n]{0,30}(?:\brows?\b|\btables?\b|§))|\b(?:rows?|tables?)\b(?=[^\n]{0,30}\bplan\b)/gi },
    { cls: 'model-name', re: /\b(?:Fable|Sonnet|Haiku|Opus|Claude|Copilot|GPT)\b/gi },
    { cls: 'local-path', re: /\/Users\/|\/private\/tmp\b|\bqa\/(?:workflow|knowledgebase|skills|gh)\b|~\/\.claude\b/g },
    { cls: 'local-path', re: /\bscratchpad\b/gi },
    // Open-question numbers of a private planning document, and a dated merge of private working branches.
    { cls: 'plan-id', re: /\bOQ-\d+\b/g },
    { cls: 'round-id', re: /\bmerge \d{4}-\d{2}-\d{2}\b/gi },
    // The names of the steps and packages of the suite's own restructure, and the note a temporary re-export carried.
    { cls: 'restructure-word', re: /\bP2Z\b|\bP2\.0\b|\bWP[1-5]\b|\bbarrel kept\b/g },
    // Words of the working process; "a code review of the PR" and "a PR review" are ordinary text.
    {
        cls: 'process-wording',
        re: /(?<!\b(?:code|PR|pull request) )\breview(?:s|ed|er|ers|ing)?\b(?! of (?:the|a|this) (?:PR|pull request)\b)|\bthe author decided\b|\bmerge (?:pass|rehearsal|step)\b|\barea sandbox\b/gi,
    },
];

/** An exact file list (posix paths from the tree root) for the `files` of an allow-list entry. */
const exactFiles = (...files: string[]): RegExp => new RegExp(`^(?:${files.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

/**
 * Public ids that look like the patterns above. Keep this list tiny; real issue refs (`core#2511`), RFC numbers and
 * the REG- / API- test ids never match the patterns in the first place. `files` limits an entry to the files that
 * define the ids in code; `near` requires the text around the match to contain it.
 */
export const PUBLIC_TEXT_ALLOWED: { re: RegExp; why: string; files?: RegExp; near?: RegExp }[] = [
    { re: /^S256$/, why: 'the PKCE code challenge method name' },
    { re: /^§$/, near: /\bRFC ?\d{3,5}\b/, why: 'a section of an RFC cited on the same line' },
    {
        re: /^C\d{2}$/,
        files: exactFiles(
            'utils/regression/inventory/seedFull.ts', 'utils/regression/inventory/searchTables.ts', 'utils/regression/inventory/seedRows.ts',
            'tests/api/02-certificates/search-filters.api.spec.ts', 'tests/api/02-certificates/search-sort-paging.api.spec.ts',
            'tests/regression/02-certificates/40-filter-condition-catalogue.spec.ts', 'tests/regression/02-certificates/41-text-filters.spec.ts',
            'tests/regression/02-certificates/42-date-and-duration-filters.spec.ts', 'tests/regression/02-certificates/43-list-and-enum-filters.spec.ts',
            'tests/regression/02-certificates/49-list-sorting.spec.ts', 'tests/regression/02-certificates/50-list-paging.spec.ts',
            'tests/regression/02-certificates/51-list-standard-columns.spec.ts',
            'tests/unit/searchApi.spec.ts', 'tests/unit/seedCertificates.spec.ts', 'tests/unit/seedFull.spec.ts', 'tests/unit/seedFullWire.spec.ts', 'tests/unit/searchTables.spec.ts',
            'tests/unit/helpers/fakeCertificateListApp.ts', 'tests/unit/certificateListPageStandIn.spec.ts', 'tests/unit/fieldLabels.spec.ts',
            'tests/unit/certificateListOracle.spec.ts', 'tests/unit/guardedApiSearchRequests.spec.ts',
            'utils/regression/specLint/titleLint.ts', 'tests/unit/titleLint.spec.ts',
        ),
        why: 'the seed certificate ids (C and two digits) of utils/regression/inventory/seedFull.ts, in the files that define and use the seed',
    },
    {
        re: /^(?:[MG]\d+|C1)$/,
        files: exactFiles(
            'tests/unit/errorCases.spec.ts',
            ...['cases', 'checks', 'requests', 'uploads', 'parsing', 'securityChain'].map((m) => `utils/regression/inventory/errorCases/${m}.ts`),
        ),
        why: 'the status-matrix row labels of the error battery (MatrixRow in utils/regression/inventory/errorCases/)',
    },
    {
        re: /^(?:F\d[a-c]?|P[12]|G[12])$/,
        files: exactFiles(
            'utils/regression/rbac/permissionMatrix.ts', 'utils/regression/rbac/permissionObjects.ts', 'tests/api/01-auth/permissions-by-role.api.spec.ts',
            'tests/regression/01-sign-in-and-access/08-restricted-user.spec.ts', 'tests/unit/rbac.spec.ts', 'tests/unit/rbacWire.spec.ts',
        ),
        why: 'the RBAC fixture ids (F and a digit), RA profiles (P) and groups (G) of utils/regression/rbac/permissionMatrix.ts and permissionObjects.ts',
    },
    {
        re: /^G-\d$/,
        files: exactFiles(
            'utils/regression/inventory/searchTables.ts', 'tests/api/02-certificates/search-filters.api.spec.ts', 'tests/regression/02-certificates/40-filter-condition-catalogue.spec.ts',
            'tests/regression/02-certificates/41-text-filters.spec.ts', 'tests/regression/02-certificates/42-date-and-duration-filters.spec.ts', 'tests/regression/02-certificates/43-list-and-enum-filters.spec.ts',
        ),
        why: 'the row ids of the inventory filter table (L-, G-, O- rows in utils/regression/inventory/searchTables.ts)',
    },
    { re: /^C[01]$/, near: /\bcontrol\b|\bcharacter\b/i, why: 'the Unicode C0 / C1 control-character sets' },
    { re: /^[RE]\d$/, near: /Let's Encrypt/, why: "the name of a Let's Encrypt intermediate CA" },
];

/**
 * Names of private tooling, kept as hashes so this public file does not spell them: a `qa-…` word whose SHA-256
 * prefix is listed is reported as a `tool-name` hit. Run-prefix words such as `qa-reg-…` / `qa-api-adhoc` are not listed.
 */
const TOOL_NAME_HASHES = new Set(['b0daf7e007b23940', '01e84f49b0a8513a', 'e6cd73d7fc1cb484', '8530b1e30901a8c2', '3f797c7cbdf6f9a2', '533e8ea0cb2e0c67', 'ae2a2392d0235618', '711be34712017f78', '851328519d666a33', '1c295464452b34cd', '83ac9da98b03abb3', '1a4266454cc764a8', 'aea913d83483d822', '306dc74ab8a3ee24', '84e8dd5ad3594c2f', 'b547fa75ee727856', '3a67e9e586e1bf3d', 'd54781c4f970fdee', 'b71ca969104640cf', '7bba470e2c4c38a0']);
const TOOL_WORD = /\bqa(?:-[a-z]+)+\b/g;
const sha16 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/** A string literal that is nothing but one short id (a seed id, a matrix row label) is a data key, not text a reader decodes. */
const DATA_KEY = /^['"`][A-Za-z]{1,2}-?\d+[a-z]?['"`]$/;

const TS_EXT = /\.(?:ts|mts|cts|js|mjs|cjs)$/;
const TEXT_FILE = /(?:\.md|\.json|\.ya?ml|^\.gitignore)$/;

/** The files the lint reads: tests/, utils/, pages/, fixtures/ and the top-level configs, docs and ignore file. */
export function publicTextFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (rel: string) => {
        for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
            const r = rel ? path.posix.join(rel, e.name) : e.name;
            if (e.isDirectory()) {
                if (['node_modules', 'test-results', 'playwright-report', '__baseline__', '.git'].includes(e.name)) continue;
                walk(r);
            } else if (TS_EXT.test(e.name) || TEXT_FILE.test(e.name)) out.push(r);
        }
    };
    for (const dir of ['tests', 'utils', 'pages', 'fixtures']) if (fs.existsSync(path.join(root, dir))) walk(dir);
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isFile() && e.name !== 'package-lock.json' && (TS_EXT.test(e.name) || TEXT_FILE.test(e.name))) out.push(e.name);
    }
    return out.sort();
}

/**
 * True when a string piece is (part of) a traceability value: the `rule:` value of an object literal (a string, a
 * template, an array of them, e.g. inside `testMeta({ rule: [...] })`), or the initializer of a `RULE` / `RULES` /
 * `RULE_…` constant that is handed to `rule:`.
 */
function isRuleValue(node: ts.Node): boolean {
    let n: ts.Node = node;
    while (n.parent && (ts.isArrayLiteralExpression(n.parent) || ts.isTemplateSpan(n.parent) || ts.isTemplateExpression(n.parent)
        || ts.isParenthesizedExpression(n.parent))) n = n.parent;
    const p = n.parent;
    if (p && ts.isPropertyAssignment(p) && p.initializer === n && ts.isIdentifier(p.name) && p.name.text === 'rule') return true;
    return isRuleConstInit(n);
}

/** `const RULE = …` / `const RULE_TEXTS = …`: a constant that only holds traceability text. */
function isRuleConstInit(n: ts.Node): boolean {
    let m: ts.Node = n;
    while (m.parent && (ts.isArrayLiteralExpression(m.parent) || ts.isObjectLiteralExpression(m.parent) || ts.isPropertyAssignment(m.parent)
        || ts.isTemplateSpan(m.parent) || ts.isTemplateExpression(m.parent) || ts.isAsExpression(m.parent) || ts.isSatisfiesExpression(m.parent))) m = m.parent;
    const p = m.parent;
    return !!p && ts.isVariableDeclaration(p) && p.initializer === m && ts.isIdentifier(p.name) && /^RULES?(?:_[A-Z]+)*$/.test(p.name.text);
}

/** The comments and string pieces of one TypeScript source, with the offset each starts at. */
export function tsTextPieces(src: string, file = 'x.ts'): { kind: 'comment' | 'string' | 'rule'; pos: number; text: string }[] {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const pieces: { kind: 'comment' | 'string' | 'rule'; pos: number; text: string }[] = [];
    const seen = new Set<number>();
    const comments = (ranges: ts.CommentRange[] | undefined) => {
        for (const r of ranges ?? []) {
            if (seen.has(r.pos)) continue;
            seen.add(r.pos);
            pieces.push({ kind: 'comment', pos: r.pos, text: src.slice(r.pos, r.end) });
        }
    };
    const visit = (node: ts.Node) => {
        if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
        if (node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken || node.kind === ts.SyntaxKind.EndOfFileToken) {
            comments(ts.getLeadingCommentRanges(src, node.pos));
            comments(ts.getTrailingCommentRanges(src, node.end));
        }
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
            pieces.push({ kind: isRuleValue(node) ? 'rule' : 'string', pos: node.getStart(sf), text: node.getText(sf) });
        }
        const kids = node.getChildren(sf);
        if (kids.length) kids.forEach(visit);
        else {
            comments(ts.getLeadingCommentRanges(src, node.pos));
            comments(ts.getTrailingCommentRanges(src, node.end));
        }
    };
    visit(sf);
    comments(ts.getLeadingCommentRanges(src, sf.endOfFileToken.pos));
    return pieces;
}

/** The ids a match names: the match itself, or the ids inside a parenthesised list or after a lead word. */
const idsOf = (match: string): string[] => {
    const inner = match.replace(/^\(|\)$/g, '').replace(/^(?:[Rr]eview|[Ff]inding|[Ii]tem|[Pp]oint)\s+/, '');
    return inner.split(/\s*[,\/;]\s*/).filter(Boolean);
};

/**
 * The sub-ids a file uses in its test ids (`REG-CERT-42[D-12]`, `API-CERT-34[T-9,T-10]`) and in the `row` of its testMeta()
 * calls (`testMeta({ id: 'REG-CERT-42', row: 'D-12' })`): public names of test rows, so
 * the same token elsewhere in that file (a comment that lists the rows) is not a private id.
 */
export function subIdsOf(src: string): Set<string> {
    const out = new Set<string>();
    const add = (row: string) => { for (const t of row.split(/[\s,\/]+/)) if (t) out.add(t); };
    for (const m of src.matchAll(/\b(?:REG|API)-[A-Z]+-\d+(?:\.\d+)?[a-z]?\[([^\]\n]{1,80})\]/g)) add(m[1]);
    // The row key of `testMeta({ id, row: '…' })`: the same public row name, moved out of the title.
    for (const m of src.matchAll(/\brow:\s*(['"`])([^'"`\n$]{1,80})\1/g)) add(m[2]);
    return out;
}

/** The pattern hits in one piece of text of file `rel` (allow-lists applied; `subIds`: the file's public sub-ids). */
export function shorthandIn(text: string, rel = '', subIds: ReadonlySet<string> = new Set()): { cls: string; match: string; index: number }[] {
    if (DATA_KEY.test(text.trim())) return [];
    const hits: { cls: string; match: string; index: number }[] = [];
    for (const { cls, re } of PUBLIC_TEXT_PATTERNS) {
        for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
            const at = m.index ?? 0;
            const lineStart = text.lastIndexOf('\n', at) + 1;
            const lineEnd = text.indexOf('\n', at);
            const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
            const ids = idsOf(m[0]);
            const allowed = ids.every((id) => subIds.has(id) || PUBLIC_TEXT_ALLOWED.some((a) => a.re.test(id) && (!a.files || a.files.test(rel)) && (!a.near || a.near.test(line))));
            if (!allowed) hits.push({ cls, match: m[0], index: at });
        }
    }
    for (const m of text.matchAll(TOOL_WORD)) {
        const parts = m[0].split('-');
        // `qa-x-y-zzz` also covers a tool name that is a prefix of the word (`qa-x-y` + `-zzz`).
        for (let n = 2; n <= parts.length; n++) {
            if (TOOL_NAME_HASHES.has(sha16(parts.slice(0, n).join('-')))) { hits.push({ cls: 'tool-name', match: m[0], index: m.index ?? 0 }); break; }
        }
    }
    return hits;
}

/** Every hit in one file's source (`rel` decides TypeScript vs plain text). */
export function publicTextHitsIn(rel: string, src: string): PublicTextHit[] {
    const lineOf = (pos: number) => src.slice(0, pos).split('\n').length;
    const lineText = (pos: number) => src.split('\n')[lineOf(pos) - 1].trim();
    const out: PublicTextHit[] = [];
    const pieces = TS_EXT.test(rel) ? tsTextPieces(src, rel) : [{ kind: 'text' as const, pos: 0, text: src }];
    const subIds = subIdsOf(src);
    for (const p of pieces) {
        for (const h of shorthandIn(p.text, rel, subIds)) {
            const pos = p.pos + h.index;
            out.push({ file: rel, line: lineOf(pos), kind: p.kind, cls: h.cls, match: h.match, text: lineText(pos) });
        }
    }
    return out;
}

/** Every hit under `root`. */
export function publicTextHits(root: string): PublicTextHit[] {
    return publicTextFiles(root).flatMap((rel) => publicTextHitsIn(rel, fs.readFileSync(path.join(root, rel), 'utf8')));
}
