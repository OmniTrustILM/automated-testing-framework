import { IS_UUID, isCanonicalUuid } from './uuids';
import { BulkRoute, resourceTypeAt } from './routes';

const SCOPE_PARENTS = new Set(['authorities', 'raProfiles', 'tokens', 'entities', 'vaults', 'acmeProfiles']);
const SCOPE_CHILDREN = new Set(['raProfiles', 'certificates', 'tokenProfiles', 'keys', 'locations', 'vaultProfiles', 'acmeAccounts']);

export interface PathTarget {
    uuid: string;
    type: string | undefined;
}

/** The uuids of a path that name the object(s) a mutation changes (scope parents excluded), each with its ledger type. */
export function pathTargets(apiPath: string): PathTarget[] {
    const seg = apiPath.split('/').filter(Boolean);
    const out: PathTarget[] = [];
    seg.forEach((s, i) => {
        if (!IS_UUID.test(s)) return;
        const scopeParent = i > 0 && SCOPE_PARENTS.has(seg[i - 1]) && SCOPE_CHILDREN.has(seg[i + 1] ?? '') && IS_UUID.test(seg[i + 2] ?? '');
        if (!scopeParent) out.push({ uuid: s.toLowerCase(), type: resourceTypeAt(seg, i) });
    });
    return out;
}

export function targetUuids(apiPath: string): string[] {
    return pathTargets(apiPath).map((t) => t.uuid);
}

export const ATTRIBUTE_KEY = /^(attributes|customAttributes|metadata)$|Attributes$/;
const LIST_KEY = /^uuids$|Uuids$/;
export const MAX_BODY_DEPTH = 200;

export const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function jsonDepth(value: unknown): number {
    let max = 0;
    const stack: Array<[unknown, number]> = [[value, 0]];
    while (stack.length) {
        const [v, d] = stack.pop()!;
        if (d > max) max = d;
        if (d > MAX_BODY_DEPTH) return d;
        if (Array.isArray(v)) for (const x of v) stack.push([x, d + 1]);
        else if (isPlainObject(v)) for (const x of Object.values(v)) stack.push([x, d + 1]);
    }
    return max;
}

/** The objects a bulk mutation (no uuid in the path) names explicitly, or why not; `filters` and an empty list ("all") are refused. */
export function bulkTargets(data: unknown): { uuids: string[] } | { problem: string } {
    if (hasFiltersKey(data)) return { problem: 'a bulk body with filters (never accepted: they select objects the guard cannot see)' };
    let lists: unknown[][];
    if (Array.isArray(data)) lists = [data];
    else if (isPlainObject(data)) {
        const keyed = Object.entries(data).filter(([k]) => LIST_KEY.test(k));
        if (keyed.some(([, v]) => !Array.isArray(v))) return { problem: 'a top-level uuids / *Uuids field that is not a list' };
        if (keyed.some(([, v]) => (v as unknown[]).length === 0)) return { problem: 'an empty uuids / *Uuids list (means "all" on some endpoints)' };
        lists = keyed.map(([, v]) => v as unknown[]);
    } else lists = [];
    const values = lists.flat();
    if (!values.length) return { problem: 'a mutation without a uuid in the path needs an explicit, non-empty uuid list at the top level of the body (never filters, never nested)' };
    if (!values.every((u) => isCanonicalUuid(u))) return { problem: 'a bulk list with a value that is not a canonical uuid' };
    return { uuids: [...new Set(values.map((u) => (u as string).toLowerCase()))] };
}

export function hasFiltersKey(data: unknown): boolean {
    const stack: unknown[] = [data];
    while (stack.length) {
        const v = stack.pop();
        if (Array.isArray(v)) stack.push(...v);
        else if (isPlainObject(v)) {
            for (const [k, x] of Object.entries(v)) {
                if (k.toLowerCase() === 'filters') return true;
                stack.push(x);
            }
        }
    }
    return false;
}

/**
 * The objects the body of an allow-listed bulk route names, or why not: an
 * `array` route takes canonical uuids only, a DTO route only the DTO's fields.
 */
export function bulkRouteTargets(route: BulkRoute, data: unknown): { uuids: string[] } | { problem: string } {
    let values: unknown;
    if (route.list === 'array') {
        if (!Array.isArray(data)) return { problem: `${route.path} takes a uuid list (${route.dto}) as its body` };
        values = data;
    } else {
        if (!isPlainObject(data)) return { problem: `${route.path} takes a ${route.dto} object as its body` };
        const allowed = new Set([route.list, ...(route.fields ?? [])]);
        const extra = Object.keys(data).filter((k) => !allowed.has(k));
        if (extra.length) return { problem: `a field the ${route.dto} body does not have (${extra.slice(0, 3).map((k) => JSON.stringify(k.slice(0, 24))).join(', ')}): filters, select-all flags and unknown fields are refused` };
        values = data[route.list];
        if (!Array.isArray(values)) return { problem: `${route.list} must be a list of uuids` };
    }
    const list = values as unknown[];
    if (!list.length) return { problem: 'an empty uuid list (means "all" or nothing on some endpoints)' };
    if (!list.every((u) => isCanonicalUuid(u))) return { problem: 'a bulk list with a value that is not a canonical uuid' };
    return { uuids: [...new Set(list.map((u) => (u as string).toLowerCase()))] };
}

export function bodyUuids(data: unknown): string[] | undefined {
    const r = bulkTargets(data);
    return 'uuids' in r ? r.uuids : undefined;
}

