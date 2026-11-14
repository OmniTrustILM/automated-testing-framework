/**
 * publicText — keeps the text of this public repository free of private working notes (short private ids, tool or person names, local
 * paths).
 * `publicTextHits()` scans comments and string literals of every TypeScript file and the Markdown, JSON and ignore files.
 */
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import * as ts from 'typescript';

export interface PublicTextHit {
    file: string;
    line: number;
    kind: 'comment' | 'string' | 'rule' | 'text';
    cls: string;
    match: string;
    text: string;
}

export const PUBLIC_TEXT_PATTERNS: { cls: string; re: RegExp }[] = [
    { cls: 'round-id', re: /\bfix[- ]pass(?:es)?\b|\bmicro-pass\b|\brev\d+\b|\bround[- ]?\d+\b|\bpass \d{1,2}\b|\bintegration pass\b|\blive run \d+\b|\bauthor decisions?\b/gi },
    // Short finding-number ids of private notes; a lone letter plus one digit in ordinary text is not a hit.
    {
        cls: 'finding-id',
        re: /\bR\d{2,}[a-z]?(?:-\d+)?\b|\b[RGSM]\d[a-z]?-\d+\b|\bF\d+[a-z]?(?:-\d+)?\b|\b[mn]\d+[a-z]?\b|\bG[DH]?-\d+\b|\((?:[RFGSMmn]\d+[a-z]?)(?:\s*[,\/;]\s*[RFGSMmn]?\d+[a-z]?)*\)|\b(?:[Rr]eview|[Ff]inding|[Ii]tem|[Pp]oint)\s+[RFGSMmn]\d+[a-z]?\b/g,
    },
    { cls: 'candidate-id', re: /\bC\d+[a-z]?\b/g },
    { cls: 'decision-id', re: /\b[QDO]\d+[a-z]?\b/g },
    { cls: 'plan-id', re: /§|\br\d+\b|\bB\d+(?:\.\d+)?[a-z]?\b|\b[TIE]\d+\b|\bTW\d+\b|\bW\d{1,2}\b|\bP-[A-Z]+\d+[a-z]?\b|(?<![\w-])[A-Z]-\d{2}\b(?![-\d])|\bSCP#\d+/g },
    { cls: 'plan-id', re: /\bphase[- ]?\d+[a-z]?\b/gi },
    { cls: 'plan-id', re: /\bthe plan's\b|\bplan\b(?=[^\n]{0,30}(?:\brows?\b|\btables?\b|§))|\b(?:rows?|tables?)\b(?=[^\n]{0,30}\bplan\b)/gi },
    { cls: 'model-name', re: /\b(?:Fable|Sonnet|Haiku|Opus|Claude|Copilot|GPT)\b/gi },
    { cls: 'local-path', re: /\/Users\/|\/private\/tmp\b|\bqa\/(?:workflow|knowledgebase|skills|gh)\b|~\/\.claude\b/g },
    { cls: 'local-path', re: /\bscratchpad\b/gi },
    { cls: 'plan-id', re: /\bOQ-\d+\b/g },
    { cls: 'round-id', re: /\bmerge \d{4}-\d{2}-\d{2}\b/gi },
    { cls: 'restructure-word', re: /\bP2Z\b|\bP2\.0\b|\bWP[1-5]\b|\bbarrel kept\b/g },
    {
        cls: 'process-wording',
        re: /(?<!\b(?:code|PR|pull request) )\breview(?:s|ed|er|ers|ing)?\b(?! of (?:the|a|this) (?:PR|pull request)\b)|\bthe author decided\b|\bmerge (?:pass|rehearsal|step)\b|\barea sandbox\b/gi,
    },
];

const exactFiles = (...files: string[]): RegExp => new RegExp(`^(?:${files.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

/**
 * Public ids that look like the patterns above; keep it tiny (`files` limits an entry to the files defining the ids, `near` needs the text
 * around the match).
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
    { re: /^r\d$/, near: /'@timeline-r\d'/, why: 'the check tags of an Epic timeline, one per later job run' },
];

/** Names of private tooling, kept as SHA-256 prefixes so this public file does not spell them. */
const TOOL_NAME_HASHES = new Set(['b0daf7e007b23940', '01e84f49b0a8513a', 'e6cd73d7fc1cb484', '8530b1e30901a8c2', '3f797c7cbdf6f9a2', '533e8ea0cb2e0c67', 'ae2a2392d0235618', '711be34712017f78', '851328519d666a33', '1c295464452b34cd', '83ac9da98b03abb3', '1a4266454cc764a8', 'aea913d83483d822', '306dc74ab8a3ee24', '84e8dd5ad3594c2f', 'b547fa75ee727856', '3a67e9e586e1bf3d', 'd54781c4f970fdee', 'b71ca969104640cf', '7bba470e2c4c38a0']);
const TOOL_WORD = /\bqa(?:-[a-z]+)+\b/g;
const sha16 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const DATA_KEY = /^['"`][A-Za-z]{1,2}-?\d+[a-z]?['"`]$/;

const TS_EXT = /\.(?:ts|mts|cts|js|mjs|cjs)$/;
const TEXT_FILE = /(?:\.md|\.json|\.ya?ml|^\.gitignore)$/;

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

/** True when a string piece is part of a traceability value: a `rule:` value or a `RULE` / `RULES` / `RULE_…` constant handed to `rule:`. */
function isRuleValue(node: ts.Node): boolean {
    let n: ts.Node = node;
    while (n.parent && (ts.isArrayLiteralExpression(n.parent) || ts.isTemplateSpan(n.parent) || ts.isTemplateExpression(n.parent)
        || ts.isParenthesizedExpression(n.parent))) n = n.parent;
    const p = n.parent;
    if (p && ts.isPropertyAssignment(p) && p.initializer === n && ts.isIdentifier(p.name) && p.name.text === 'rule') return true;
    return isRuleConstInit(n);
}

function isRuleConstInit(n: ts.Node): boolean {
    let m: ts.Node = n;
    while (m.parent && (ts.isArrayLiteralExpression(m.parent) || ts.isObjectLiteralExpression(m.parent) || ts.isPropertyAssignment(m.parent)
        || ts.isTemplateSpan(m.parent) || ts.isTemplateExpression(m.parent) || ts.isAsExpression(m.parent) || ts.isSatisfiesExpression(m.parent))) m = m.parent;
    const p = m.parent;
    return !!p && ts.isVariableDeclaration(p) && p.initializer === m && ts.isIdentifier(p.name) && /^RULES?(?:_[A-Z]+)*$/.test(p.name.text);
}

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

const idsOf = (match: string): string[] => {
    const inner = match.replace(/^\(|\)$/g, '').replace(/^(?:[Rr]eview|[Ff]inding|[Ii]tem|[Pp]oint)\s+/, '');
    return inner.split(/\s*[,\/;]\s*/).filter(Boolean);
};

/** The sub-ids a file uses in its test ids and `testMeta` rows (`REG-CERT-42[D-12]`): public row names, not private ids. */
export function subIdsOf(src: string): Set<string> {
    const out = new Set<string>();
    const add = (row: string) => { for (const t of row.split(/[\s,\/]+/)) if (t) out.add(t); };
    for (const m of src.matchAll(/\b(?:REG|API)-[A-Z]+-\d+(?:\.\d+)?[a-z]?\[([^\]\n]{1,80})\]/g)) add(m[1]);
    for (const m of src.matchAll(/\brow:\s*(['"`])([^'"`\n$]{1,80})\1/g)) add(m[2]);
    return out;
}

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
        for (let n = 2; n <= parts.length; n++) {
            if (TOOL_NAME_HASHES.has(sha16(parts.slice(0, n).join('-')))) { hits.push({ cls: 'tool-name', match: m[0], index: m.index ?? 0 }); break; }
        }
    }
    return hits;
}

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

export function publicTextHits(root: string): PublicTextHit[] {
    return publicTextFiles(root).flatMap((rel) => publicTextHitsIn(rel, fs.readFileSync(path.join(root, rel), 'utf8')));
}
