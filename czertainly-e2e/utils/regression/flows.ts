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
    'tests/api/03-contract/errors.api.spec.ts',
    'tests/api/03-contract/list-field-properties.api.spec.ts',
    'tests/api/03-contract/openapi-schema.api.spec.ts',
    'tests/api/03-contract/paging-and-sorting.api.spec.ts',
    'tests/api/04-credentials/kinds.api.spec.ts',
    'tests/api/04-credentials/validation.api.spec.ts',
    'tests/api/05-discovery/',
    'tests/api/06-groups/crud.api.spec.ts',
    'tests/api/07-keys/',
    'tests/api/08-notifications/',
    'tests/api/09-protocols/cmp.api.spec.ts',
    'tests/api/09-protocols/scep.api.spec.ts',
    'tests/api/09-protocols/wrong-content-type-refused.api.spec.ts',
    'tests/api/11-scheduler/',
    'tests/api/12-workflows/',
    'tests/api/13-secrets/',
    'tests/regression/01-sign-in-and-access/01-sign-in-and-session.spec.ts',
    'tests/regression/01-sign-in-and-access/99-sign-out.spec.ts',
    'tests/regression/02-certificates/40-filter-condition-catalogue.spec.ts',
    'tests/regression/02-certificates/41-text-filters.spec.ts',
    'tests/regression/02-certificates/42-date-and-duration-filters.spec.ts',
    'tests/regression/02-certificates/43-list-and-enum-filters.spec.ts',
    'tests/regression/02-certificates/49-list-sorting.spec.ts',
    'tests/regression/02-certificates/50-list-paging.spec.ts',
    'tests/regression/02-certificates/51-list-standard-columns.spec.ts',
    'tests/regression/02-certificates/63-import-certificates-and-keys.spec.ts',
    'tests/regression/02-certificates/68-create-forms-reject-invalid-input.spec.ts',
    'tests/regression/04-compliance/',
    'tests/regression/05-connectors/',
    'tests/regression/06-core-platform/',
    'tests/regression/08-discovery/',
    'tests/regression/09-keys-and-tokens/',
    'tests/regression/10-protocols/',
    'tests/regression/11-secrets/',
    'tests/regression/13-workflows-and-notifications/',
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
