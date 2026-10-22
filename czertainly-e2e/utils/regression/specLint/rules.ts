/**
 * specLint/rules — the rule table of the deny-by-default lint.
 *
 * WHAT: `RULES` lists every rule of the lint as one entry `{ rule, scope, hits }`: `hits(node, bindings, context)`
 * returns the nodes of ONE syntax node that break the rule (usually none). The rule names and what each one forbids are
 * described in the header of rawMutations.ts. The five module-specifier checks (spec-import, raw-process, raw-network,
 * test-import, util-import) are written once in `moduleRules` and used by every import form: `import`, `import x =
 * require()`, `require()`, `import()` and `export ... from`.
 * WHY: a rule is one small, separately testable function, and adding one is a one-entry change instead of another
 * branch inside a 400-line visitor. The order of the table is the order in which findings of one node are reported;
 * the unit cases and the lint of the real tree depend on it, so a new entry goes at the end unless it must come first.
 * HOW: `rawMutations` visits every node once and asks each active entry (scope 'spec' only for files linted as
 * specs). Entries with `allow` are skipped for the files named there.
 *
 * Adding a rule (with a temporary allow-list while the code is cleaned up):
 *   1. add the name to `RawMutationRule` (rawMutations.ts) and describe it in that file's header;
 *   2. append `{ rule: 'new-rule', scope: 'spec', allow: ['tests/regression/01-x/01-y.spec.ts', ...], hits }` to
 *      RULES, with `allow` listing every file that violates it today (paths relative to czertainly-e2e);
 *   3. add a positive and a negative case in tests/unit/rawMutations.spec.ts (the allow-list needs no case of its
 *      own: rawMutations.spec.ts proves it with a stand-in rule);
 *   4. clean one file, delete its line from `allow`; when `allow` is empty remove the field.
 * The allow-list only ever shrinks. specGuards.spec.ts lints the whole tree with the table, so a violation outside the
 * list fails the unit run at once.
 */
import type * as TS from 'typescript';
import { Bindings, GUARD_FACTORIES, builtinName, isFsModule, type LintContext } from './bindings';
import type { RawMutationRule } from './rawMutations';

export interface Rule {
    /** The rule name reported for every returned node. */
    rule: RawMutationRule;
    /** 'spec' rules apply to files linted as specs only; 'all' rules also to the helpers. */
    scope: 'spec' | 'all';
    /** Files (relative to czertainly-e2e, forward slashes) where the rule is tolerated for now. */
    allow?: readonly string[];
    hits(n: TS.Node, b: Bindings, ctx: LintContext): readonly TS.Node[];
}

type Hits = readonly TS.Node[];
const NONE: Hits = [];

const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const EXTRACTED = new Set(['post', 'put', 'patch', 'delete', 'fetch']);
const UTILS_MODULE = /(^|\/)utils\/[A-Za-z]+Utils$/;
/** Named imports a REG / API file may take from utils/*Utils.ts (creates, reads, waits, generators, uploads, ensures). */
const UTIL_IMPORT_ALLOWED = /^(create|find|get|list|wait|generate|upload|ensure)[A-Z0-9_]/;
/** Allowed by prefix but changing pre-existing objects: never importable. */
const UTIL_IMPORT_DENIED = new Set(['ensureConnectorRegistered']);
/** Network modules a spec may not import: they bypass every API context. */
const RAW_NETWORK = new Set(['http', 'https', 'http2', 'net', 'tls', 'undici', '@kubernetes/client-node']);
const isRawNetworkModule = (spec: string, resolved: string): boolean =>
    RAW_NETWORK.has(builtinName(spec)) || /(^|\/)utils\/k8sClient$/.test(resolved);
/**
 * Modules a spec may import `test` from: the fixtures (smoke-sized and spec-facing), an area fixture (`fixtures/areas/<name>`,
 * which itself extends the spec-facing fixtures once and is linted like a spec: tests/unit/specGuards.spec.ts), or the API
 * template's re-export. Matched against the root-relative resolved path (the lint gets root-relative file names), so a
 * `fixtures/areas` folder anywhere else does not qualify.
 */
