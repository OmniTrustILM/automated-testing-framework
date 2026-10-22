/**
 * areaFixtures — the shape rule of an area fixture (`fixtures/areas/<name>.ts`), the per-folder setup a spec may take
 * `test` from.
 *
 * WHAT: an area fixture has exactly one shape: one named import of `test` from the spec-facing fixtures (or another area
 * fixture), used once, in `export const test = <base>.extend<…>({ … })`. The object literal only ADDS fixtures: no key is a
 * fixture that already exists (Playwright's own fixtures and options, the fixtures of `fixtures/testFixtures.ts` and
 * `fixtures/regressionFixtures.ts`, the spec-facing context names the spec lint knows, the fixtures of the other area
 * files), every key is a plain name, and the file mentions `extend` nowhere else, calls no `.use(…)`, refers to its own
 * `test` nowhere else, loads no module by `require` / `import()`, and exports no other value than `test` and `expect`
 * (types are fine). A spec takes only `test` / `expect` (and types) from an area fixture (rules.ts, test-import). A
 * fixture of the file destructures its inputs and takes only the allowed ones (AREA_FIXTURE_INPUTS: the guarded contexts
 * and the ledger / needs / settings fixtures, never a page or a Playwright raw source), the file reads no `.request`,
 * `.context`, `.browser` member and no credential member (password, secret, token, kubeconfig …; by access or
 * destructuring) and no computed member, uses no reflection and never says
 * `newContext`: what it builds comes from the guarded fixtures. A page is driven by the spec (`signedIn`) through a
 * page object, not handed out by an area fixture.
 * WHY: the spec lint trusts a guarded fixture by its name (`api`, `localApi`, `own`, `signedIn`, …). An area fixture that
 * redefined one of those names, or Playwright's `request` / `baseURL`, could hand a spec a raw context or another tier
 * under a trusted name, and no spec-side rule would see it. A second extend reached any other way (`.call`, `Reflect`,
 * an alias, a destructured `extend`) would escape the key check, so the rule pins the one shape instead of chasing forms.
 * A new name gets no trust in a spec's own calls, but a spec may pass it on to a helper, so no raw context may be built
 * in an area fixture at all. With the
 * export rule, whatever else an area file builds cannot leave it. This is a guard against mistakes and shortcuts in
 * test code, not a sandbox against a hostile author: every change is still read by a person before it is merged.
 * HOW: TypeScript AST (the compiler is loaded lazily, as in parseSpec). The file name must be root-relative (the lint
 * resolves relative imports from it). The rest of an area file (imports, raw contexts, mutations) is linted with the spec
 * rules by tests/unit/specGuards.spec.ts.
 */
import * as path from 'path';
import type * as TS from 'typescript';
import { typescript } from './parseSpec';

export type AreaFixtureRule =
    | 'base-import' | 'base-use' | 'extend-shape' | 'extend-mention' | 'reserved-name' | 'dynamic-key' | 'fixture-use' | 'test-reference'
    | 'module-load' | 'area-export' | 'raw-source' | 'secret-read';

export interface AreaFixtureProblem {
    rule: AreaFixtureRule;
    line: number;
    text: string;
}

/**
 * Playwright's built-in fixtures and options (the members of PlaywrightTestArgs / PlaywrightWorkerArgs /
 * PlaywrightTestOptions / PlaywrightWorkerOptions); tests/unit/areaFixtureLint.spec.ts keeps it equal to the installed
 * Playwright's types, and specGuards adds the installed names too.
 */
export const PLAYWRIGHT_FIXTURES: ReadonlySet<string> = new Set([
    'page', 'context', 'browser', 'browserName', 'request', 'playwright', 'baseURL', 'headless', 'channel', 'launchOptions',
    'connectOptions', 'screenshot', 'trace', 'video', 'viewport', 'storageState', 'extraHTTPHeaders', 'httpCredentials',
    'ignoreHTTPSErrors', 'offline', 'proxy', 'contextOptions', 'navigationTimeout', 'actionTimeout', 'testIdAttribute',
    'colorScheme', 'deviceScaleFactor', 'geolocation', 'hasTouch', 'isMobile', 'javaScriptEnabled', 'locale', 'permissions',
    'timezoneId', 'userAgent', 'acceptDownloads', 'bypassCSP', 'serviceWorkers', 'clientCertificates', 'defaultBrowserType',
]);

/**
 * The fixtures an area fixture may take as inputs (besides the fixtures it defines itself and those of the area fixture it
 * extends): the guarded contexts and the ledger / needs / settings fixtures. Not a page (`signedIn`, `page`: a page
 * reaches a raw context), not Playwright's raw sources, not the tokens, `env` or `regressionEnv` (whole objects that hold
 * credentials: handed on under a new name they escape the token and secret rules; a spec reads its settings itself).
 */
