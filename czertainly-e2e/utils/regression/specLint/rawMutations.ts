/**
 * specLint/rawMutations — the deny-by-default lint of the REG / API specs and the regression helpers: every request
 * that could change an object must go through the guarded context.
 *
 * WHAT: `rawMutations(src, fileName, opts)` parses one source, resolves its names once (bindings.ts `Bindings`) and
 * lets every rule of the table (rules.ts `RULES`) look at every syntax node; it returns the findings as
 * `RawMutation[]` in source order of the visit. The rules are listed below; specGuards runs the lint over tests/regression,
 * tests/api, utils/regression and utils/api.
 * WHY: deny by default: anything the lint cannot prove safe is reported, so a spec cannot reach a shared tier through
 * a raw context, a rewritten route, a changed environment or a loaded module.
 * HOW: one file per concern: bindings.ts (names and aliases), rules.ts (one entry per rule, how to add one with a
 * temporary allow-list), this file (the rule list, the output types and the visitor).
 */
import type * as TS from 'typescript';
import { typescript } from './parseSpec';
import { Bindings, boundSource, type LintContext } from './bindings';
import { RULES, type Rule } from './rules';

/**
 * Rules of the deny-by-default lint (tests/unit/specGuards.spec.ts runs it over tests/regression, tests/api,
 * utils/regression and utils/api):
 * - raw-context        `getAuthenticatedApiContext` or `newAnonymousContext` (any reference: the fixtures own them) or
 *                      the `request` factory of @playwright/test: specs take the guarded `api` fixture (or
 *                      `getGuardedApiContext`) and the `anonymousApi` fixture;
 * - raw-request-use    the `request` fixture or `page.request` used for anything but a GET / HEAD (passed on, aliased,
 *                      any other method); as the argument of `getGuardedApiContext` / `guardApi` it is fine;
 * - unit-seam          `guardApiWithSeams` and `judgeWithSeams` outside tests/unit;
 * - callback-target    `registerCallbackTarget` (any reference: call, alias, destructuring, import, `ns.x`) and any string naming it or its module
 *                      `guard/callbackTargets` (bracket access, `require`, `import()`, `from`), outside utils/regression/guard/, utils/regression/specLint/,
 *                      tests/unit/ and utils/timestamping/provision/preflight.ts: only a preflight may say which pre-existing connector an attribute callback may name;
 * - guard-internal     an import (static, `import x = require()`, `require`, `import()`, `export … from`) of the guard's inner
 *                      modules `guard/sendRequest`, `guard/guardState`, `guard/readRequest`, `guard/checkRequest` or
 *                      `guard/claims` outside utils/regression/guard/ and tests/unit/: only createGuard composes them (check,
 *                      then send); a type-only import is fine;
 * - guarded-cast       `as GuardedApi` / `<GuardedApi>`: a raw context dressed up as a guarded one;
 * - guarded-reassign   a guarded binding assigned something that is not guarded;
 * - context-method     `.post` / `.put` / `.patch` / `.delete` on a receiver that is not provably guarded (a POST with a
 *                      literal read-only / protocol URL, or `allowedRawPost(url)`, is fine — a create needs the guard,
 *                      which checks its body; `.delete` on a Map / Set too);
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
 * Spec-only rules (imports, fixtures, routes):
 * - test-import        `test` imported from anything but fixtures/testFixtures or utils/api/apiCase (its re-export);
 *                      a namespace / default import or a `require` of @playwright/test;
 * - fixture-extend     any `.extend(` call: a spec cannot redefine the `api` fixture (or anything else);
 * - route-method       `route.continue(…)` / `route.fulfill(…)` with a `method` (or options that are not a literal):
 *                      a browser request turned into another method behind the guard's back;
 * - raw-network        imports (static, require, dynamic) of http, https, http2, net, tls, undici, @kubernetes/client-node
 *                      or utils/k8sClient: requests that bypass every context.
 * Spec-only rules (deny by default for imports):
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
 * Spec-only rules (process aliases, dynamic code, request options):
 * - `process` also means `globalThis.process` / `global.process` (any spelling, element access included) and a
 *   variable initialised from one: env-write and the loader members see through them; `process.env` handed to a
 *   function as a whole (`set(process.env)`) is an env-write too (Object.keys / values / entries / JSON.stringify read);
 * - dynamic-code         `eval` (direct, indirect `(0, eval)`, `globalThis.eval`), `Function` / `new Function` (any
 *                      reference, `globalThis.Function` included), a `.constructor(…)` call or `new x.constructor(…)`
 *                      (the Function constructor reached through any function), and `setTimeout` / `setInterval` /
 *                      `setImmediate` with a string, template or concatenated first argument: code the lint cannot read;
 * - request-option     an object-literal options argument of `.get` / `.post` / `.put` / `.patch` /
 *                      `.delete` / `.fetch` with a key the guard does not forward (`url`, `request`, `encodedParams`,
 *                      `__testHookLookup`, …) or a `method` outside `fetch`; `test.use({ api | request | … })` overriding a
 *                      context fixture is a fixture-extend.
 * Guarded fixtures and token fixtures:
 * - `anonymousApi` is a guarded fixture like `api`, and `localApi` (the local-stack guard) too (CONTEXT_FIXTURES, GUARDED_FIXTURES);
 *   `signedIn` is a page fixture like `page` (`signedIn.request` is a raw context), and every spec-facing fixture is in CONTEXT_FIXTURES;
 * - token-use the opaque token fixtures `adminToken` / `restrictedToken` may not be printed, compared or annotated: a template literal,
 *                      `expect(token…)`, a string concatenation, an object-literal property value (`annotations.push({ description: token
 *                      })`), `String(token)`, `JSON.stringify`, `console.*` / `logger.*` / `.push` arguments are violations;
 *                      `token.bearer()` / `token.claims()`, a truthiness check, `test.skip(!token, …)` and a call argument of a helper
 *                      (`callAs(api, token.bearer(), …)`, jwtTools) pass.
 * - response-state    `.headers()` / `.allHeaders()` / `.headersArray()` / `.storageState()` called on any receiver: only a header
 *                      assertion passes (`res.headers()['content-type']` with a literal name that is no cookie or credential
 *                      header, and the `headers` option of `checkRefusedMethod`); cookies and storage state never;
 * - live-forge          `as LiveOwn` / `<LiveOwn>`: a `LiveOwn` is the proof that `live(type, ref)` ran the live own-object check, and only
 *                      `LiveOwn.prove` builds one (private constructor); a cast would fake the proof;
 * A receiver is GUARDED when it is the `api` fixture of a test / hook, a parameter typed `GuardedApi`, the result of
 * `guardApi(…)` / `getGuardedApiContext(…)` / `assertGuarded(…)`, or a binding initialised from one of those (aliases
 * followed). Bindings are resolved by symbol (a single-file TypeScript program), so a name guarded in one function is
 * not trusted in another. Everything else is raw: deny by default.
 */
