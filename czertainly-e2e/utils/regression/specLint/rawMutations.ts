/**
 * specLint/rawMutations — the deny-by-default lint of the REG / API specs and regression helpers: every request that could
 * change an object must go through the guarded context. Anything the lint cannot prove safe is reported.
 */
import type * as TS from 'typescript';
import { typescript } from './parseSpec';
import { Bindings, boundSource, type LintContext } from './bindings';
import { RULES, type Rule } from './rules';

/**
 * A receiver is guarded when it is the `api` fixture, a `GuardedApi` parameter or the result of a guard helper; the rest is raw.
 * - raw-context, raw-request-use, guarded-cast, guarded-reassign, unit-seam, guard-internal, callback-target: stay on the guarded context.
 * - context-method, fetch-method, dynamic-method, method-extraction, apiJson, send-method, raw-xhr: no mutating call on a raw receiver.
 * - util-import, raw-process, raw-network, test-import, fixture-extend, route-method, spec-import: audited imports and one `test` source.
 * - env-write, fs-write, dynamic-code, request-option: no env or fs write, no `eval`, no unforwarded request option.
 * - token-use, response-state, live-forge: tokens, cookies and storage state are never read; a `LiveOwn` is never cast.
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
    spec?: boolean;
}

/**
 * The findings of a rule table over one source: every node is offered to
 * every active rule, in table order. `fileName` is relative to czertainly-e2e.
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

/** Raw mutations and other ways around the guard in one source (see the rule list above). */
export function rawMutations(src: string, fileName = 'spec.ts', opts: LintOptions = {}): RawMutation[] {
    return rawMutationsWith(RULES, src, fileName, opts);
}