export const AREA_FIXTURE_INPUTS: ReadonlySet<string> = new Set([
    'api', 'anonymousApi', 'localApi', 'own', 'live', 'needs', 'declaredNeeds', 'ownRaProfile',
]);
/**
 * Member names that read a credential or a cluster key (`regressionEnv.userPassword`, `.restrictedPassword`, `.kubeconfig`,
 * `.cmAuthSecret`, an access / admin / bearer token, a private key): an area fixture reads none of them. A plain `token` is
 * the platform's cryptographic token object (a key store), not a credential, and stays readable; by access or destructuring, so no secret reaches a spec
 * under a name the spec lint's token and secret rules do not know. (`env`, the raw TestEnv with the admin login, is no input.)
 */
const SECRET_MEMBER = /password|passwd|secret|kubeconfig|credential|username|privateKey|apiKey|bearer|(access|refresh|id|auth|admin|restricted)Token/i;
/** Globals that read or wrap an object's members around the member rules. */
const REFLECTION = new Set(['Reflect', 'Proxy', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getPrototypeOf', '__proto__', 'defineProperty']);
/** Members that reach a raw context, or the cookies / headers of a guarded one: no area fixture reads them, on any receiver. */
const RAW_MEMBERS = new Set(['request', 'context', 'browser', 'newContext', 'storageState', 'headers', 'allHeaders', 'headersArray', 'headerValue', 'headerValues']);
/** The modules an area fixture may take its base `test` from (root-relative, without extension). */
const BASE_MODULE = /^fixtures\/(testFixtures|regressionFixtures|areas\/[a-z][A-Za-z0-9]*)$/;
/** The Playwright interfaces whose members are fixtures or options. */
const PLAYWRIGHT_FIXTURE_TYPES = new Set(['PlaywrightTestArgs', 'PlaywrightWorkerArgs', 'PlaywrightTestOptions', 'PlaywrightWorkerOptions']);

const parse = (ts: typeof TS, src: string, fileName: string): TS.SourceFile =>
    ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function walk(ts: typeof TS, root: TS.Node, visit: (n: TS.Node) => void): void {
    const go = (n: TS.Node): void => {
        visit(n);
        ts.forEachChild(n, go);
    };
    go(root);
}

/** The plain key names of an object literal, and the properties that have no plain name (spread, computed). */
function keysOf(ts: typeof TS, o: TS.ObjectLiteralExpression): { names: Array<{ name: string; node: TS.Node }>; dynamic: TS.Node[] } {
    const names: Array<{ name: string; node: TS.Node }> = [];
    const dynamic: TS.Node[] = [];
    for (const p of o.properties) {
        const n = ts.isSpreadAssignment(p) ? undefined : p.name;
        if (n && (ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isNumericLiteral(n))) names.push({ name: n.text, node: p });
        else dynamic.push(p);
    }
    return { names, dynamic };
}

/** The member names of Playwright's fixture / option interfaces in its type definitions (`playwright/types/test.d.ts`). */
export function playwrightFixtureNamesOf(dts: string): string[] {
    const ts = typescript();
    const sf = parse(ts, dts, 'test.d.ts');
    const out: string[] = [];
    ts.forEachChild(sf, (n) => {
        if (!ts.isInterfaceDeclaration(n) || !PLAYWRIGHT_FIXTURE_TYPES.has(n.name.text)) return;
        for (const m of n.members) if (m.name && ts.isIdentifier(m.name)) out.push(m.name.text);
    });
    return out;
}

/** The fixture names a fixtures file defines: the plain keys of the object literal of every `.extend({…})` call in it. */
export function fixtureNamesOf(src: string, fileName: string): string[] {
    const ts = typescript();
    const sf = parse(ts, src, fileName);
    const out: string[] = [];
    walk(ts, sf, (n) => {
        if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'extend') return;
        const arg = n.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) out.push(...keysOf(ts, arg).names.map((k) => k.name));
    });
    return out;
}

type FixtureFunction = TS.ArrowFunction | TS.FunctionExpression | TS.MethodDeclaration;

/** The binding pattern is the first parameter of a function (a fixture's inputs: checked against the allow-list). */
const isFixtureInputs = (ts: typeof TS, pattern: TS.ObjectBindingPattern): boolean =>
    ts.isParameter(pattern.parent) && (ts.isArrowFunction(pattern.parent.parent) || ts.isFunctionExpression(pattern.parent.parent) || ts.isMethodDeclaration(pattern.parent.parent))
    && pattern.parent.parent.parameters[0] === pattern.parent;

