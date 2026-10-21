/**
 * projectFilters — the tier rules (`@local` exclusion, `@phaseB` switch) ANDed into every Playwright project.
 *
 * WHY: Playwright 1.58 resolves `grep` / `grepInvert` per project as `takeFirst(project, config)`: a project's own value
 * REPLACES the config-level one. A project with `grep: /@p1/` would silently drop a config-level `grepInvert: /@local/`
 * and the `@phaseB` grep. So the rules are not set on the config alone; `withTierFilters()` folds them into every
 * project as single RegExps:
 *   grep       = allOf(projectGrep, phaseBGrep)      (phaseBGrep only when REG_PHASE=B; not on infrastructure projects)
 *   grepInvert = anyOf(projectInvert, localInvert)    (localInvert unless TIER_KIND=local; on every project)
 * `describeLocalOnly()` stays as the second guard inside each `@local` spec.
 *
 * `resolveProjectFilters()` mirrors Playwright's takeFirst so a unit test can check what a config really selects.
 */
import { isLocalTier } from './tier/kind';

/** `@local` and every `@local:<x>` variant. */
export const LOCAL_TAG = /@local\b/;
export const PHASE_B_TAG = /@phaseB\b/;

type Grep = RegExp | RegExp[] | undefined;

function sources(grep: Grep): string[] {
    if (!grep) return [];
    const list = Array.isArray(grep) ? grep : [grep];
    return list.map((re) => {
        if (re.flags.replace(/[gy]/g, '')) throw new Error(`projectFilters: flags "${re.flags}" on ${re} cannot be combined; drop them`);
        return re.source;
    });
}

/** A RegExp that matches when ANY of the given patterns matches (an array argument is itself an OR). */
export function anyOf(...greps: Grep[]): RegExp | undefined {
    const parts = greps.flatMap(sources);
    if (!parts.length) return undefined;
    return new RegExp(parts.map((s) => `(?:${s})`).join('|'));
}

/** A RegExp that matches when EVERY given pattern matches somewhere in the title (an array argument is an OR). */
export function allOf(...greps: Grep[]): RegExp | undefined {
    const parts = greps.filter((g) => !!g && (!Array.isArray(g) || g.length > 0)).map((g) => anyOf(g)!.source);
    if (!parts.length) return undefined;
    if (parts.length === 1) return new RegExp(parts[0]);
    return new RegExp(`^${parts.map((s) => `(?=[\\s\\S]*?(?:${s}))`).join('')}`);
}

export interface TierRules {
    grep?: RegExp;
    grepInvert?: RegExp;
}

/** The rules of this run: exclude `@local` unless TIER_KIND=local; select only `@phaseB` when REG_PHASE=B. */
export function tierRules(env: NodeJS.ProcessEnv = process.env): TierRules {
    return {
        grep: env.REG_PHASE === 'B' ? PHASE_B_TAG : undefined,
        grepInvert: isLocalTier(env) ? undefined : LOCAL_TAG,
    };
}

interface FilterableProject {
    name?: string;
    grep?: RegExp | RegExp[];
    grepInvert?: RegExp | RegExp[];
}

/**
 * Every project with the tier rules folded in. `infrastructure` names projects (snapshot, non-interference) that are not
 * ledger rows: they keep running in Phase B (the `@phaseB` grep is not applied to them), but `@local` is excluded
 * there as everywhere else.
 */
export function withTierFilters<T extends FilterableProject>(
    projects: T[],
    opts: { env?: NodeJS.ProcessEnv; infrastructure?: string[] } = {},
): T[] {
    const rules = tierRules(opts.env ?? process.env);
    const infra = new Set(opts.infrastructure ?? []);
    return projects.map((p) => {
        const grep = infra.has(p.name ?? '') ? allOf(p.grep) : allOf(p.grep, rules.grep);
        const grepInvert = anyOf(p.grepInvert, rules.grepInvert);
        const out: T = { ...p };
        if (grep) out.grep = grep;
        else delete out.grep;
        if (grepInvert) out.grepInvert = grepInvert;
        else delete out.grepInvert;
        return out;
    });
}

export interface ResolvedFilter {
    name: string;
    grep: RegExp[];
    grepInvert: RegExp[] | null;
}

const asList = (g: RegExp | RegExp[]): RegExp[] => (Array.isArray(g) ? g : [g]);

/** What Playwright 1.58 resolves per project: `takeFirst(project.grep, config.grep, /.* /)`, likewise for grepInvert. */
export function resolveProjectFilters(config: {
    grep?: RegExp | RegExp[];
    grepInvert?: RegExp | RegExp[];
    projects?: FilterableProject[];
}): ResolvedFilter[] {
    return (config.projects ?? [{}]).map((p) => {
        const grep = p.grep ?? config.grep ?? /.*/;
        const grepInvert = p.grepInvert ?? config.grepInvert ?? null;
        return { name: p.name ?? '', grep: asList(grep), grepInvert: grepInvert ? asList(grepInvert) : null };
    });
}

/** Playwright's title matcher: the invert wins, then any grep pattern must match the title (with tags). */
export function selectsTest(filter: ResolvedFilter, titleWithTags: string): boolean {
    const hit = (list: RegExp[]) => list.some((re) => {
        re.lastIndex = 0;
        return re.test(titleWithTags);
    });
    if (filter.grepInvert && hit(filter.grepInvert)) return false;
    return hit(filter.grep);
}