const TEST_SOURCES = /^(fixtures\/testFixtures|fixtures\/regressionFixtures|fixtures\/areas\/[a-z][A-Za-z0-9]*|utils\/api\/apiCase)$/;
/** An area fixture module (root-relative, without extension). */
const AREA_FIXTURE = /^fixtures\/areas\/[a-z][A-Za-z0-9]*$/;
/** Node built-ins a spec may import: no network, no processes, no module loaders, no VM / workers. */
const SPEC_BUILTINS = new Set(['assert', 'buffer', 'crypto', 'fs', 'fs/promises', 'os', 'path', 'string_decoder', 'timers', 'timers/promises', 'url', 'util', 'zlib']);
/** Folders a relative import of a spec may resolve into (never node_modules, never outside the suite). */
const SPEC_RELATIVE_ROOTS = /^(fixtures|utils|pages|tests)\//;
/** fs members that write, remove or open for writing. */
const FS_WRITE = /^(write|append|rm|unlink|rename|copyFile|cp|truncate|ftruncate|symlink|link|chmod|lchmod|fchmod|chown|lchown|fchown|utimes|lutimes|futimes|mkdir|mkdtemp|open|createWriteStream)/;
const ENV_WRITERS: Record<string, Set<string>> = { Object: new Set(['assign', 'defineProperty', 'defineProperties']), Reflect: new Set(['set', 'defineProperty', 'deleteProperty']) };
const LOADER_MEMBERS = new Set(['mainModule', 'binding', '_linkedBinding', 'dlopen']);
/** Calls that only READ a whole `process.env` handed to them. */
const ENV_READERS: Record<string, Set<string>> = { Object: new Set(['keys', 'values', 'entries', 'getOwnPropertyNames']), JSON: new Set(['stringify']) };
/** Timers that would evaluate a string (Node refuses one, but the lint does not rely on that). */
const STRING_TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate']);
/** Options the guard forwards (guardedApi FORWARDED_OPTIONS), its own switch, and `method` (fetch only). */
const REQUEST_OPTIONS = new Set(['data', 'params', 'headers', 'timeout', 'failOnStatusCode', 'ignoreHTTPSErrors', 'identityOverride']);
const REQUEST_CALLS = new Set(['get', 'post', 'put', 'patch', 'delete', 'fetch']);
/** The guard's inner modules: they read, check, claim and send, and only the guard may compose them (createGuard.ts). */
const GUARD_INTERNAL = /(^|\/)utils\/regression\/guard\/(sendRequest|guardState|readRequest|checkRequest|claims)(\.ts|\.js)?$/;
/** Files that may import them: the guard's own folder and the unit tests. */
const GUARD_INTERNAL_ALLOWED = /^(utils\/regression\/guard|tests\/unit)\//;
/**
 * Fixtures `test.use` must not replace in a spec: a context, the environment, the tokens, and every spec-facing fixture of
 * fixtures/regressionFixtures.ts (`signedIn` is a page, `localApi` a guarded context, `own` / `live` / `needs` carry the ledger and the
 * live-ownership steps, `regressionEnv` the settings).
 */
export const CONTEXT_FIXTURES: ReadonlySet<string> = new Set([
    'api', 'anonymousApi', 'adminToken', 'restrictedToken', 'request', 'env', 'page', 'context', 'browser',
    'own', 'live', 'needs', 'declaredNeeds', 'signedIn', 'localApi', 'regressionEnv', 'ownRaProfile',
]);
/** Callees that would print a token's text (a leak into a report, a log or an assertion message). */
const TOKEN_SINKS: Record<string, Set<string>> = { console: new Set(['log', 'info', 'warn', 'error', 'debug', 'trace']), JSON: new Set(['stringify']) };
const TOKEN_SINK_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'push']);
const PLAYWRIGHT = '@playwright/test';

const isChildProcess = (spec: string): boolean => spec === 'child_process' || spec === 'node:child_process';

// ------------------------------------------------------------------ module specifiers (every import form)

/** How one import form treats the specifier. */
interface ModuleForm {
    /** A specifier that is not a string literal is a spec-import (import equals, require, import()). */
    nonLiteral: boolean;
    /** What naming `@playwright/test` as a whole module means; the import declaration judges its clause instead. */
    playwright?: 'spec-import' | 'test-import';
    /** The whole module may not be a utils/*Utils.ts one (require, import()); the import declaration judges its names. */
    utilsWhole: boolean;
    /** Naming child_process or a network module is a raw-process / raw-network (every form but `export ... from`). */
    rawModules: boolean;
}

const FORMS: Record<'import' | 'import-equals' | 'export' | 'call', ModuleForm> = {
    'import': { nonLiteral: false, utilsWhole: false, rawModules: true },
    'import-equals': { nonLiteral: true, playwright: 'spec-import', utilsWhole: false, rawModules: true },
    'export': { nonLiteral: false, playwright: 'spec-import', utilsWhole: false, rawModules: false },
    'call': { nonLiteral: true, playwright: 'test-import', utilsWhole: true, rawModules: true },
};

/** A relative import of a spec stays in the suite; anything else is a node built-in on the allow-list. */
function specImportProblem(b: Bindings, spec: string): boolean {
    if (spec.startsWith('.')) {
        const resolved = b.resolveModule(spec);
        return !SPEC_RELATIVE_ROOTS.test(resolved) || resolved.split('/').includes('node_modules');
    }
    if (spec === PLAYWRIGHT) return false; // its own rules: test-import / raw-context / type-only
    const name = builtinName(spec);
    if (name === 'child_process' || isRawNetworkModule(spec, b.resolveModule(spec))) return false; // their own rules
    return !SPEC_BUILTINS.has(name);
}

