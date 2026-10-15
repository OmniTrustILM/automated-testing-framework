/**
 * tags — the one place where the regression and API tags are spelled.
 *
 * A spec header is one call: `test('API-GEN-33: …', meta({ id: 'API-GEN-33', prio: 'P1', issue: 'ilm#428' }), …)`.
 * The suite tag (`@regression` / `@api`) goes on the describe, by folder. Rules the builders enforce:
 * - every test carries `@issue:ilm#448` (the registered QA task) plus the #424 sub-issue of its area;
 * - every test carries one priority tag `@p1` / `@p2` / `@p3` (the nightly selects `@p1`, the `api-rest` project
 *   `@p2|@p3`); a characterisation pin (`@pin:<question>`) is never P1;
 * - `@gate` is API-GEN-32 only;
 * - `@local` also needs `describeLocal(test)` in the spec, `@needs:<x>` a `requireTool` / preflight in `beforeAll`;
 * - `@bug:<repo>#<n>` only on a test that calls `test.fail()` (the rule is asserted, and the test turns red once the
 *   bug is fixed). `bugTagsWithoutFail()` finds violations in a spec's source; specGuards runs it over every spec.
 */

export type Prio = 'P1' | 'P2' | 'P3';

/** The QA task every ilm#424 regression row is registered under. */
export const REGISTERED_ISSUE = 'ilm#448';

const ISSUE_REF = /^[a-z][a-z0-9-]*#\d+$/;
const TEST_ID = /^(REG|API)-[A-Z]+-\d{2}(\.[0-9a-z]+)?$/;

function checkRef(kind: string, ref: string): string {
    if (!ISSUE_REF.test(ref)) throw new Error(`tags.${kind}: "${ref}" is not <repo>#<number> (e.g. core#2502)`);
    return ref;
}

export const tags = {
    regression: '@regression',
    api: '@api',
    gate: '@gate',
    phaseB: '@phaseB',
    local: '@local',
    /** A row that takes minutes by design (a discovery over a real target, a long poll): registered in the merge rehearsal (S10). */
    slow: '@slow',
    issue: (ref: string): string => `@issue:${checkRef('issue', ref)}`,
    prio: (prio: Prio): string => {
        if (!/^P[123]$/.test(prio)) throw new Error(`tags.prio: "${prio}" is not P1, P2 or P3`);
        return `@p${prio.slice(1)}`;
    },
    pin: (question: string): string => {
        if (!/^[A-Za-z0-9._-]+$/.test(question)) throw new Error(`tags.pin: "${question}" is not a question id`);
        return `@pin:${question}`;
    },
    needs: (what: string): string => {
        if (!/^[a-z0-9-]+$/.test(what)) throw new Error(`tags.needs: "${what}" is not a capability name`);
        return `@needs:${what}`;
    },
    bug: (ref: string): string => `@bug:${checkRef('bug', ref)}`,
};

export interface Meta {
    /** Ledger id, e.g. API-GEN-33 or REG-CFG-07.a (the title starts with it). */
    id: string;
    prio: Prio;
    /** The #424 sub-issue(s) of the area, e.g. 'ilm#428'; ilm#448 is always added. */
    issue: string | string[];
    pin?: string;
    /** Known product bug(s): the test must also call test.fail(). */
    bug?: string | string[];
    needs?: string | string[];
    local?: boolean;
    gate?: boolean;
    phaseB?: boolean;
    /** The row takes minutes by design (`@slow`). */
    slow?: boolean;
    /**
     * The business rule(s) the oracle comes from (B1: the ticket / rules-file reference, e.g. `protocols R3c
     * (RaProfileServiceImpl unreserved-name check, core#743)`): one `rule` annotation each, so a report shows why the
     * test expects what it expects (assertions come from the AC of the ticket that built the feature).
     */
    rule?: string | string[];
}

const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Playwright test details `{ tag, annotation }` for one ledger row. */
export function meta(m: Meta): { tag: string[]; annotation: Array<{ type: string; description: string }> } {
    if (!TEST_ID.test(m.id)) throw new Error(`meta: "${m.id}" is not a ledger id (REG-<MOD>-NN[.x] or API-<MOD>-NN[.x])`);
    if (m.pin && m.prio === 'P1') throw new Error(`meta(${m.id}): a characterisation pin is never P1`);
    if (m.gate && m.id !== 'API-GEN-32') throw new Error(`meta(${m.id}): @gate belongs to API-GEN-32 only`);
    const issues = [...new Set([REGISTERED_ISSUE, ...list(m.issue)])];
    if (issues.length < 2) throw new Error(`meta(${m.id}): name the #424 sub-issue of the area next to ${REGISTERED_ISSUE}`);
    const tag = [
        ...issues.map(tags.issue),
        tags.prio(m.prio),
        ...(m.gate ? [tags.gate] : []),
        ...(m.phaseB ? [tags.phaseB] : []),
        ...(m.local ? [tags.local] : []),
        ...(m.slow ? [tags.slow] : []),
        ...(m.pin ? [tags.pin(m.pin)] : []),
        ...list(m.needs).map(tags.needs),
        ...list(m.bug).map(tags.bug),
    ];
    return { tag, annotation: [{ type: 'ledger-id', description: m.id }, ...list(m.rule).map((description) => ({ type: 'rule', description }))] };
}

// ------------------------------------------------------------------ source checks (used by tests/unit)
//
// Test and describe calls are found with the TypeScript compiler API (review R26), not a hand-written bracket scanner:
// strings, template literals, comments and regular expressions can no longer confuse the block boundaries. TypeScript
// 7 (the `typescript` devDependency, used for `tsc --noEmit`) is the native compiler and has no JavaScript compiler API;
// the parser comes from `@typescript/typescript6`, Microsoft's side-by-side package of the TS 6 JavaScript API. It is
// loaded lazily, so specs that import `meta` / `tags` do not load the compiler.

import type * as TS from '@typescript/typescript6';

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
     *  (string literals, `tags.<name>`, `tags.bug(…)`, `meta({ … })`). */
    tags: string[];
    /** 1-based line of the call. */
    line: number;
}

const DECLARATION_FORMS = new Set(['only', 'skip', 'fixme', 'fail']);
const DESCRIBE_MODIFIERS = new Set(['only', 'skip', 'fixme', 'serial', 'parallel']);
const TITLE_TAG = /@[\w:#.-]+/g;

function typescript(): typeof TS {
    return require('@typescript/typescript6') as typeof TS;
}

/** `test`, `test.<form>` or `test.describe[.<modifier>]` of a call expression. */
function calleeKind(ts: typeof TS, call: TS.CallExpression): { kind: TestKind } | { describe: true } | undefined {
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
    if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'test' && target.name.text === 'describe' && DESCRIBE_MODIFIERS.has(name)) {
        return { describe: true };
    }
    return undefined;
}

