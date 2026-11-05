/** listReads — reads of a full list endpoint by exact name; absence is proven from the list, never from a detail GET (core#2511). */
import type { APIRequestContext } from '@playwright/test';
import { readJsonOk, readAnswer } from './inventory/searchApi';
import { JsonObject } from './json';

export async function rowsNamed(api: APIRequestContext, listUrl: string, value: string, key = 'name'): Promise<JsonObject[]> {
    const rows = readJsonOk<JsonObject[]>(await readAnswer(api, listUrl), `GET ${listUrl}`);
    if (!Array.isArray(rows)) throw new Error(`GET ${listUrl} did not answer a list`);
    return rows.filter((r) => r?.[key] === value);
}

export async function findByName(api: APIRequestContext, listUrl: string, value: string, key = 'name'): Promise<JsonObject | undefined> {
    return (await rowsNamed(api, listUrl, value, key))[0];
}

export async function usersOrRolesNamed(api: APIRequestContext, kind: 'users' | 'roles', value: string): Promise<JsonObject[]> {
    return rowsNamed(api, `/api/v1/${kind}`, value, kind === 'users' ? 'username' : 'name');
}