const isUtilsModule = (b: Bindings, spec: string): boolean => UTILS_MODULE.test(b.resolveModule(spec)) || UTILS_MODULE.test(spec);

/** The rules one module specifier breaks, for the import form it appears in. */
function moduleRules(b: Bindings, ctx: LintContext, spec: string | undefined, form: ModuleForm): RawMutationRule[] {
    const out: RawMutationRule[] = [];
    if (spec !== undefined && GUARD_INTERNAL.test(b.resolveModule(spec)) && !GUARD_INTERNAL_ALLOWED.test(ctx.fileName.replace(/\\/g, '/'))) out.push('guard-internal');
    if (ctx.isSpec) {
        if (spec === undefined ? form.nonLiteral : specImportProblem(b, spec) || (form.playwright === 'spec-import' && spec === PLAYWRIGHT)) out.push('spec-import');
        if (spec !== undefined && form.rawModules && isChildProcess(spec)) out.push('raw-process');
        if (spec !== undefined && form.rawModules && isRawNetworkModule(spec, b.resolveModule(spec))) out.push('raw-network');
        if (spec !== undefined && form.playwright === 'test-import' && spec === PLAYWRIGHT) out.push('test-import');
    }
    if (form.utilsWhole && spec !== undefined && isUtilsModule(b, spec)) out.push('util-import');
    return out;
}

interface ModuleHit {
    rule: RawMutationRule;
    node: TS.Node;
}

/** `import { x } from 'm'`: the specifier rules plus the rules of the names taken. */
function importDeclarationHits(n: TS.ImportDeclaration, b: Bindings, ctx: LintContext): ModuleHit[] {
    const { ts, isSpec } = ctx;
    const spec = (n.moduleSpecifier as TS.StringLiteral).text;
    const clause = n.importClause;
    const typeOnly = !!clause?.isTypeOnly;
    const out: ModuleHit[] = [];
    for (const rule of moduleRules(b, ctx, spec, FORMS.import)) if (!((rule === 'spec-import' || rule === 'guard-internal') && typeOnly)) out.push({ rule, node: n });
    const valueNames = clause && !typeOnly && clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings : undefined;
    if (isSpec && spec === PLAYWRIGHT && valueNames) {
        // Types only: `test` / `request` have their own rules; any other lower-case value (expect, chromium, devices ...) is refused.
        for (const el of valueNames.elements) {
            const name = (el.propertyName ?? el.name).text;
            if (!el.isTypeOnly && /^[a-z_$]/.test(name) && name !== 'test' && name !== 'request') out.push({ rule: 'spec-import', node: el });
        }
    }
    if (isSpec && isFsModule(spec) && valueNames) {
        for (const el of valueNames.elements) if (!el.isTypeOnly && FS_WRITE.test((el.propertyName ?? el.name).text)) out.push({ rule: 'fs-write', node: el });
    }
    out.push(...testImportHits(n, b, ctx), ...requestImportHits(n, ctx), ...utilImportHits(n, b, ctx));
    return out;
}

/** `test` taken from anything but the fixtures; a namespace / default import of `@playwright/test`. */
function testImportHits(n: TS.ImportDeclaration, b: Bindings, ctx: LintContext): ModuleHit[] {
    const { ts } = ctx;
    const spec = (n.moduleSpecifier as TS.StringLiteral).text;
    const clause = n.importClause;
    const out: ModuleHit[] = [];
    if (!(ctx.isSpec && clause && !clause.isTypeOnly)) return out;
    const named = clause.namedBindings;
    if (spec === PLAYWRIGHT && (clause.name || (named && ts.isNamespaceImport(named)))) out.push({ rule: 'test-import', node: clause });
    // An area fixture hands a spec `test` and `expect` only (its other names are its own; utils/regression/specLint/areaFixtures.ts).
    const fromArea = AREA_FIXTURE.test(b.resolveModule(spec));
    if (fromArea && (clause.name || (named && ts.isNamespaceImport(named)))) out.push({ rule: 'test-import', node: clause });
    if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
            if (el.isTypeOnly) continue;
            const imported = (el.propertyName ?? el.name).text;
            if (imported === 'test' && !TEST_SOURCES.test(b.resolveModule(spec))) out.push({ rule: 'test-import', node: el });
            else if (fromArea && imported !== 'test' && imported !== 'expect') out.push({ rule: 'test-import', node: el });
        }
    }
    return out;
}

