/**
 * projectFilters — the tier rules (`@local` exclusion, `@phaseB` switch) ANDed into every Playwright project: a project's own
 * `grep` / `grepInvert` replaces the config-level one, so `withTierFilters()` folds the rules into each project.
 */
import { isLocalTier } from './tier/kind';
import { settings } from './run/settings';

export const LOCAL_TAG = /@local\b/;
export const PHASE_B_TAG = /@phaseB\b/;

type Grep = RegExp | RegExp[] | undefined;

export function isMigratedBuildPhase(env: NodeJS.ProcessEnv = process.env): boolean {
    return settings(env).phase === 'B';
}

function sources(grep: Grep): string[] {
    if (!grep) return [];
    const list = Array.isArray(grep) ? grep : [grep];
    return list.map((re) => {
        if (re.flags.replace(/[gy]/g, '')) throw new Error(`projectFilters: flags "${re.flags}" on ${re} cannot be combined; drop them`);
        return re.source;
    });
}

export function anyOf(...greps: Grep[]): RegExp | undefined {
    const parts = greps.flatMap(sources);
    if (!parts.length) return undefined;
    return new RegExp(parts.map((s) => `(?:${s})`).join('|'));
}

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

export function tierRules(env: NodeJS.ProcessEnv = process.env): TierRules {
    return {
        grep: isMigratedBuildPhase(env) ? PHASE_B_TAG : undefined,
        grepInvert: isLocalTier(env) ? undefined : LOCAL_TAG,
    };
}

interface FilterableProject {
    name?: string;
    grep?: RegExp | RegExp[];
    grepInvert?: RegExp | RegExp[];
}

/**
 * Every project with the tier rules folded in; `infrastructure` projects
 * (snapshot, non-interference) keep running in Phase B but exclude `@local`.
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

export function selectsTest(filter: ResolvedFilter, titleWithTags: string): boolean {
    const hit = (list: RegExp[]) => list.some((re) => {
        re.lastIndex = 0;
        return re.test(titleWithTags);
    });
    if (filter.grepInvert && hit(filter.grepInvert)) return false;
    return hit(filter.grep);
}