/** The title argument: a string or template literal (a declaration); anything else (a boolean condition) is a modifier. */
function titleOf(ts: typeof TS, sf: TS.SourceFile, arg: TS.Expression | undefined): string | undefined {
    if (!arg) return undefined;
    if (ts.isStringLiteralLike(arg)) return arg.text;
    if (ts.isTemplateExpression(arg)) return arg.getText(sf).slice(1, -1);
    return undefined;
}

const hasFunctionArg = (ts: typeof TS, call: TS.CallExpression): boolean => call.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));

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
        if (ts.isIdentifier(c) && c.text === 'meta') return metaTags(ts, sf, node.arguments[0]);
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

/** The tags `meta({ … })` adds, read from its literal argument (prio, local, gate, phaseB, bug). */
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
                blocks.push({
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
 * Titles of tests that carry a `@bug` tag (literal, `tags.bug(…)`, `meta({ bug })`, or inherited from a describe) but
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

// ------------------------------------------------------------------ deny-by-default lint (reviews R7b, Q2)

/**
 * Rules of the deny-by-default lint (tests/unit/specGuards.spec.ts runs it over tests/regression, tests/api,
 * utils/regression and utils/api):
 * - raw-context        `getAuthenticatedApiContext` (any reference) or the `request` factory of @playwright/test: specs
 *                      take the guarded `api` fixture (or `getGuardedApiContext`);
 * - raw-request-use    the `request` fixture or `page.request` used for anything but a GET / HEAD (passed on, aliased,
 *                      any other method); as the argument of `getGuardedApiContext` / `guardApi` it is fine;
 * - unit-seam          `guardApiForUnitTests` outside tests/unit;
 * - guarded-cast       `as GuardedApi` / `<GuardedApi>`: a raw context dressed up as a guarded one;
 * - guarded-reassign   a guarded binding assigned something that is not guarded;
 * - context-method     `.post` / `.put` / `.patch` / `.delete` on a receiver that is not provably guarded (a POST with a
 *                      literal read-only / protocol URL, or `allowListedPost(url)`, is fine — a create needs the guard
 *                      since fix pass 3, which checks its body; `.delete` on a Map / Set too);
 * - fetch-method       `.fetch(url, { method })`, `route.fetch({ method })` or the global `fetch` with any method but
 *                      GET / HEAD on a receiver that is not guarded (same POST exception); a method that is not a
 *                      literal counts as mutating;
 * - dynamic-method     `x[expr](…)` on a receiver that is not guarded;
 * - method-extraction  `x.post` / `.put` / `.patch` / `.delete` / `.fetch` taken without calling it (`const d = x.delete`,
 *                      `.bind`, `.call`) on a receiver that is not guarded;
 * - apiJson            `apiJson*` (every variant, any alias) with a context that is not guarded and a method other than
 *                      GET or an allow-listed literal POST;
 * - send-method        the API template's `send(ctx, method, url, …)`, same rule;
 * - raw-xhr            `XMLHttpRequest` / `sendBeacon`;
 * - util-import        from a `utils/*Utils.ts` module: no namespace / default import, no require / dynamic import, and
 *                      named imports only from the allow-list (create*, find*, get*, list*, wait*, generate*, upload*,
 *                      ensure*, minus helpers that change pre-existing objects); type-only imports are fine;
 * - raw-process        `child_process` in a spec (kubectl, docker and friends live behind utils/regression helpers);
 * Spec-only rules (fix pass 3):
 * - test-import        `test` imported from anything but fixtures/testFixtures or utils/api/apiCase (its re-export);
 *                      a namespace / default import or a `require` of @playwright/test;
 * - fixture-extend     any `.extend(` call: a spec cannot redefine the `api` fixture (or anything else);
 * - route-method       `route.continue(…)` / `route.fulfill(…)` with a `method` (or options that are not a literal):
 *                      a browser request turned into another method behind the guard's back;
 * - raw-network        imports (static, require, dynamic) of http, https, http2, net, tls, undici, @kubernetes/client-node
 *                      or utils/k8sClient: requests that bypass every context.
 * Spec-only rules (fix pass 4, deny by default for imports):
 * - spec-import        a module that is not on the spec allow-list: relative imports inside the suite (fixtures/, utils/,
 *                      pages/, tests/; never node_modules), `@playwright/test` for TYPES only (`import type`, or
 *                      capitalised type names; `test` / `expect` come from the fixtures), and the node built-ins
 *                      SPEC_BUILTINS (assert, buffer, crypto, fs, fs/promises, os, path, string_decoder, timers, url, util,
 *                      zlib); a non-literal `require` / `import()`; `createRequire`, `process.mainModule`,
 *                      `process.binding` / `_linkedBinding` / `dlopen` (module loaders past the allow-list);
 * - env-write          `process.env.X = …` (any assignment operator, `++` / `--`), `delete process.env.X`, assigning
 *                      `process.env` itself, `Object.assign` / `Object.defineProperty` / `Reflect.set` /
 *                      `Reflect.defineProperty` / `Reflect.deleteProperty` on `process.env`, and the same through an alias
 *                      (`const e = process.env`, `const { env } = process`): TIER_KIND, BASE_URL or the run id must never
 *                      change under the guard;
 * - fs-write           an fs write: `fs.write*` / `append*` / `rm*` / `unlink*` / `rename*` / `copyFile*` / `cp*` /
 *                      `truncate*` / `symlink*` / `link*` / `ch(mod|own)*` / `utimes*` / `mkdir*` / `mkdtemp*` /
 *                      `open*` / `createWriteStream` on an fs module binding (`fs`, `fs.promises`, `fs/promises`,
 *                      namespace, default, `require`), as a named import, a destructured binding or an element access
 *                      (the ledger, the run state and the local proof are written by helpers only).
 * Spec-only rules (fix pass 5):
 * - `process` also means `globalThis.process` / `global.process` (any spelling, element access included) and a
 *   variable initialised from one: env-write and the loader members see through them; `process.env` handed to a
 *   function as a whole (`set(process.env)`) is an env-write too (Object.keys / values / entries / JSON.stringify read);
 * - dynamic-code         `eval` (direct, indirect `(0, eval)`, `globalThis.eval`), `Function` / `new Function` (any
 *                      reference, `globalThis.Function` included), a `.constructor(…)` call or `new x.constructor(…)`
 *                      (the Function constructor reached through any function), and `setTimeout` / `setInterval` /
 *                      `setImmediate` with a string, template or concatenated first argument: code the lint cannot read;
 * - request-option     an object-literal options argument of `.get` / `.head` / `.post` / `.put` / `.patch` /
 *                      `.delete` / `.fetch` with a key the guard does not forward (`url`, `request`, `encodedParams`,
 *                      `__testHookLookup`, …) or a `method` outside `fetch`; `test.use({ api | request | … })` overriding a
 *                      context fixture is a fixture-extend.
 * Guard-integration pass (GD-01 / GD-02):
 * - `anonymousApi` is a guarded fixture like `api` (CONTEXT_FIXTURES, GUARDED_FIXTURES);
 * - token-use           the opaque token fixtures `adminToken` / `restrictedToken` may not be printed, compared or
 *                      annotated: a template literal, `expect(token…)`, a string concatenation, an object-literal
 *                      property value (`annotations.push({ description: token })`), `String(token)`, `JSON.stringify`,
 *                      `console.*` / `logger.*` / `.push` arguments are violations; `token.bearer()` / `token.claims()`,
 *                      a truthiness check, `test.skip(!token, …)` and a call argument of a helper (`callAs(api, token.bearer(), …)`,
 *                      jwtTools) pass.
 * A receiver is GUARDED when it is the `api` fixture of a test / hook, a parameter typed `GuardedApi`, the result of
 * `guardApi(…)` / `getGuardedApiContext(…)` / `requireGuarded(…)`, or a binding initialised from one of those (aliases
 * followed). Bindings are resolved by symbol (a single-file TypeScript program), so a name guarded in one function is
 * not trusted in another. Everything else is raw: deny by default.
 */
export type RawMutationRule =
    | 'raw-context' | 'raw-request-use' | 'unit-seam' | 'guarded-cast' | 'guarded-reassign' | 'context-method' | 'fetch-method'
    | 'dynamic-method' | 'method-extraction' | 'apiJson' | 'send-method' | 'raw-xhr' | 'util-import' | 'raw-process'
    | 'test-import' | 'fixture-extend' | 'route-method' | 'raw-network' | 'spec-import' | 'env-write' | 'fs-write'
    | 'dynamic-code' | 'request-option' | 'token-use';

export interface RawMutation {
    line: number;
    rule: RawMutationRule;
    text: string;
}

export interface LintOptions {
    /** The file is a spec (tests/…): the fixture rules (`request`, `page.request`, child_process) apply. Default: true. */
    spec?: boolean;
}

const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const EXTRACTED = new Set(['post', 'put', 'patch', 'delete', 'fetch']);
const READ_METHODS = new Set(['GET', 'HEAD']);
const GUARD_FACTORIES = new Set(['guardApi', 'getGuardedApiContext', 'requireGuarded', 'guardApiForUnitTests']);
const TEST_CALLS = new Set(['only', 'skip', 'fixme', 'fail', 'beforeAll', 'afterAll', 'beforeEach', 'afterEach']);
const COLLECTION_CTORS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'URLSearchParams', 'Headers', 'FormData']);
const UTILS_MODULE = /(^|\/)utils\/[A-Za-z]+Utils$/;
/** Named imports a REG / API file may take from utils/*Utils.ts (creates, reads, waits, generators, uploads, ensures). */
const UTIL_IMPORT_ALLOWED = /^(create|find|get|list|wait|generate|upload|ensure)[A-Z0-9_]/;
/** Allowed by prefix but changing pre-existing objects: never importable. */
const UTIL_IMPORT_DENIED = new Set(['ensureConnectorRegistered']);
const SAMPLE_UUID = '00000000-0000-4000-8000-000000000000';
/** Network modules a spec may not import: they bypass every API context (fix pass 3). */
const RAW_NETWORK = new Set(['http', 'https', 'http2', 'net', 'tls', 'undici', '@kubernetes/client-node']);
const isRawNetworkModule = (spec: string, resolved: string): boolean =>
    RAW_NETWORK.has(spec.replace(/^node:/, '')) || /(^|\/)utils\/k8sClient$/.test(resolved);