/** The fixture function(s) of one property of the extend literal: `name: fn`, `name: [fn, options]`, `name(…) {…}`. */
function fixtureFunctions(ts: typeof TS, p: TS.ObjectLiteralElementLike): FixtureFunction[] {
    const isFn = (e: TS.Node): e is FixtureFunction => ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isMethodDeclaration(e);
    if (ts.isMethodDeclaration(p)) return [p];
    if (!ts.isPropertyAssignment(p)) return [];
    const v = p.initializer;
    if (isFn(v)) return [v];
    if (ts.isArrayLiteralExpression(v) && v.elements[0] && isFn(v.elements[0])) return [v.elements[0]];
    return [];
}

/** A fixture function that takes an input outside the allow-list, or does not destructure its inputs (then any could be read). */
function rawSourceProblems(ts: typeof TS, f: FixtureFunction, inputs: ReadonlySet<string>, at: (rule: AreaFixtureRule, node: TS.Node) => AreaFixtureProblem): AreaFixtureProblem[] {
    const first = f.parameters[0];
    if (!first) return [];
    if (!ts.isObjectBindingPattern(first.name)) return [at('raw-source', first)];
    const out: AreaFixtureProblem[] = [];
    for (const el of first.name.elements) {
        const key = el.propertyName ?? el.name;
        if (el.dotDotDotToken || !(ts.isIdentifier(key) || ts.isStringLiteralLike(key)) || !inputs.has(key.text)) out.push(at('raw-source', el));
    }
    return out;
}