/** The `request` factory of `@playwright/test` (a raw context), also from a type-only clause. */
function requestImportHits(n: TS.ImportDeclaration, ctx: LintContext): ModuleHit[] {
    const named = n.importClause?.namedBindings;
    if ((n.moduleSpecifier as TS.StringLiteral).text !== PLAYWRIGHT || !named || !ctx.ts.isNamedImports(named)) return [];
    return named.elements
        .filter((el) => (el.propertyName ?? el.name).text === 'request' && !el.isTypeOnly)
        .map((node) => ({ rule: 'raw-context' as const, node }));
}

/** A utils/*Utils.ts module: named imports by allow-list only, no namespace / default import. */
function utilImportHits(n: TS.ImportDeclaration, b: Bindings, ctx: LintContext): ModuleHit[] {
    const spec = (n.moduleSpecifier as TS.StringLiteral).text;
    const clause = n.importClause;
    const out: ModuleHit[] = [];
    if (!(isUtilsModule(b, spec) && clause && !clause.isTypeOnly)) return out;
    if (clause.name) out.push({ rule: 'util-import', node: clause });
    const named = clause.namedBindings;
    if (named && ctx.ts.isNamespaceImport(named)) out.push({ rule: 'util-import', node: named });
    if (named && ctx.ts.isNamedImports(named)) {
        for (const el of named.elements) {
            if (el.isTypeOnly) continue;
            const imported = (el.propertyName ?? el.name).text;
            if (!UTIL_IMPORT_ALLOWED.test(imported) || UTIL_IMPORT_DENIED.has(imported)) out.push({ rule: 'util-import', node: el });
        }
    }
    return out;
}

/** Each node is asked by several table entries: its module hits are worked out once (a node belongs to one parse). */
const moduleMemo = new WeakMap<TS.Node, ModuleHit[]>();

/** The module rules of one node, whatever import form it is; the table entries pick their own rule from it. */
function moduleHits(n: TS.Node, b: Bindings, ctx: LintContext): ModuleHit[] {
    let hits = moduleMemo.get(n);
    if (!hits) moduleMemo.set(n, (hits = computeModuleHits(n, b, ctx)));
    return hits;
}

function computeModuleHits(n: TS.Node, b: Bindings, ctx: LintContext): ModuleHit[] {
    const { ts } = ctx;
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) return importDeclarationHits(n, b, ctx);
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && !n.isTypeOnly) {
        return moduleRules(b, ctx, n.moduleSpecifier.text, FORMS.export).map((rule) => ({ rule, node: n }));
    }
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && !n.isTypeOnly) {
        return moduleRules(b, ctx, b.literal(n.moduleReference.expression), FORMS['import-equals']).map((rule) => ({ rule, node: n }));
    }
    if (ts.isCallExpression(n) && isModuleCall(n, b, ctx)) {
        return moduleRules(b, ctx, b.literal(n.arguments[0]), FORMS.call).map((rule) => ({ rule, node: n }));
    }
    return [];
}

/** `require(x)` or `import(x)`. */
function isModuleCall(n: TS.CallExpression, b: Bindings, ctx: LintContext): boolean {
    const c = n.expression;
    if (c.kind === ctx.ts.SyntaxKind.ImportKeyword) return true;
    return ctx.ts.isIdentifier(c) && c.text === 'require' && !b.isApiJsonCallee(c);
}

/** The nodes of one rule among the module hits of a node (every import form). */
const moduleHitsOf = (rule: RawMutationRule) => (n: TS.Node, b: Bindings, ctx: LintContext): Hits =>
    moduleHits(n, b, ctx).filter((h) => h.rule === rule).map((h) => h.node);

/** A table entry for one rule of the module forms. */
const moduleRule = (rule: RawMutationRule, scope: Rule['scope']): Rule => ({ rule, scope, hits: moduleHitsOf(rule) });

// ------------------------------------------------------------------ token-use

/** The token reference sits in a template, a concatenation or an object literal. */
function tokenInValue(ts: typeof TS, p: TS.Node, x: TS.Node): boolean {
    if (ts.isTemplateSpan(p)) return true;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) return true;
    if (ts.isPropertyAssignment(p) && p.initializer === x) return true;
    return ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p);
}

/** The token reference is an argument of a sink: `expect(t)`, `String(t)`, `console.log(t)`, `.push(t)`. */
function tokenInSink(ts: typeof TS, call: TS.CallExpression): boolean {
    const c = call.expression;
    if (ts.isIdentifier(c) && (c.text === 'expect' || c.text === 'String')) return true;
    if (!ts.isPropertyAccessExpression(c)) return false;
    const root = c.expression;
    if (ts.isIdentifier(root) && Object.hasOwn(TOKEN_SINKS, root.text) && TOKEN_SINKS[root.text].has(c.name.text)) return true;
    return TOKEN_SINK_METHODS.has(c.name.text) || (ts.isIdentifier(root) && root.text === 'expect');
}