/** Modules a spec may import `test` from: the fixtures, or the API template's re-export. */
const TEST_SOURCES = /(^|\/)(fixtures\/testFixtures|utils\/api\/apiCase)$/;
/** Node built-ins a spec may import (fix pass 4): no network, no processes, no module loaders, no VM / workers. */
const SPEC_BUILTINS = new Set(['assert', 'buffer', 'crypto', 'fs', 'fs/promises', 'os', 'path', 'string_decoder', 'timers', 'timers/promises', 'url', 'util', 'zlib']);
/** Folders a relative import of a spec may resolve into (never node_modules, never outside the suite). */
const SPEC_RELATIVE_ROOTS = /^(fixtures|utils|pages|tests)\//;
const FS_MODULES = new Set(['fs', 'fs/promises']);
/** fs members that write, remove or open for writing. */
const FS_WRITE = /^(write|append|rm|unlink|rename|copyFile|cp|truncate|ftruncate|symlink|link|chmod|lchmod|fchmod|chown|lchown|fchown|utimes|lutimes|futimes|mkdir|mkdtemp|open|createWriteStream)/;
const ENV_WRITERS: Record<string, Set<string>> = { Object: new Set(['assign', 'defineProperty', 'defineProperties']), Reflect: new Set(['set', 'defineProperty', 'deleteProperty']) };
const LOADER_MEMBERS = new Set(['mainModule', 'binding', '_linkedBinding', 'dlopen']);
/** Globals `process` is reachable through (fix pass 5). */
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self']);
/** Calls that only READ a whole `process.env` handed to them. */
const ENV_READERS: Record<string, Set<string>> = { Object: new Set(['keys', 'values', 'entries', 'getOwnPropertyNames']), JSON: new Set(['stringify']) };
/** Timers that would evaluate a string (Node refuses one, but the lint does not rely on that). */
const STRING_TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate']);
/** Options the guard forwards (guardedApi FORWARDED_OPTIONS), its own switch, and `method` (fetch only). */
const REQUEST_OPTIONS = new Set(['data', 'params', 'headers', 'timeout', 'failOnStatusCode', 'ignoreHTTPSErrors', 'maxRedirects', 'maxRetries', 'identityOverride']);
const REQUEST_CALLS = new Set(['get', 'head', 'post', 'put', 'patch', 'delete', 'fetch']);
/** Fixtures `test.use` must not replace in a spec (a context, the environment, the guard options, the tokens). */
const CONTEXT_FIXTURES = new Set(['api', 'anonymousApi', 'adminToken', 'restrictedToken', 'request', 'env', 'guardOptions', 'page', 'context', 'browser']);
/** The guarded context fixtures (GD-01: `anonymousApi` is the same guard around a credential-less context). */
const GUARDED_FIXTURES = new Set(['api', 'anonymousApi']);
/** The opaque token fixtures (GD-02): never printed, never compared, never annotated (`token-use`). */
const TOKEN_FIXTURES = new Set(['adminToken', 'restrictedToken']);
/** Callees that would print a token's text (a leak into a report, a log or an assertion message). */
const TOKEN_SINKS: Record<string, Set<string>> = { console: new Set(['log', 'info', 'warn', 'error', 'debug', 'trace']), JSON: new Set(['stringify']) };
const TOKEN_SINK_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'push']);
const builtinName = (spec: string): string => spec.replace(/^node:/, '');