export type RawMutationRule =
    | 'raw-context' | 'raw-request-use' | 'unit-seam' | 'guarded-cast' | 'guarded-reassign' | 'context-method' | 'fetch-method'
    | 'dynamic-method' | 'method-extraction' | 'apiJson' | 'send-method' | 'raw-xhr' | 'util-import' | 'raw-process'
    | 'test-import' | 'fixture-extend' | 'route-method' | 'raw-network' | 'spec-import' | 'env-write' | 'fs-write'
    | 'dynamic-code' | 'request-option' | 'token-use' | 'guard-internal' | 'live-forge' | 'response-state' | 'callback-target';

export interface RawMutation {
    line: number;
    rule: RawMutationRule;
    text: string;
}

export interface LintOptions {
    /** The file is a spec (tests/…): the fixture rules (`request`, `page.request`, child_process) apply. Default: true. */
    spec?: boolean;
}

/**
 * The findings of a rule table over one source: every node is offered to every active rule, in table order. `fileName`
 * is the path relative to the czertainly-e2e folder (it resolves `../…Utils` imports and names the allow-lists).
 */
export function rawMutationsWith(rules: readonly Rule[], src: string, fileName = 'spec.ts', opts: LintOptions = {}): RawMutation[] {
    const ts = typescript();
    const isSpec = opts.spec ?? true;
    const { sf, checker } = boundSource(ts, fileName, src);
    const ctx: LintContext = { ts, sf, fileName, isSpec };
    const bindings = new Bindings(ctx, checker);
    const file = fileName.replace(/\\/g, '/');
    const active = rules.filter((r) => (isSpec || r.scope === 'all') && !r.allow?.includes(file));
    const out: RawMutation[] = [];
    const report = (n: TS.Node, rule: RawMutationRule): void => {
        out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, rule, text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 120) });
    };
    const visit = (n: TS.Node): void => {
        for (const r of active) for (const hit of r.hits(n, bindings, ctx)) report(hit, r.rule);
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

/**
 * Raw mutations and other ways around the guard in one REG / API source (see the rule list above).
 */
export function rawMutations(src: string, fileName = 'spec.ts', opts: LintOptions = {}): RawMutation[] {
    return rawMutationsWith(RULES, src, fileName, opts);
}