function tokenUseHits(n: TS.Node, b: Bindings, ctx: LintContext): Hits {
    const { ts } = ctx;
    if (!ts.isIdentifier(n) || !b.isTokenRef(n)) return NONE;
    let x: TS.Node = n;
    while (ts.isParenthesizedExpression(x.parent) || ts.isNonNullExpression(x.parent) || ts.isAsExpression(x.parent) || ts.isAwaitExpression(x.parent)) x = x.parent;
    const p = x.parent;
    if (tokenInValue(ts, p, x)) return [n];
    if (ts.isCallExpression(p) && p.arguments.includes(x as TS.Expression) && tokenInSink(ts, p)) return [n];
    return ts.isCallExpression(p) && p.expression === x ? [n] : NONE;
}

// ------------------------------------------------------------------ identifiers and property accesses

const identifierNamed = (...names: string[]): Rule['hits'] => (n, _b, ctx) => (ctx.ts.isIdentifier(n) && names.includes(n.text) ? [n] : NONE);

/** The receiver of a call: `x.m(...)` where `x` is the node. */
const isReceiverOfCall = (ts: typeof TS, n: TS.Node): boolean => {
    const p = n.parent;
    return ts.isPropertyAccessExpression(p) && p.expression === n && ts.isCallExpression(p.parent) && p.parent.expression === p;
};

/** The `request` fixture of a test used as anything but the receiver of a call or an argument of a guard factory. */
function requestFixtureUseHits(n: TS.Node, b: Bindings, ctx: LintContext): Hits {
    const { ts } = ctx;
    if (!ts.isIdentifier(n) || !b.isRequestFixtureName(n) || ts.isBindingElement(n.parent)) return NONE;
    const p = n.parent;
    const factoryArg = ts.isCallExpression(p) && p.arguments.includes(n as TS.Expression) && ts.isIdentifier(p.expression) && GUARD_FACTORIES.has(p.expression.text);
    return !isReceiverOfCall(ts, n) && !factoryArg ? [n] : NONE;
}

/** `page.request` used as anything but the receiver of a call. */
function pageRequestHits(n: TS.Node, b: Bindings, ctx: LintContext): Hits {
    return ctx.ts.isPropertyAccessExpression(n) && b.isPageRequest(n) && !isReceiverOfCall(ctx.ts, n) ? [n] : NONE;
}

/** `x.post` / `.put` / `.patch` / `.delete` / `.fetch` taken without calling it, on a receiver that is not guarded. */
function methodExtractionHits(n: TS.Node, b: Bindings, ctx: LintContext): Hits {
    const { ts } = ctx;
    if (!ts.isPropertyAccessExpression(n)) return NONE;
    const calledHere = ts.isCallExpression(n.parent) && n.parent.expression === n;
    if (calledHere || !EXTRACTED.has(n.name.text) || b.isGuarded(n.expression)) return NONE;
    return n.name.text === 'delete' && b.isCollection(n.expression) ? NONE : [n];
}

/** An fs write on an fs binding: `fs.writeFile`, `fs['x']`, `const { rmSync } = fs`. */
function fsWriteNodeHits(n: TS.Node, b: Bindings, ctx: LintContext): Hits {
    const { ts } = ctx;
    if (ts.isPropertyAccessExpression(n)) return FS_WRITE.test(n.name.text) && b.isFsBinding(n.expression) ? [n] : NONE;
    if (ts.isElementAccessExpression(n) && b.isFsBinding(n.expression)) {
        const key = b.literal(n.argumentExpression);
        return key === undefined || FS_WRITE.test(key) ? [n] : NONE;
    }
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && b.isFsBinding(n.initializer)) {
        return n.name.elements.filter((el) => FS_WRITE.test((el.propertyName ?? el.name).getText(ctx.sf)));
    }
    return NONE;
}

/** `process.binding(...)`, `process.mainModule` and friends: module loaders past the allow-list. */
function loaderMemberHits(n: TS.Node, b: Bindings, ctx: LintContext): Hits {
    const { ts } = ctx;
    if (ts.isPropertyAccessExpression(n)) return LOADER_MEMBERS.has(n.name.text) && b.isProcessRef(n.expression) ? [n] : NONE;
    if (ts.isElementAccessExpression(n)) return LOADER_MEMBERS.has(b.literal(n.argumentExpression) ?? '') && b.isProcessRef(n.expression) ? [n] : NONE;
    return NONE;
}

// ------------------------------------------------------------------ dynamic code and env writes

/** Inside a type (an annotation, an interface): `Function` there is a type, not the constructor. */
function inTypePosition(ts: typeof TS, n: TS.Node): boolean {
    for (let p: TS.Node | undefined = n.parent; p; p = p.parent) {
        if (p.kind >= ts.SyntaxKind.FirstTypeNode && p.kind <= ts.SyntaxKind.LastTypeNode) return true;
        if (ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) return true;
        if (ts.isStatement(p) || ts.isExpressionStatement(p)) return false;
    }
    return false;
}