/** A single-file program: symbols resolve without libraries or imports (binding identity only). */
function boundSource(ts: typeof TS, fileName: string, src: string): { sf: TS.SourceFile; checker: TS.TypeChecker } {
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

/**
 * Raw mutations and other ways around the guard in one REG / API source (see the rule list above). `fileName` is the
 * path relative to the czertainly-e2e folder (it resolves `../…Utils` imports).
 */
export function rawMutations(src: string, fileName = 'spec.ts', opts: LintOptions = {}): RawMutation[] {
    const ts = typescript();
    const { isAllowListedPostUrl } = require('./guardedApi') as typeof import('./guardedApi');
    const pathMod = require('path') as typeof import('path');
    const isSpec = opts.spec ?? true;
    const { sf, checker } = boundSource(ts, fileName, src);
    const out: RawMutation[] = [];
    const lineOf = (n: TS.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const report = (n: TS.Node, rule: RawMutationRule) => out.push({ line: lineOf(n), rule, text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 120) });
    const sym = (n: TS.Node): TS.Symbol | undefined => {
        try {
            return checker.getSymbolAtLocation(n);
        } catch {
            return undefined;
        }
    };
    const unwrap = (e: TS.Expression): TS.Expression =>
        ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) ? unwrap(e.expression) : e;
    const literal = (e: TS.Node | undefined): string | undefined =>
        e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined;
    const typeNamed = (t: TS.TypeNode | undefined, name: string): boolean => !!t && ts.isTypeReferenceNode(t) && t.typeName.getText(sf) === name;

    const guarded = new Set<TS.Symbol>();
    /** The opaque token fixtures of a test (GD-02, `token-use`). */
    const tokens = new Set<TS.Symbol>();
    const requestFixture = new Set<TS.Symbol>();
    const pageFixture = new Set<TS.Symbol>();
    const collections = new Set<TS.Symbol>();
    const apiJsonFns = new Set<TS.Symbol>();
    const fsBindings = new Set<TS.Symbol>();
    const envAliases = new Set<TS.Symbol>();
    const processAliases = new Set<TS.Symbol>();
    /** Functions imported from the suite's own modules (reviewed helpers: they may read a whole process.env). */
    const suiteHelpers = new Set<TS.Symbol>();

    const isGuarded = (e: TS.Expression | undefined): boolean => {
        if (!e) return false;
        const x = unwrap(e);
        if (ts.isIdentifier(x)) {
            const s = sym(x);
            return !!s && guarded.has(s);
        }
        return ts.isCallExpression(x) && ts.isIdentifier(x.expression) && GUARD_FACTORIES.has(x.expression.text);
    };
    const isCollection = (e: TS.Expression): boolean => {
        const x = unwrap(e);
        const target = ts.isPropertyAccessExpression(x) ? x.name : x;
        const s = sym(target);
        return !!s && collections.has(s);
    };
    const isPageRequest = (e: TS.Expression): boolean => {
        const x = unwrap(e);
        if (!ts.isPropertyAccessExpression(x) || x.name.text !== 'request' || !ts.isIdentifier(x.expression)) return false;
        const s = sym(x.expression);
        return (!!s && pageFixture.has(s)) || x.expression.text === 'page';
    };
    const isRequestFixture = (e: TS.Expression): boolean => {
        const x = unwrap(e);
        if (ts.isIdentifier(x)) {
            const s = sym(x);
            return !!s && requestFixture.has(s);
        }
        return isPageRequest(x);
    };
    /** A literal (or segment-wise template) read-only / protocol POST URL, or a runtime-checked `allowListedPost(url)`. */
    const urlAllowed = (e: TS.Expression | undefined): boolean => {
        if (!e) return false;
        const x = unwrap(e);
        if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'allowListedPost') return true;
        let text = literal(x);
        if (text === undefined && ts.isTemplateExpression(x)) {
            text = x.head.text;
            for (const span of x.templateSpans) {
                const after = span.literal.text;
                // A substitution counts as one uuid only when it fills a whole path segment.
                if (!text.endsWith('/') || !(after === '' || after.startsWith('/'))) return false;
                text += SAMPLE_UUID + after;
            }
        }
        // Judged like allowListedPost judges it at runtime (fix pass 4): printable ASCII, the path as written equal to
        // the effective one, unreserved segments, a segment-strict read-only / protocol pattern; relative URLs only.
        return text !== undefined && isAllowListedPostUrl(text);
    };
    /** The method of a fetch options argument: 'GET' when absent, the literal, or undefined when it is not literal. */
    const methodOf = (e: TS.Expression | undefined): string | undefined => {
        if (!e) return 'GET';
        const x = unwrap(e);
        if (!ts.isObjectLiteralExpression(x)) return undefined;
        let spread = false;
        for (const p of x.properties) {
            if (ts.isSpreadAssignment(p)) spread = true;
            const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
            if (name !== 'method') continue;
            if (ts.isPropertyAssignment(p)) return literal(p.initializer)?.toUpperCase();
            return undefined; // shorthand `{ method }`: dynamic
        }
        return spread ? undefined : 'GET';
    };
    const resolveModule = (spec: string): string => (spec.startsWith('.') ? pathMod.posix.normalize(pathMod.posix.join(pathMod.posix.dirname(fileName.replace(/\\/g, '/')), spec)) : spec);
    const isFsModule = (spec: string | undefined): boolean => !!spec && FS_MODULES.has(builtinName(spec));
    const requireOf = (e: TS.Expression | undefined): string | undefined => {
        const x = e && unwrap(e);
        return x && ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'require' ? literal(x.arguments[0]) : undefined;
    };
    /** `process`, `globalThis.process` / `global.process` (also element access), or a variable initialised from one (fix pass 5). */
    const isProcessRef = (e: TS.Expression): boolean => {
        const x = unwrap(e);
        if (ts.isIdentifier(x)) {
            if (x.text === 'process') return true;
            const s = sym(x);
            return !!s && processAliases.has(s);
        }
        const member = ts.isPropertyAccessExpression(x) ? x.name.text : ts.isElementAccessExpression(x) ? literal(x.argumentExpression) : undefined;
        if (member !== 'process') return false;
        const holder = unwrap((x as TS.PropertyAccessExpression | TS.ElementAccessExpression).expression);
        return ts.isIdentifier(holder) && GLOBAL_OBJECTS.has(holder.text);
    };
    const isProcessEnv = (e: TS.Expression): boolean => {
        const x = unwrap(e);
        if (ts.isPropertyAccessExpression(x) && x.name.text === 'env' && isProcessRef(x.expression)) return true;
        if (ts.isElementAccessExpression(x) && literal(x.argumentExpression) === 'env' && isProcessRef(x.expression)) return true;
        if (ts.isIdentifier(x)) {
            const s = sym(x);
            return !!s && envAliases.has(s);
        }
        return false;
    };
    /** `process.env.X` / `process.env[x]` (also through an alias) or `process.env` itself; an alias variable alone is not. */
    const isEnvTarget = (e: TS.Expression): boolean => {
        const x = unwrap(e);
        if ((ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) && isProcessEnv(x.expression)) return true;
        return !ts.isIdentifier(x) && isProcessEnv(x);
    };
    const isFsBinding = (e: TS.Expression): boolean => {
        const x = unwrap(e);
        if (ts.isIdentifier(x)) {
            const s = sym(x);
            return !!s && fsBindings.has(s);
        }
        if (ts.isPropertyAccessExpression(x) && x.name.text === 'promises') return isFsBinding(x.expression);
        return isFsModule(requireOf(x));
    };
    /** Why a spec may not import `spec` (spec-import), or undefined; raw-process / raw-network report their own rule. */
    const specImportProblem = (spec: string): boolean => {
        if (spec.startsWith('.')) {
            const resolved = resolveModule(spec);
            return !SPEC_RELATIVE_ROOTS.test(resolved) || resolved.split('/').includes('node_modules');
        }
        if (spec === '@playwright/test') return false; // its own rules: test-import / raw-context / type-only below
        const b = builtinName(spec);
        if (b === 'child_process' || isRawNetworkModule(spec, resolveModule(spec))) return false;
        return !SPEC_BUILTINS.has(b);
    };
    const isUtilsModule = (spec: string): boolean => UTILS_MODULE.test(resolveModule(spec)) || UTILS_MODULE.test(spec);
    const isTestCall = (call: TS.CallExpression): boolean => {
        const c = call.expression;
        if (ts.isIdentifier(c)) return c.text === 'test';
        return ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'test' && TEST_CALLS.has(c.name.text);
    };

    /** Inside a type (an annotation, an interface): `Function` there is a type, not the constructor. */
    const inTypePosition = (n: TS.Node): boolean => {
        for (let p: TS.Node | undefined = n.parent; p; p = p.parent) {
            if (p.kind >= ts.SyntaxKind.FirstTypeNode && p.kind <= ts.SyntaxKind.LastTypeNode) return true;
            if (ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) return true;
            if (ts.isStatement(p) || ts.isExpressionStatement(p)) return false;
        }
        return false;
    };
    /** The name of a declaration or of a property (`{ eval: 1 }`, `x.eval` stays a reference). */
    const isDeclarationName = (n: TS.Identifier): boolean => {
        const p = n.parent;
        return (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) ||
            ts.isFunctionDeclaration(p) || ts.isParameter(p) || ts.isVariableDeclaration(p)) && (p as { name?: TS.Node }).name === n;
    };

    // ---- pass 1: bindings (fixtures, typed parameters, collections, apiJson aliases), then guarded aliases to a fixpoint
    const declarations: TS.VariableDeclaration[] = [];
    const collect = (n: TS.Node): void => {
        if (ts.isCallExpression(n) && isTestCall(n)) {
            for (const arg of n.arguments) {
                if (!(ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) continue;
                const first = arg.parameters[0];
                if (!first || !ts.isObjectBindingPattern(first.name)) continue;
                for (const el of first.name.elements) {
                    const key = (el.propertyName ?? el.name).getText(sf);
                    const s = sym(el.name);
                    if (!s) continue;
                    if (GUARDED_FIXTURES.has(key)) guarded.add(s);
                    if (TOKEN_FIXTURES.has(key)) tokens.add(s);
                    if (key === 'request') requestFixture.add(s);
                    if (key === 'page') pageFixture.add(s);
                }
            }
        }
        if (ts.isParameter(n) && ts.isIdentifier(n.name) && typeNamed(n.type, 'GuardedApi')) {
            const s = sym(n.name);
            if (s) guarded.add(s);
        }
        if ((ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) && n.initializer) {
            const init = unwrap(n.initializer);
            if (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && COLLECTION_CTORS.has(init.expression.text)) {
                const s = sym(n.name);
                if (s) collections.add(s);
            }
        }
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) declarations.push(n);
        // fs module bindings and process.env aliases (fix pass 4: fs-write / env-write)
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && isFsModule(n.moduleSpecifier.text) && n.importClause) {
            const c = n.importClause;
            if (c.name) {
                const s = sym(c.name);
                if (s) fsBindings.add(s);
            }
            if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) {
                const s = sym(c.namedBindings.name);
                if (s) fsBindings.add(s);
            }
            if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
                for (const el of c.namedBindings.elements) {
                    if ((el.propertyName ?? el.name).text === 'promises') {
                        const s = sym(el.name);
                        if (s) fsBindings.add(s);
                    }
                }
            }
        }
        if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && isFsModule(literal(n.moduleReference.expression))) {
            const s = sym(n.name);
            if (s) fsBindings.add(s);
        }
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
            const s = sym(n.name);
            if (s && isFsModule(requireOf(n.initializer))) fsBindings.add(s);
            const init = unwrap(n.initializer);
            if (s && ts.isPropertyAccessExpression(init) && init.name.text === 'env' && isProcessRef(init.expression)) envAliases.add(s);
            if (s && !ts.isIdentifier(init) && isProcessRef(init)) processAliases.add(s);
        }
        if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer) {
            const init = unwrap(n.initializer);
            for (const el of n.name.elements) {
                const key = (el.propertyName ?? el.name).getText(sf);
                const s = ts.isIdentifier(el.name) ? sym(el.name) : undefined;
                if (s && key === 'env' && isProcessRef(init)) envAliases.add(s);
            }
        }
        if ((ts.isImportSpecifier(n) || ts.isNamespaceImport(n) || ts.isImportClause(n)) && n.name) {
            const decl = ts.isImportSpecifier(n) ? n.parent.parent.parent : ts.isNamespaceImport(n) ? n.parent.parent : n.parent;
            if (ts.isImportDeclaration(decl) && ts.isStringLiteral(decl.moduleSpecifier) && decl.moduleSpecifier.text.startsWith('.')) {
                const s = sym(n.name);
                if (s) suiteHelpers.add(s);
            }
        }
        if (ts.isImportSpecifier(n) && /^apiJson/.test((n.propertyName ?? n.name).text)) {
            const s = sym(n.name);
            if (s) apiJsonFns.add(s);
        }
        if (ts.isFunctionDeclaration(n) && n.name && /^apiJson/.test(n.name.text)) {
            const s = sym(n.name);
            if (s) apiJsonFns.add(s);
        }
        ts.forEachChild(n, collect);
    };
    collect(sf);
    for (let changed = true; changed; ) {
        changed = false;
        for (const d of declarations) {
            const s = sym(d.name);
            if (!s) continue;
            if (!guarded.has(s) && isGuarded(d.initializer)) {
                guarded.add(s);
                changed = true;
            }
            if (!fsBindings.has(s) && isFsBinding(d.initializer!)) {
                fsBindings.add(s);
                changed = true;
            }
            if (!envAliases.has(s) && isProcessEnv(d.initializer!)) {
                envAliases.add(s);
                changed = true;
            }
            if (!processAliases.has(s) && isProcessRef(d.initializer!)) {
                processAliases.add(s);
                changed = true;
            }
            const init = unwrap(d.initializer!);
            const is = ts.isIdentifier(init) ? sym(init) : undefined;
            if (is && apiJsonFns.has(is) && !apiJsonFns.has(s)) {
                apiJsonFns.add(s);
                changed = true;
            }
        }
    }
    const isApiJsonCallee = (c: TS.Expression): boolean => {
        if (ts.isIdentifier(c)) {
            const s = sym(c);
            return (!!s && apiJsonFns.has(s)) || (!s && /^apiJson/.test(c.text));
        }
        return ts.isPropertyAccessExpression(c) && /^apiJson/.test(c.name.text);
    };

    /** The context-method / fetch / dynamic-method rules for `recv.<method>(args)`. */
    const checkMethodCall = (call: TS.CallExpression, recv: TS.Expression, method: string | undefined): void => {
        if (method === undefined) {
            if (!isGuarded(recv)) report(call, 'dynamic-method');
            return;
        }
        const m = method.toLowerCase();
        if (isRequestFixture(recv)) {
            if (m === 'get' || m === 'head') return;
            if (m === 'fetch' && READ_METHODS.has(methodOf(call.arguments[1]) ?? '')) return;
            report(call, 'raw-request-use');
            return;
        }
        if (MUTATING_METHODS.has(m)) {
            if (isGuarded(recv)) return;
            if (m === 'delete' && isCollection(recv)) return;
            if (m === 'post' && urlAllowed(call.arguments[0])) return;
            report(call, 'context-method');
        } else if (m === 'fetch') {
            // `route.fetch({ method })` takes its options first; `ctx.fetch(url, { method })` second.
            const first = call.arguments[0] && unwrap(call.arguments[0]);
            const verb = call.arguments.length === 1 && first && ts.isObjectLiteralExpression(first) ? methodOf(first) : methodOf(call.arguments[1]);
            if (verb && READ_METHODS.has(verb)) return;
            if (isGuarded(recv)) return;
            if (verb === 'POST' && urlAllowed(call.arguments[0])) return;
            report(call, 'fetch-method');
        }
    };

    /** apiJson* and send(ctx, method, url): a guarded context, a GET, or an allow-listed literal POST. */
    const checkJsonCall = (call: TS.CallExpression, rule: 'apiJson' | 'send-method'): void => {
        const [ctx, methodArg, url] = call.arguments;
        if (isGuarded(ctx)) return;
        const verb = literal(methodArg)?.toUpperCase();
        if (verb && READ_METHODS.has(verb)) return;
        if (verb === 'POST' && urlAllowed(url)) return;
        report(call, rule);
    };

    /** token-use (GD-02): a reference to a token fixture in a context that would print, compare or record it. */
    const isTokenRef = (e: TS.Node): boolean => {
        if (!ts.isIdentifier(e)) return false;
        // `{ restrictedToken }`: the identifier's own symbol is the property; the VALUE symbol is the binding.
        const s = ts.isShorthandPropertyAssignment(e.parent) && e.parent.name === e ? checker.getShorthandAssignmentValueSymbol(e.parent) : sym(e);
        return !!s && tokens.has(s);
    };
    const checkTokenUse = (n: TS.Identifier): void => {
        if (!isSpec || !isTokenRef(n)) return;
        const report = (node: TS.Node, rule: RawMutationRule): void => void out.push({ line: lineOf(node), rule, text: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120) });
        let x: TS.Node = n;
        while (ts.isParenthesizedExpression(x.parent) || ts.isNonNullExpression(x.parent) || ts.isAsExpression(x.parent) || ts.isAwaitExpression(x.parent)) x = x.parent;
        const p = x.parent;
        if (ts.isTemplateSpan(p)) return report(n, 'token-use');
        if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) return report(n, 'token-use');
        if (ts.isPropertyAssignment(p) && p.initializer === x) return report(n, 'token-use');
        if (ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p)) return report(n, 'token-use');
        if (ts.isCallExpression(p) && p.arguments.includes(x as TS.Expression)) {
            const c = p.expression;
            if (ts.isIdentifier(c) && (c.text === 'expect' || c.text === 'String')) return report(n, 'token-use');
            if (ts.isPropertyAccessExpression(c)) {
                const root = c.expression;
                if (ts.isIdentifier(root) && Object.hasOwn(TOKEN_SINKS, root.text) && TOKEN_SINKS[root.text].has(c.name.text)) return report(n, 'token-use');
                if (TOKEN_SINK_METHODS.has(c.name.text)) return report(n, 'token-use');
                if (ts.isIdentifier(root) && root.text === 'expect') return report(n, 'token-use');
            }
        }
        if (ts.isCallExpression(p) && p.expression === x) return report(n, 'token-use');
    };

    // ---- pass 2: the rules
    const visit = (n: TS.Node): void => {
        if (ts.isIdentifier(n)) checkTokenUse(n);
        if (isSpec && ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && !n.isTypeOnly) {
            const spec = n.moduleSpecifier.text;
            if (specImportProblem(spec) || spec === '@playwright/test') report(n, 'spec-import');
        }
        if (isSpec && ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && !n.isTypeOnly) {
            const spec = literal(n.moduleReference.expression);
            if (spec === undefined || specImportProblem(spec) || spec === '@playwright/test') report(n, 'spec-import');
            if (spec && (spec === 'child_process' || spec === 'node:child_process')) report(n, 'raw-process');
            if (spec && isRawNetworkModule(spec, resolveModule(spec))) report(n, 'raw-network');
        }
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
            const spec = n.moduleSpecifier.text;
            const clause = n.importClause;
            if (isSpec && !clause?.isTypeOnly && specImportProblem(spec)) report(n, 'spec-import');
            if (isSpec && spec === '@playwright/test' && clause && !clause.isTypeOnly && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                // Types only: `test` / `request` have their own rules; any other lower-case value (expect, chromium, devices …) is refused.
                for (const el of clause.namedBindings.elements) {
                    const name = (el.propertyName ?? el.name).text;
                    if (!el.isTypeOnly && /^[a-z_$]/.test(name) && name !== 'test' && name !== 'request') report(el, 'spec-import');
                }
            }
            if (isSpec && isFsModule(spec) && clause && !clause.isTypeOnly && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                for (const el of clause.namedBindings.elements) if (!el.isTypeOnly && FS_WRITE.test((el.propertyName ?? el.name).text)) report(el, 'fs-write');
            }
            if (isSpec && (spec === 'child_process' || spec === 'node:child_process')) report(n, 'raw-process');
            if (isSpec && isRawNetworkModule(spec, resolveModule(spec))) report(n, 'raw-network');
            if (isSpec && clause && !clause.isTypeOnly) {
                const named = clause.namedBindings;
                if (spec === '@playwright/test' && (clause.name || (named && ts.isNamespaceImport(named)))) report(clause, 'test-import');
                if (named && ts.isNamedImports(named)) {
                    for (const el of named.elements) {
                        if (!el.isTypeOnly && (el.propertyName ?? el.name).text === 'test' && !TEST_SOURCES.test(resolveModule(spec))) report(el, 'test-import');
                    }
                }
            }
            if (spec === '@playwright/test' && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                for (const el of clause.namedBindings.elements) if ((el.propertyName ?? el.name).text === 'request' && !el.isTypeOnly) report(el, 'raw-context');
            }
            if (isUtilsModule(spec) && clause && !clause.isTypeOnly) {
                if (clause.name) report(clause, 'util-import');
                const named = clause.namedBindings;
                if (named && ts.isNamespaceImport(named)) report(named, 'util-import');
                if (named && ts.isNamedImports(named)) {
                    for (const el of named.elements) {
                        if (el.isTypeOnly) continue;
                        const imported = (el.propertyName ?? el.name).text;
                        if (!UTIL_IMPORT_ALLOWED.test(imported) || UTIL_IMPORT_DENIED.has(imported)) report(el, 'util-import');
                    }
                }
            }
        }
        if (ts.isIdentifier(n)) {
            if (n.text === 'getAuthenticatedApiContext') report(n, 'raw-context');
            if (n.text === 'guardApiForUnitTests') report(n, 'unit-seam');
            if (n.text === 'XMLHttpRequest') report(n, 'raw-xhr');
            if (isSpec && n.text === 'createRequire') report(n, 'spec-import');
            const s = requestFixture.size ? sym(n) : undefined;
            if (s && requestFixture.has(s) && !ts.isBindingElement(n.parent)) {
                const p = n.parent;
                const receiverOfCall = ts.isPropertyAccessExpression(p) && p.expression === n && ts.isCallExpression(p.parent) && p.parent.expression === p;
                const factoryArg = ts.isCallExpression(p) && p.arguments.includes(n as TS.Expression) && ts.isIdentifier(p.expression) && GUARD_FACTORIES.has(p.expression.text);
                if (!receiverOfCall && !factoryArg) report(n, 'raw-request-use');
            }
        }
        if (isSpec && ts.isPropertyAccessExpression(n) && FS_WRITE.test(n.name.text) && isFsBinding(n.expression)) report(n, 'fs-write');
        if (isSpec && ts.isElementAccessExpression(n) && isFsBinding(n.expression)) {
            const key = literal(n.argumentExpression);
            if (key === undefined || FS_WRITE.test(key)) report(n, 'fs-write');
        }
        if (isSpec && ts.isPropertyAccessExpression(n) && LOADER_MEMBERS.has(n.name.text) && isProcessRef(n.expression)) report(n, 'spec-import');
        if (isSpec && ts.isElementAccessExpression(n) && LOADER_MEMBERS.has(literal(n.argumentExpression) ?? '') && isProcessRef(n.expression)) report(n, 'spec-import');
        // dynamic-code (fix pass 5): eval, Function, the Function constructor through `.constructor`, string timers.
        if (isSpec && ts.isIdentifier(n) && (n.text === 'eval' || n.text === 'Function') && !inTypePosition(n) && !isDeclarationName(n)) report(n, 'dynamic-code');
        if (isSpec && (ts.isCallExpression(n) || ts.isNewExpression(n))) {
            const callee = unwrap(n.expression);
            const member = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isElementAccessExpression(callee) ? literal(callee.argumentExpression) : undefined;
            if (member === 'constructor') report(n, 'dynamic-code');
            const timer = ts.isIdentifier(callee) ? callee.text : member;
            const first = n.arguments?.[0] && unwrap(n.arguments[0]);
            if (timer && STRING_TIMERS.has(timer) && first && (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first) || ts.isBinaryExpression(first))) report(n, 'dynamic-code');
        }
        // env-write: process.env handed to a function as a whole (it can write any key)
        if (isSpec && ts.isCallExpression(n) && n.arguments.some((a) => isProcessEnv(a))) {
            const c = n.expression;
            const reader = ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && Object.hasOwn(ENV_READERS, c.expression.text) && ENV_READERS[c.expression.text].has(c.name.text);
            const writer = ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && Object.hasOwn(ENV_WRITERS, c.expression.text);
            const root = ts.isPropertyAccessExpression(c) ? c.expression : c;
            const helper = ts.isIdentifier(root) && suiteHelpers.has(sym(root)!);
            if (!reader && !writer && !helper) report(n, 'env-write');
        }
        if (isSpec && ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && isFsBinding(n.initializer)) {
            for (const el of n.name.elements) if (FS_WRITE.test((el.propertyName ?? el.name).getText(sf))) report(el, 'fs-write');
        }
        // env-write: assignments, ++ / --, delete, Object / Reflect writers on process.env (and aliases)
        if (isSpec && ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && isEnvTarget(n.left)) {
            report(n, 'env-write');
        }
        if (isSpec && (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
            (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && isEnvTarget(n.operand)) report(n, 'env-write');
        if (isSpec && ts.isDeleteExpression(n) && isEnvTarget(n.expression)) report(n, 'env-write');
        if (isSpec && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) &&
            Object.hasOwn(ENV_WRITERS, n.expression.expression.text) && ENV_WRITERS[n.expression.expression.text].has(n.expression.name.text) &&
            n.arguments[0] && (isProcessEnv(n.arguments[0]) || isEnvTarget(n.arguments[0]))) report(n, 'env-write');
        if (ts.isPropertyAccessExpression(n)) {
            if (n.name.text === 'sendBeacon') report(n, 'raw-xhr');
            if (isSpec && isPageRequest(n)) {
                const p = n.parent;
                const receiverOfCall = ts.isPropertyAccessExpression(p) && p.expression === n && ts.isCallExpression(p.parent) && p.parent.expression === p;
                if (!receiverOfCall) report(n, 'raw-request-use');
            }
            const calledHere = ts.isCallExpression(n.parent) && n.parent.expression === n;
            if (!calledHere && EXTRACTED.has(n.name.text) && !isGuarded(n.expression) && !(n.name.text === 'delete' && isCollection(n.expression))) {
                report(n, 'method-extraction');
            }
        }
        if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && typeNamed(n.type, 'GuardedApi')) report(n, 'guarded-cast');
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
            const s = sym(n.left);
            if (s && guarded.has(s) && !isGuarded(n.right)) report(n, 'guarded-reassign');
        }
        if (ts.isCallExpression(n)) {
            const c = n.expression;
            if (ts.isPropertyAccessExpression(c)) {
                if (/^apiJson/.test(c.name.text)) checkJsonCall(n, 'apiJson');
                else checkMethodCall(n, c.expression, c.name.text);
            } else if (ts.isElementAccessExpression(c)) {
                checkMethodCall(n, c.expression, literal(c.argumentExpression));
            } else if (ts.isIdentifier(c)) {
                if (c.text === 'fetch' && !(sym(c)?.declarations?.length)) {
                    const verb = methodOf(n.arguments[1]);
                    if (!(verb && READ_METHODS.has(verb)) && !(verb === 'POST' && urlAllowed(n.arguments[0]))) report(n, 'fetch-method');
                } else if (isApiJsonCallee(c)) {
                    checkJsonCall(n, 'apiJson');
                } else if (c.text === 'send' && n.arguments.length >= 2) {
                    checkJsonCall(n, 'send-method');
                } else if (c.text === 'require') {
                    const spec = literal(n.arguments[0]);
                    if (isSpec && (spec === undefined || specImportProblem(spec))) report(n, 'spec-import');
                    if (spec && isUtilsModule(spec)) report(n, 'util-import');
                    if (isSpec && (spec === 'child_process' || spec === 'node:child_process')) report(n, 'raw-process');
                    if (isSpec && spec && isRawNetworkModule(spec, resolveModule(spec))) report(n, 'raw-network');
                    if (isSpec && spec === '@playwright/test') report(n, 'test-import');
                }
            } else if (c.kind === ts.SyntaxKind.ImportKeyword) {
                const spec = literal(n.arguments[0]);
                if (isSpec && (spec === undefined || specImportProblem(spec))) report(n, 'spec-import');
                if (spec && isUtilsModule(spec)) report(n, 'util-import');
                if (isSpec && (spec === 'child_process' || spec === 'node:child_process')) report(n, 'raw-process');
                if (isSpec && spec && isRawNetworkModule(spec, resolveModule(spec))) report(n, 'raw-network');
                if (isSpec && spec === '@playwright/test') report(n, 'test-import');
            }
            if (isSpec && ts.isPropertyAccessExpression(c)) {
                if (c.name.text === 'extend') report(n, 'fixture-extend');
                if (c.name.text === 'use' && ts.isIdentifier(c.expression) && c.expression.text === 'test') {
                    const o = n.arguments[0] && unwrap(n.arguments[0]);
                    const overrides = !o || !ts.isObjectLiteralExpression(o) || o.properties.some((p) =>
                        ts.isSpreadAssignment(p) || !p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) || CONTEXT_FIXTURES.has(p.name.text));
                    if (overrides) report(n, 'fixture-extend');
                }
                if (REQUEST_CALLS.has(c.name.text) && n.arguments.length >= 2) {
                    let o: TS.Expression = n.arguments[1];
                    while (ts.isAsExpression(o) || ts.isTypeAssertionExpression(o) || ts.isSatisfiesExpression(o) || ts.isParenthesizedExpression(o) || ts.isNonNullExpression(o)) o = o.expression;
                    if (ts.isObjectLiteralExpression(o)) {
                        const bad = o.properties.some((p) => {
                            if (ts.isSpreadAssignment(p)) return false;
                            const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
                            if (key === undefined) return true;
                            if (key === 'method') return c.name.text !== 'fetch';
                            return !REQUEST_OPTIONS.has(key);
                        });
                        if (bad) report(n, 'request-option');
                    }
                }
                if (c.name.text === 'continue' || c.name.text === 'fulfill') {
                    const o = n.arguments[0] && unwrap(n.arguments[0]);
                    const literalWithoutMethod = !o || (ts.isObjectLiteralExpression(o) && o.properties.every((p) =>
                        !ts.isSpreadAssignment(p) && !(p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'method')));
                    if (!literalWithoutMethod) report(n, 'route-method');
                }
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}
