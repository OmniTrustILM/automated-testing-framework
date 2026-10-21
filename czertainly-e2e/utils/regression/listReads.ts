/**
 * listReads — reads of a full list endpoint by exact name. A list answers every object, so absence is proven from the LIST
 * (a detail read of a deleted role or user answers a 5xx on some builds: core#2511), never from a detail GET.
 */
import type { APIRequestContext } from '@playwright/test';
import { readJsonOk, readProbe } from './inventory/searchApi';
import type { Json } from './inventory/searchApi';

/** The rows of a list endpoint whose `key` (default `name`) is exactly `value`; a non-200 answer or a non-array body throws. */
export async function rowsNamed(api: APIRequestContext, listUrl: string, value: string, key = 'name'): Promise<Json[]> {
    const rows = readJsonOk<Json[]>(await readProbe(api, listUrl), `GET ${listUrl}`);
    if (!Array.isArray(rows)) throw new Error(`GET ${listUrl} did not answer a list`);
    return rows.filter((r) => r?.[key] === value);
}

/** The first row of a list endpoint whose `key` (default `name`) is exactly `value`, or undefined. */
export async function findByName(api: APIRequestContext, listUrl: string, value: string, key = 'name'): Promise<Json | undefined> {
    return (await rowsNamed(api, listUrl, value, key))[0];
}

/** The rows of the full users or roles list that carry `value` (a username for users, a name for roles). */
export async function usersOrRolesNamed(api: APIRequestContext, kind: 'users' | 'roles', value: string): Promise<Json[]> {
    return rowsNamed(api, `/api/v1/${kind}`, value, kind === 'users' ? 'username' : 'name');
}
