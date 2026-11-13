/**
 * flows — the spec files of the secondary flow; every other row belongs to the main flow (tests/regression/README.md).
 * REG_FLOW picks the rows of a run: `main` (default), `secondary` or `all`; the run infrastructure runs in each.
 */
import { settings } from './run/settings';

export type Flow = 'main' | 'secondary' | 'all';

const FLOWS: readonly Flow[] = ['main', 'secondary', 'all'];

/** Paths from the czertainly-e2e folder; a path ending in "/" is a whole folder. */
export const SECONDARY_FLOW: readonly string[] = [
    'tests/api/01-auth/duplicate-names-refused.api.spec.ts',
    'tests/api/02-certificates/concurrent-operations.api.spec.ts',
    'tests/api/02-certificates/pqc-key-decoding.api.spec.ts',
    'tests/api/02-certificates/search-filters.api.spec.ts',
    'tests/api/02-certificates/search-sort-paging.api.spec.ts',
    'tests/api/04-credentials/kinds.api.spec.ts',
    'tests/api/04-credentials/validation.api.spec.ts',
    'tests/api/05-discovery/',
    'tests/api/06-groups/crud.api.spec.ts',
    'tests/api/11-scheduler/',
    'tests/api/13-secrets/',
];

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A path anchored at a path boundary on both sides, for POSIX and Windows separators. */
export function flowPattern(entry: string): RegExp {
    const parts = entry.split('/').filter(Boolean).map(escaped);
    return new RegExp(`(^|[\\\\/])${parts.join('[\\\\/]')}${entry.endsWith('/') ? '[\\\\/]' : '$'}`);
}

const SECONDARY_FILES: RegExp[] = SECONDARY_FLOW.map(flowPattern);

export function flowOf(env: NodeJS.ProcessEnv = process.env): Flow {
    const value = settings(env).flow;
    if (!value) return 'main';
    if (!(FLOWS as readonly string[]).includes(value)) throw new Error(`REG_FLOW="${value}" is not one of ${FLOWS.join(', ')}`);
    return value as Flow;
}

type FilePattern = RegExp | string;

interface FlowProject {
    name?: string;
    testMatch?: FilePattern | FilePattern[];
    testIgnore?: FilePattern | FilePattern[];
}

const asList = (v: FilePattern | FilePattern[] | undefined): FilePattern[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** The `rows` projects narrowed to the flow; a row project with its own testMatch keeps it in the secondary flow (logout). */
export function withFlow<T extends FlowProject>(projects: T[], rows: string[], flow: Flow): T[] {
    if (flow === 'all') return projects;
    return projects.map((p) => {
        if (!rows.includes(p.name ?? '')) return p;
        if (flow === 'main') return { ...p, testIgnore: [...asList(p.testIgnore), ...SECONDARY_FILES] };
        return p.testMatch === undefined ? { ...p, testMatch: SECONDARY_FILES } : p;
    });
}