/** The name of a declaration or of a property (`{ eval: 1 }`, `x.eval` stays a reference). */
function isDeclarationName(ts: typeof TS, n: TS.Identifier): boolean {
    const p = n.parent;
    return (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) ||
        ts.isFunctionDeclaration(p) || ts.isParameter(p) || ts.isVariableDeclaration(p)) && (p as { name?: TS.Node }).name === n;
}

function dynamicCodeHits(n: TS.Node, b: Bindings, ctx: LintContext): Hits {
    const { ts } = ctx;
    if (ts.isIdentifier(n)) return (n.text === 'eval' || n.text === 'Function') && !inTypePosition(ts, n) && !isDeclarationName(ts, n) ? [n] : NONE;
    if (!(ts.isCallExpression(n) || ts.isNewExpression(n))) return NONE;
    const out: TS.Node[] = [];
    const callee = b.unwrap(n.expression);
    const member = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isElementAccessExpression(callee) ? b.literal(callee.argumentExpression) : undefined;
    if (member === 'constructor') out.push(n);
    const timer = ts.isIdentifier(callee) ? callee.text : member;
    const first = n.arguments?.[0] && b.unwrap(n.arguments[0]);
    if (timer && STRING_TIMERS.has(timer) && first && (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first) || ts.isBinaryExpression(first))) out.push(n);
    return out;
}

/** `process.env` handed to a function as a whole (it can write any key), unless the callee only reads or is a suite helper. */
function envHandedAwayHits(n: TS.CallExpression, b: Bindings, ctx: LintContext): Hits {
    const { ts } = ctx;
    if (!n.arguments.some((a) => b.isProcessEnv(a))) return NONE;
    const c = n.expression;
    const root = ts.isPropertyAccessExpression(c) ? c.expression : c;
    const named = ts.isPropertyAccessExpression(c) && ts.isIdentifier(root) ? root.text : undefined;
    const reader = named !== undefined && Object.hasOwn(ENV_READERS, named) && ENV_READERS[named].has((c as TS.PropertyAccessExpression).name.text);
    const writer = named !== undefined && Object.hasOwn(ENV_WRITERS, named);
    const helper = ts.isIdentifier(root) && b.isSuiteHelper(root);
    return reader || writer || helper ? NONE : [n];
}

/** `Object.assign` / `defineProperty` / `Reflect.set` ... on `process.env` or one of its keys. */
function envWriterCallHits(n: TS.CallExpression, b: Bindings, ctx: LintContext): Hits {
    const { ts } = ctx;
    const c = n.expression;
    if (!(ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && Object.hasOwn(ENV_WRITERS, c.expression.text) && ENV_WRITERS[c.expression.text].has(c.name.text))) return NONE;
    return n.arguments[0] && (b.isProcessEnv(n.arguments[0]) || b.isEnvTarget(n.arguments[0])) ? [n] : NONE;
}

function envWriteHits(n: TS.Node, b: Bindings, ctx: LintContext): Hits {
    const { ts } = ctx;
    if (ts.isCallExpression(n)) return [...envHandedAwayHits(n, b, ctx), ...envWriterCallHits(n, b, ctx)];
    if (ts.isBinaryExpression(n)) {
        const assigns = n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        return assigns && b.isEnvTarget(n.left) ? [n] : NONE;
    }
    if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
        const step = n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken;
        return step && b.isEnvTarget(n.operand) ? [n] : NONE;
    }
    return ts.isDeleteExpression(n) && b.isEnvTarget(n.expression) ? [n] : NONE;
}

// ------------------------------------------------------------------ guarded contexts

function guardedReassignHits(n: TS.Node, b: Bindings, ctx: LintContext): Hits {
    const { ts } = ctx;
    if (!(ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left))) return NONE;
    return b.isGuardedSymbol(b.sym(n.left)) && !b.isGuarded(n.right) ? [n] : NONE;
}

/** `recv.<method>(args)`: the dynamic-method / raw-request-use / context-method / fetch-method verdicts. */
function methodVerdict(call: TS.CallExpression, b: Bindings, ctx: LintContext, recv: TS.Expression, method: string | undefined): RawMutationRule | undefined {
    if (method === undefined) return b.isGuarded(recv) ? undefined : 'dynamic-method';
    const m = method.toLowerCase();
    if (b.isRequestFixture(recv)) {
        if (m === 'get' || m === 'head') return undefined;
        return m === 'fetch' && b.isReadMethod(b.methodOf(call.arguments[1])) ? undefined : 'raw-request-use';
    }
    if (MUTATING_METHODS.has(m)) {
        if (b.isGuarded(recv) || (m === 'delete' && b.isCollection(recv)) || (m === 'post' && b.urlAllowed(call.arguments[0]))) return undefined;
        return 'context-method';
    }
    return m === 'fetch' ? fetchVerdict(call, b, ctx, recv) : undefined;
}