/** `export const test = <init>` as the one declaration of an exported `const` statement: the initializer, else undefined. */
function exportedTestInit(ts: typeof TS, s: TS.Statement): { decl: TS.VariableDeclaration; init: TS.Expression } | undefined {
    if (!ts.isVariableStatement(s) || !s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return undefined;
    if (!(s.declarationList.flags & ts.NodeFlags.Const) || s.declarationList.declarations.length !== 1) return undefined;
    const decl = s.declarationList.declarations[0];
    return ts.isIdentifier(decl.name) && decl.name.text === 'test' && decl.initializer ? { decl, init: decl.initializer } : undefined;
}

/** The shape problems of one area fixture file; `reserved` holds every fixture name it may not redefine. */
export function areaFixtureProblems(src: string, fileName: string, reserved: ReadonlySet<string>, inherited: ReadonlySet<string> = new Set()): AreaFixtureProblem[] {
    const ts = typescript();
    const sf = parse(ts, src, fileName);
    const at = (rule: AreaFixtureRule, node: TS.Node): AreaFixtureProblem =>
        ({ rule, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.getText(sf).split('\n')[0].slice(0, 120) });
    const problems: AreaFixtureProblem[] = [];
    const resolve = (spec: string): string =>
        spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(fileName.replace(/\\/g, '/')), spec)) : spec;

    // 1. One named value import of `test` from a base module; no other binding of a base module.
    const baseNames: Array<{ local: TS.Identifier }> = [];
    for (const s of sf.statements) {
        if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !BASE_MODULE.test(resolve(s.moduleSpecifier.text))) continue;
        const clause = s.importClause;
        if (!clause || clause.isTypeOnly) continue;
        if (clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) problems.push(at('base-import', s));
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
                if (!el.isTypeOnly && (el.propertyName ?? el.name).text === 'test') baseNames.push({ local: el.name });
            }
        }
    }
    if (baseNames.length !== 1) {
        problems.push(baseNames.length === 0
            ? { rule: 'base-import', line: 1, text: 'no `test` imported from the spec-facing fixtures or an area fixture' }
            : at('base-import', baseNames[1].local));
    }
    const base = baseNames[0]?.local;

    // 2. Exactly `export const test = <base>.extend<…>({ … })`.
    const exported = sf.statements.map((s) => exportedTestInit(ts, s)).filter((x): x is NonNullable<typeof x> => !!x);
    let sanctioned: TS.CallExpression | undefined;
    if (exported.length !== 1) {
        problems.push({ rule: 'extend-shape', line: 1, text: 'one `export const test = base.extend<…>({ … })` statement' });
    } else {
        const { init } = exported[0];
        const ok = ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'extend'
            && ts.isIdentifier(init.expression.expression) && !!base && init.expression.expression.text === base.text
            && init.arguments.length === 1 && ts.isObjectLiteralExpression(init.arguments[0]);
        if (!ok) problems.push(at('extend-shape', init));
        else sanctioned = init as TS.CallExpression;
    }
    if (sanctioned) {
        const literal = sanctioned.arguments[0] as TS.ObjectLiteralExpression;
        const { names, dynamic } = keysOf(ts, literal);
        for (const d of dynamic) problems.push(at('dynamic-key', d));
        for (const k of names) if (reserved.has(k.name)) problems.push(at('reserved-name', k.node));
        const inputs = new Set([...AREA_FIXTURE_INPUTS, ...inherited, ...names.map((k) => k.name)]);
        for (const p of literal.properties) {
            const fns = fixtureFunctions(ts, p);
            // a fixture is written inline (`name: fn`, `name: [fn, options]`, `name(…) {…}`), so its inputs can be read here
            if (fns.length === 0 && !ts.isSpreadAssignment(p)) problems.push(at('extend-shape', p));
            for (const f of fns) problems.push(...rawSourceProblems(ts, f, inputs, at));
        }
    }

    // 3. Exports: the one `export const test`, `expect` (re-exported or local), types; nothing else leaves the file.
    for (const s of sf.statements) {
        const exportedMod = (ts.canHaveModifiers(s) ? ts.getModifiers(s) : undefined)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (ts.isExportDeclaration(s)) {
            if (s.isTypeOnly) continue;
            const ok = !!s.exportClause && ts.isNamedExports(s.exportClause)
                && s.exportClause.elements.every((el) => el.isTypeOnly || el.name.text === 'expect');
            if (!ok) problems.push(at('area-export', s));
        } else if (ts.isExportAssignment(s)) {
            problems.push(at('area-export', s));
        } else if (exportedMod && !ts.isInterfaceDeclaration(s) && !ts.isTypeAliasDeclaration(s) && !exportedTestInit(ts, s)) {
            problems.push(at('area-export', s));
        }
        if (ts.isImportEqualsDeclaration(s) && ts.isExternalModuleReference(s.moduleReference)) problems.push(at('module-load', s));
    }

    // 4. Every other mention: `extend` (any form), the base binding, the file's own `test`, `.use(…)`, `require` / `import()`.
    const sanctionedName = sanctioned && (sanctioned.expression as TS.PropertyAccessExpression).name;
    const sanctionedReceiver = sanctioned && (sanctioned.expression as TS.PropertyAccessExpression).expression;
    const ownTest = exported[0]?.decl.name;
    walk(ts, sf, (n) => {
        if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === 'extend' && n !== sanctionedName) {
            problems.push(at('extend-mention', n));
        }
        if ((ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === 'newContext') problems.push(at('raw-source', n));
        // reflection reads members around the member rules
        if ((ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && REFLECTION.has(n.text)) problems.push(at('raw-source', n));
        // a destructured raw member (`const { request } = x`), anywhere but the fixture inputs checked above
        if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
            const key = n.propertyName ?? n.name;
            if (!(ts.isIdentifier(key) || ts.isStringLiteralLike(key)) || RAW_MEMBERS.has(key.text)) problems.push(at('raw-source', n));
        }
        // a credential read from the settings or any object, by access or destructuring
        if (ts.isPropertyAccessExpression(n) && SECRET_MEMBER.test(n.name.text)) problems.push(at('secret-read', n));
        if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
            const key = n.propertyName ?? n.name;
            if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && SECRET_MEMBER.test(key.text) && !isFixtureInputs(ts, n.parent)) problems.push(at('secret-read', n));
        }
        // a raw context reached through an object (`x.request`, `x.context().request`, `.browser()`)
        if ((ts.isPropertyAccessExpression(n) && RAW_MEMBERS.has(n.name.text))
            || (ts.isElementAccessExpression(n) && (!ts.isStringLiteralLike(n.argumentExpression) || RAW_MEMBERS.has(n.argumentExpression.text)))) {
            problems.push(at('raw-source', n));
        }
        if (ts.isIdentifier(n) && base && n.text === base.text && n !== base && n !== sanctionedReceiver
            && !(ts.isImportSpecifier(n.parent) && n.parent.propertyName === n)) {
            problems.push(at('base-use', n));
        }
        if (ts.isIdentifier(n) && n.text === 'test' && n !== ownTest && !(ts.isImportSpecifier(n.parent))
            && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
            problems.push(at('test-reference', n));
        }
        if (ts.isCallExpression(n)) {
            const c = n.expression;
            if (c.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(c) && c.text === 'require')) problems.push(at('module-load', n));
            if ((ts.isPropertyAccessExpression(c) && c.name.text === 'use')
                || (ts.isElementAccessExpression(c) && (!ts.isStringLiteralLike(c.argumentExpression) || c.argumentExpression.text === 'use'))) {
                problems.push(at('fixture-use', n));
            }
        }
    });
    return problems.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}
