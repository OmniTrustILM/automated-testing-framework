/**
 * specLint/bindings — what the deny-by-default lint knows about the names of one source file (guarded contexts, token / request / page
 * fixtures, fs and `process` bindings), resolved by symbol.
 */
import type * as TS from 'typescript';
import * as path from 'path';
import { isAllowedRawPostUrl } from '../guard/rawPost';

export interface LintContext {
    ts: typeof TS;
    sf: TS.SourceFile;
    fileName: string;
    isSpec: boolean;
}

export const GUARD_FACTORIES = new Set(['guardApi', 'getGuardedApiContext', 'assertGuarded', 'guardApiWithSeams']);
const TEST_CALLS = new Set(['only', 'skip', 'fixme', 'fail', 'beforeAll', 'afterAll', 'beforeEach', 'afterEach']);
const COLLECTION_CTORS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'URLSearchParams', 'Headers', 'FormData']);
const SAMPLE_UUID = '00000000-0000-4000-8000-000000000000';
const FS_MODULES = new Set(['fs', 'fs/promises']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self']);
/** The guarded context fixtures (`anonymousApi`: credential-less; `localApi`: `@local` rows; `workerApi`: worker-scoped). */
const GUARDED_FIXTURES = new Set(['api', 'anonymousApi', 'localApi', 'workerApi']);
const PAGE_FIXTURES = new Set(['page', 'signedIn']);
const TOKEN_FIXTURES = new Set(['adminToken', 'restrictedToken']);
const READ_METHODS = new Set(['GET', 'HEAD']);

export const builtinName = (spec: string): string => spec.replace(/^node:/, '');
export const isFsModule = (spec: string | undefined): boolean => !!spec && FS_MODULES.has(builtinName(spec));

export function boundSource(ts: typeof TS, fileName: string, src: string): { sf: TS.SourceFile; checker: TS.TypeChecker } {
    const virtual = `/lint/${fileName.replace(/[\\/]/g, '__')}`;
    const sf = ts.createSourceFile(virtual, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const host: TS.CompilerHost = {
        getSourceFile: (f) => (f === virtual ? sf : undefined),
        getDefaultLibFileName: () => '/lint/lib.d.ts',
        writeFile: () => undefined,
        getCurrentDirectory: () => '/lint',
        getCanonicalFileName: (f) => f,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        fileExists: (f) => f === virtual,
        readFile: () => undefined,
    };
    const program = ts.createProgram({ rootNames: [virtual], options: { noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.Latest }, host });
    return { sf: program.getSourceFile(virtual) ?? sf, checker: program.getTypeChecker() };
}

export class Bindings {
    private readonly ts: typeof TS;
    private readonly guarded = new Set<TS.Symbol>();
    private readonly tokens = new Set<TS.Symbol>();
    private readonly requestFixture = new Set<TS.Symbol>();
    private readonly pageFixture = new Set<TS.Symbol>();
    private readonly collections = new Set<TS.Symbol>();
    private readonly apiJsonFns = new Set<TS.Symbol>();
    private readonly fsBindings = new Set<TS.Symbol>();
    private readonly envAliases = new Set<TS.Symbol>();
    private readonly processAliases = new Set<TS.Symbol>();
    private readonly suiteHelpers = new Set<TS.Symbol>();
    private readonly declarations: TS.VariableDeclaration[] = [];
    private readonly destructurings: TS.VariableDeclaration[] = [];

    constructor(private readonly ctx: LintContext, private readonly checker: TS.TypeChecker) {
        this.ts = ctx.ts;
        this.collect(ctx.sf);
        this.resolveAliases();
    }


    sym(n: TS.Node): TS.Symbol | undefined {
        try {
            return this.checker.getSymbolAtLocation(n);
        } catch {
            return undefined;
        }
    }

    shorthandValueSymbol(n: TS.ShorthandPropertyAssignment): TS.Symbol | undefined {
        return this.checker.getShorthandAssignmentValueSymbol(n);
    }

    unwrap(e: TS.Expression): TS.Expression {
        const ts = this.ts;
        return ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) ? this.unwrap(e.expression) : e;
    }

    literal(e: TS.Node | undefined): string | undefined {
        const ts = this.ts;
        return e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined;
    }

    typeNamed(t: TS.TypeNode | undefined, name: string): boolean {
        return !!t && this.ts.isTypeReferenceNode(t) && t.typeName.getText(this.ctx.sf) === name;
    }

    resolveModule(spec: string): string {
        return spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(this.ctx.fileName.replace(/\\/g, '/')), spec)) : spec;
    }


    isGuarded(e: TS.Expression | undefined): boolean {
        if (!e) return false;
        const ts = this.ts;
        const x = this.unwrap(e);
        if (ts.isIdentifier(x)) {
            const s = this.sym(x);
            return !!s && this.guarded.has(s);
        }
        return ts.isCallExpression(x) && ts.isIdentifier(x.expression) && GUARD_FACTORIES.has(x.expression.text);
    }

    isGuardedSymbol(s: TS.Symbol | undefined): boolean {
        return !!s && this.guarded.has(s);
    }

    isCollection(e: TS.Expression): boolean {
        const x = this.unwrap(e);
        const target = this.ts.isPropertyAccessExpression(x) ? x.name : x;
        const s = this.sym(target);
        return !!s && this.collections.has(s);
    }

    /** A page: the `page` / `signedIn` fixture, an alias of one, or `<x>.page` / a `page` destructured from any object. */
    isPageRef(e: TS.Expression): boolean {
        const ts = this.ts;
        const x = this.unwrap(e);
        if (ts.isPropertyAccessExpression(x)) return x.name.text === 'page';
        if (ts.isElementAccessExpression(x)) return this.literal(x.argumentExpression) === 'page';
        if (!ts.isIdentifier(x)) return false;
        const s = this.sym(x);
        return (!!s && this.pageFixture.has(s)) || x.text === 'page';
    }

    isPageRequest(e: TS.Expression): boolean {
        const ts = this.ts;
        const x = this.unwrap(e);
        const member = ts.isPropertyAccessExpression(x) ? x.name.text : ts.isElementAccessExpression(x) ? this.literal(x.argumentExpression) : undefined;
        return member === 'request' && this.isPageRef((x as TS.PropertyAccessExpression | TS.ElementAccessExpression).expression);
    }

    isRequestFixture(e: TS.Expression): boolean {
        const x = this.unwrap(e);
        if (this.ts.isIdentifier(x)) return this.isRequestFixtureName(x);
        return this.isPageRequest(x);
    }

    isRequestFixtureSymbol(s: TS.Symbol | undefined): boolean {
        return !!s && this.requestFixture.has(s);
    }

    isRequestFixtureName(n: TS.Identifier): boolean {
        return this.requestFixture.size > 0 && this.isRequestFixtureSymbol(this.sym(n));
    }

    isTokenRef(e: TS.Node): boolean {
        const ts = this.ts;
        if (!ts.isIdentifier(e)) return false;
        const s = ts.isShorthandPropertyAssignment(e.parent) && e.parent.name === e ? this.shorthandValueSymbol(e.parent) : this.sym(e);
        return !!s && this.tokens.has(s);
    }

    isSuiteHelper(e: TS.Expression): boolean {
        const s = this.sym(e);
        return !!s && this.suiteHelpers.has(s);
    }

    isApiJsonCallee(c: TS.Expression): boolean {
        const ts = this.ts;
        if (ts.isIdentifier(c)) {
            const s = this.sym(c);
            return (!!s && this.apiJsonFns.has(s)) || (!s && /^apiJson/.test(c.text));
        }
        return ts.isPropertyAccessExpression(c) && /^apiJson/.test(c.name.text);
    }

    urlAllowed(e: TS.Expression | undefined): boolean {
        if (!e) return false;
        const ts = this.ts;
        const x = this.unwrap(e);
        if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'allowedRawPost') return true;
        let text = this.literal(x);
        if (text === undefined && ts.isTemplateExpression(x)) {
            text = x.head.text;
            for (const span of x.templateSpans) {
                const after = span.literal.text;
                if (!text.endsWith('/') || !(after === '' || after.startsWith('/'))) return false;
                text += SAMPLE_UUID + after;
            }
        }
        // Judged like allowedRawPost at runtime; relative URLs only.
        return text !== undefined && isAllowedRawPostUrl(text);
    }

    methodOf(e: TS.Expression | undefined): string | undefined {
        if (!e) return 'GET';
        const ts = this.ts;
        const x = this.unwrap(e);
        if (!ts.isObjectLiteralExpression(x)) return undefined;
        let spread = false;
        for (const p of x.properties) {
            if (ts.isSpreadAssignment(p)) spread = true;
            const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
            if (name !== 'method') continue;
            if (ts.isPropertyAssignment(p)) return this.literal(p.initializer)?.toUpperCase();
            return undefined;
        }
        return spread ? undefined : 'GET';
    }

    isReadMethod(verb: string | undefined): boolean {
        return !!verb && READ_METHODS.has(verb);
    }

    requireOf(e: TS.Expression | undefined): string | undefined {
        const ts = this.ts;
        const x = e && this.unwrap(e);
        return x && ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'require' ? this.literal(x.arguments[0]) : undefined;
    }

    isProcessRef(e: TS.Expression): boolean {
        const ts = this.ts;
        const x = this.unwrap(e);
        if (ts.isIdentifier(x)) {
            if (x.text === 'process') return true;
            const s = this.sym(x);
            return !!s && this.processAliases.has(s);
        }
        const member = ts.isPropertyAccessExpression(x) ? x.name.text : ts.isElementAccessExpression(x) ? this.literal(x.argumentExpression) : undefined;
        if (member !== 'process') return false;
        const holder = this.unwrap((x as TS.PropertyAccessExpression | TS.ElementAccessExpression).expression);
        return ts.isIdentifier(holder) && GLOBAL_OBJECTS.has(holder.text);
    }

    isProcessEnv(e: TS.Expression): boolean {
        const ts = this.ts;
        const x = this.unwrap(e);
        if (ts.isPropertyAccessExpression(x) && x.name.text === 'env' && this.isProcessRef(x.expression)) return true;
        if (ts.isElementAccessExpression(x) && this.literal(x.argumentExpression) === 'env' && this.isProcessRef(x.expression)) return true;
        if (ts.isIdentifier(x)) {
            const s = this.sym(x);
            return !!s && this.envAliases.has(s);
        }
        return false;
    }

    isEnvTarget(e: TS.Expression): boolean {
        const ts = this.ts;
        const x = this.unwrap(e);
        if ((ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) && this.isProcessEnv(x.expression)) return true;
        return !ts.isIdentifier(x) && this.isProcessEnv(x);
    }

    isFsBinding(e: TS.Expression): boolean {
        const ts = this.ts;
        const x = this.unwrap(e);
        if (ts.isIdentifier(x)) {
            const s = this.sym(x);
            return !!s && this.fsBindings.has(s);
        }
        if (ts.isPropertyAccessExpression(x) && x.name.text === 'promises') return this.isFsBinding(x.expression);
        return isFsModule(this.requireOf(x));
    }


    private collect(n: TS.Node): void {
        this.collectTestFixtures(n);
        this.collectGuardedParameter(n);
        this.collectCollection(n);
        if (this.ts.isVariableDeclaration(n) && this.ts.isIdentifier(n.name) && n.initializer) this.declarations.push(n);
        this.collectFsImport(n);
        this.collectProcessAliases(n);
        this.collectEnvDestructuring(n);
        if (this.ts.isVariableDeclaration(n) && this.ts.isObjectBindingPattern(n.name) && n.initializer) this.destructurings.push(n);
        this.collectSuiteHelper(n);
        this.collectApiJson(n);
        this.ts.forEachChild(n, (c) => this.collect(c));
    }

    private isTestCall(call: TS.CallExpression): boolean {
        const ts = this.ts;
        const c = call.expression;
        if (ts.isIdentifier(c)) return c.text === 'test';
        return ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'test' && TEST_CALLS.has(c.name.text);
    }

    private collectTestFixtures(n: TS.Node): void {
        const ts = this.ts;
        if (!(ts.isCallExpression(n) && this.isTestCall(n))) return;
        for (const arg of n.arguments) {
            if (!(ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) continue;
            const first = arg.parameters[0];
            if (!first || !ts.isObjectBindingPattern(first.name)) continue;
            for (const el of first.name.elements) {
                const key = (el.propertyName ?? el.name).getText(this.ctx.sf);
                const s = this.sym(el.name);
                if (!s) continue;
                if (GUARDED_FIXTURES.has(key)) this.guarded.add(s);
                if (TOKEN_FIXTURES.has(key)) this.tokens.add(s);
                if (key === 'request') this.requestFixture.add(s);
                if (PAGE_FIXTURES.has(key)) this.pageFixture.add(s);
            }
        }
    }

    private collectGuardedParameter(n: TS.Node): void {
        if (!(this.ts.isParameter(n) && this.ts.isIdentifier(n.name) && this.typeNamed(n.type, 'GuardedApi'))) return;
        const s = this.sym(n.name);
        if (s) this.guarded.add(s);
    }

    private collectCollection(n: TS.Node): void {
        const ts = this.ts;
        if (!((ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) && n.initializer)) return;
        const init = this.unwrap(n.initializer);
        if (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && COLLECTION_CTORS.has(init.expression.text)) {
            const s = this.sym(n.name);
            if (s) this.collections.add(s);
        }
    }

    private collectFsImport(n: TS.Node): void {
        const ts = this.ts;
        const add = (name: TS.Node): void => {
            const s = this.sym(name);
            if (s) this.fsBindings.add(s);
        };
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && isFsModule(n.moduleSpecifier.text) && n.importClause) {
            const c = n.importClause;
            if (c.name) add(c.name);
            if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) add(c.namedBindings.name);
            if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
                for (const el of c.namedBindings.elements) if ((el.propertyName ?? el.name).text === 'promises') add(el.name);
            }
        }
        if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && isFsModule(this.literal(n.moduleReference.expression))) add(n.name);
    }

    private collectProcessAliases(n: TS.Node): void {
        const ts = this.ts;
        if (!(ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer)) return;
        const s = this.sym(n.name);
        if (s && isFsModule(this.requireOf(n.initializer))) this.fsBindings.add(s);
        const init = this.unwrap(n.initializer);
        if (s && ts.isPropertyAccessExpression(init) && init.name.text === 'env' && this.isProcessRef(init.expression)) this.envAliases.add(s);
        if (s && !ts.isIdentifier(init) && this.isProcessRef(init)) this.processAliases.add(s);
    }

    private collectEnvDestructuring(n: TS.Node): void {
        const ts = this.ts;
        if (!(ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer)) return;
        const init = this.unwrap(n.initializer);
        for (const el of n.name.elements) {
            const key = (el.propertyName ?? el.name).getText(this.ctx.sf);
            const s = ts.isIdentifier(el.name) ? this.sym(el.name) : undefined;
            if (s && key === 'env' && this.isProcessRef(init)) this.envAliases.add(s);
        }
    }

    private collectSuiteHelper(n: TS.Node): void {
        const ts = this.ts;
        if (!((ts.isImportSpecifier(n) || ts.isNamespaceImport(n) || ts.isImportClause(n)) && n.name)) return;
        const decl = ts.isImportSpecifier(n) ? n.parent.parent.parent : ts.isNamespaceImport(n) ? n.parent.parent : n.parent;
        if (ts.isImportDeclaration(decl) && ts.isStringLiteral(decl.moduleSpecifier) && decl.moduleSpecifier.text.startsWith('.')) {
            const s = this.sym(n.name);
            if (s) this.suiteHelpers.add(s);
        }
    }

    private collectApiJson(n: TS.Node): void {
        const ts = this.ts;
        if (ts.isImportSpecifier(n) && /^apiJson/.test((n.propertyName ?? n.name).text)) {
            const s = this.sym(n.name);
            if (s) this.apiJsonFns.add(s);
        }
        if (ts.isFunctionDeclaration(n) && n.name && /^apiJson/.test(n.name.text)) {
            const s = this.sym(n.name);
            if (s) this.apiJsonFns.add(s);
        }
    }

    private resolveAliases(): void {
        for (let changed = true; changed; ) {
            changed = false;
            for (const d of this.declarations) {
                const s = this.sym(d.name);
                if (s && this.addAliases(d, s)) changed = true;
            }
            for (const d of this.destructurings) if (this.addDestructured(d)) changed = true;
        }
    }

    private addAliases(d: TS.VariableDeclaration, s: TS.Symbol): boolean {
        const init = d.initializer!;
        let changed = false;
        const add = (set: Set<TS.Symbol>, when: boolean): void => {
            if (!set.has(s) && when) {
                set.add(s);
                changed = true;
            }
        };
        add(this.guarded, this.isGuarded(init));
        add(this.fsBindings, this.isFsBinding(init));
        add(this.envAliases, this.isProcessEnv(init));
        add(this.processAliases, this.isProcessRef(init));
        add(this.pageFixture, this.isPageRef(init));
        const unwrapped = this.unwrap(init);
        const from = this.ts.isIdentifier(unwrapped) ? this.sym(unwrapped) : undefined;
        add(this.apiJsonFns, !!from && this.apiJsonFns.has(from));
        return changed;
    }

    private addDestructured(d: TS.VariableDeclaration): boolean {
        const ts = this.ts;
        const init = d.initializer!;
        let changed = false;
        for (const el of (d.name as TS.ObjectBindingPattern).elements) {
            if (el.dotDotDotToken || !ts.isIdentifier(el.name)) continue;
            const keyNode = el.propertyName ?? el.name;
            const key = ts.isIdentifier(keyNode) ? keyNode.text : ts.isStringLiteralLike(keyNode) ? keyNode.text : undefined;
            const s = this.sym(el.name);
            if (!s) continue;
            const target = key === 'page' ? this.pageFixture : key === 'request' && this.isPageRef(init) ? this.requestFixture : undefined;
            if (target && !target.has(s)) {
                target.add(s);
                changed = true;
            }
        }
        return changed;
    }
}