/** `route.fetch({ method })` takes its options first; `ctx.fetch(url, { method })` second. */
function fetchVerdict(call: TS.CallExpression, b: Bindings, ctx: LintContext, recv: TS.Expression): RawMutationRule | undefined {
    const first = call.arguments[0] && b.unwrap(call.arguments[0]);
    const verb = call.arguments.length === 1 && first && ctx.ts.isObjectLiteralExpression(first) ? b.methodOf(first) : b.methodOf(call.arguments[1]);
    if (b.isReadMethod(verb) || b.isGuarded(recv)) return undefined;
    return verb === 'POST' && b.urlAllowed(call.arguments[0]) ? undefined : 'fetch-method';
}

/** apiJson* and send(ctx, method, url): a guarded context, a GET, or an allow-listed literal POST. */
function jsonVerdict(call: TS.CallExpression, b: Bindings, rule: 'apiJson' | 'send-method'): RawMutationRule | undefined {
    const [context, methodArg, url] = call.arguments;
    if (b.isGuarded(context)) return undefined;
    const verb = b.literal(methodArg)?.toUpperCase();
    if (b.isReadMethod(verb) || (verb === 'POST' && b.urlAllowed(url))) return undefined;
    return rule;
}

/** The one request rule a call breaks, if any: the callee decides which verdict applies. */
function callVerdict(call: TS.CallExpression, b: Bindings, ctx: LintContext): RawMutationRule | undefined {
    const { ts } = ctx;
    const c = call.expression;
    if (ts.isPropertyAccessExpression(c)) return /^apiJson/.test(c.name.text) ? jsonVerdict(call, b, 'apiJson') : methodVerdict(call, b, ctx, c.expression, c.name.text);
    if (ts.isElementAccessExpression(c)) return methodVerdict(call, b, ctx, c.expression, b.literal(c.argumentExpression));
    if (!ts.isIdentifier(c)) return undefined;
    if (c.text === 'fetch' && !(b.sym(c)?.declarations?.length)) {
        const verb = b.methodOf(call.arguments[1]);
        return b.isReadMethod(verb) || (verb === 'POST' && b.urlAllowed(call.arguments[0])) ? undefined : 'fetch-method';
    }
    if (b.isApiJsonCallee(c)) return jsonVerdict(call, b, 'apiJson');
    return c.text === 'send' && call.arguments.length >= 2 ? jsonVerdict(call, b, 'send-method') : undefined;
}

/** Each call is asked by six table entries: its verdict is worked out once (a node belongs to one parse). */
const callMemo = new WeakMap<TS.Node, RawMutationRule | undefined>();

function memoisedCallVerdict(call: TS.CallExpression, b: Bindings, ctx: LintContext): RawMutationRule | undefined {
    if (!callMemo.has(call)) callMemo.set(call, callVerdict(call, b, ctx));
    return callMemo.get(call);
}

const callRule = (rule: RawMutationRule): Rule => ({
    rule,
    scope: 'all',
    hits: (n, b, ctx) => (ctx.ts.isCallExpression(n) && memoisedCallVerdict(n, b, ctx) === rule ? [n] : NONE),
});

// ------------------------------------------------------------------ spec-only call rules

/** A call `x.<name>(...)` as the property-access callee, or undefined. */
function propertyCallee(ts: typeof TS, n: TS.Node): { call: TS.CallExpression; callee: TS.PropertyAccessExpression } | undefined {
    return ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) ? { call: n, callee: n.expression } : undefined;
}

/** `.extend(...)`, and `test.use(...)` overriding a context fixture. */
function fixtureExtendHits(n: TS.Node, b: Bindings, ctx: LintContext): Hits {
    const { ts } = ctx;
    const pc = propertyCallee(ts, n);
    if (!pc) return NONE;
    const { call, callee } = pc;
    if (callee.name.text === 'extend') return [call];
    if (!(callee.name.text === 'use' && ts.isIdentifier(callee.expression) && callee.expression.text === 'test')) return NONE;
    const o = call.arguments[0] && b.unwrap(call.arguments[0]);
    const overrides = !o || !ts.isObjectLiteralExpression(o) || o.properties.some((p) =>
        ts.isSpreadAssignment(p) || !p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) || CONTEXT_FIXTURES.has(p.name.text));
    return overrides ? [call] : NONE;
}

/** An options object with a key the guard does not forward. */
function requestOptionHits(n: TS.Node, _b: Bindings, ctx: LintContext): Hits {
    const { ts } = ctx;
    const pc = propertyCallee(ts, n);
    if (!pc || !REQUEST_CALLS.has(pc.callee.name.text) || pc.call.arguments.length < 2) return NONE;
    let o: TS.Expression = pc.call.arguments[1];
    while (ts.isAsExpression(o) || ts.isTypeAssertionExpression(o) || ts.isSatisfiesExpression(o) || ts.isParenthesizedExpression(o) || ts.isNonNullExpression(o)) o = o.expression;
    if (!ts.isObjectLiteralExpression(o)) return NONE;
    const bad = o.properties.some((p) => {
        if (ts.isSpreadAssignment(p)) return false;
        const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
        if (key === undefined) return true;
        if (key === 'method') return pc.callee.name.text !== 'fetch';
        return !REQUEST_OPTIONS.has(key);
    });
    return bad ? [pc.call] : NONE;
}

/** `route.continue(...)` / `route.fulfill(...)` with a `method` (or options that are not a literal). */
function routeMethodHits(n: TS.Node, b: Bindings, ctx: LintContext): Hits {
    const { ts } = ctx;
    const pc = propertyCallee(ts, n);
    if (!pc || !(pc.callee.name.text === 'continue' || pc.callee.name.text === 'fulfill')) return NONE;
    const o = pc.call.arguments[0] && b.unwrap(pc.call.arguments[0]);
    const literalWithoutMethod = !o || (ts.isObjectLiteralExpression(o) && o.properties.every((p) =>
        !ts.isSpreadAssignment(p) && !(p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'method')));
    return literalWithoutMethod ? NONE : [pc.call];
}

// ------------------------------------------------------------------ the table

/**
 * The rules in the order their findings are reported for one node. Several names appear twice because one name covers
 * different node kinds and another rule sits between them for a node kind they share.
 */
export const RULES: readonly Rule[] = [
    { rule: 'token-use', scope: 'spec', hits: tokenUseHits },
    { rule: 'raw-context', scope: 'all', hits: identifierNamed('getAuthenticatedApiContext', 'newAnonymousContext') },
    { rule: 'unit-seam', scope: 'all', hits: identifierNamed('guardApiWithSeams', 'judgeWithSeams') },
    { rule: 'raw-xhr', scope: 'all', hits: identifierNamed('XMLHttpRequest') },
    { rule: 'spec-import', scope: 'spec', hits: (n, b, ctx) => [...identifierNamed('createRequire')(n, b, ctx), ...moduleHitsOf('spec-import')(n, b, ctx)] },
    { rule: 'fs-write', scope: 'spec', hits: (n, b, ctx) => [...moduleHitsOf('fs-write')(n, b, ctx), ...fsWriteNodeHits(n, b, ctx)] },
    { rule: 'spec-import', scope: 'spec', hits: loaderMemberHits },
    moduleRule('raw-process', 'spec'),
    moduleRule('raw-network', 'spec'),
    moduleRule('test-import', 'spec'),
    moduleRule('raw-context', 'all'),
    moduleRule('util-import', 'all'),
    moduleRule('guard-internal', 'all'),
    { rule: 'raw-xhr', scope: 'all', hits: (n, _b, ctx) => (ctx.ts.isPropertyAccessExpression(n) && n.name.text === 'sendBeacon' ? [n] : NONE) },
    { rule: 'raw-request-use', scope: 'all', hits: requestFixtureUseHits },
    { rule: 'raw-request-use', scope: 'spec', hits: pageRequestHits },
    { rule: 'method-extraction', scope: 'all', hits: methodExtractionHits },
    { rule: 'dynamic-code', scope: 'spec', hits: dynamicCodeHits },
    { rule: 'env-write', scope: 'spec', hits: envWriteHits },
    {
        rule: 'guarded-cast',
        scope: 'all',
        hits: (n, b, ctx) => ((ctx.ts.isAsExpression(n) || ctx.ts.isTypeAssertionExpression(n)) && b.typeNamed(n.type, 'GuardedApi') ? [n] : NONE),
    },
    { rule: 'guarded-reassign', scope: 'all', hits: guardedReassignHits },
    callRule('apiJson'),
    callRule('send-method'),
    callRule('context-method'),
    callRule('fetch-method'),
    callRule('dynamic-method'),
    callRule('raw-request-use'),
    { rule: 'fixture-extend', scope: 'spec', hits: fixtureExtendHits },
    { rule: 'request-option', scope: 'spec', hits: requestOptionHits },
    { rule: 'route-method', scope: 'spec', hits: routeMethodHits },
    {
        rule: 'live-forge',
        scope: 'all',
        hits: (n, b, ctx) => ((ctx.ts.isAsExpression(n) || ctx.ts.isTypeAssertionExpression(n)) && b.typeNamed(n.type, 'LiveOwn') ? [n] : NONE),
    },
];
