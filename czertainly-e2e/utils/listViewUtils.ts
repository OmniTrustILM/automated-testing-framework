/**
 * listViewUtils — creates, reads and removes saved list views through the list-view API.
 *
 * WHAT: thin wrappers over `/api/v1/listViews` (list, create, edit, delete) and a lookup of a
 * displayable property column of a resource.
 *
 * WHY: tests of saved views need views as preconditions and must remove every one they create;
 * the views belong to the logged user, so a leftover would show up in that user's inventory.
 *
 * HOW: errors carry "... failed: <status> - <body>" like the other helpers, so cleanupLedger can
 * read the status. `createView` returns the raw response so a test can assert on a refusal.
 */

import { APIRequestContext, APIResponse } from '@playwright/test';

export interface ListViewColumn {
    fieldSource: string;
    fieldIdentifier: string;
    label?: string;
}

export interface ListViewDto {
    uuid: string;
    name: string;
    resource: string;
    columns: ListViewColumn[];
    defaultView: boolean;
}

export interface ListViewInput {
    name: string;
    resource: string;
    columns: ListViewColumn[];
    defaultView?: boolean;
}

export async function listViews(request: APIRequestContext, resource: string): Promise<ListViewDto[]> {
    const resp = await request.get('/api/v1/listViews', { params: { resource } });
    if (!resp.ok()) {
        throw new Error(`List views of ${resource} failed: ${resp.status()} - ${await resp.text()}`);
    }
    return await resp.json() as ListViewDto[];
}

/** Returns the raw response: a caller testing a refusal needs the status, not an exception. */
export async function createViewRaw(request: APIRequestContext, input: ListViewInput): Promise<APIResponse> {
    return request.post('/api/v1/listViews', { data: { defaultView: false, ...input } });
}

export async function createView(request: APIRequestContext, input: ListViewInput): Promise<ListViewDto> {
    const resp = await createViewRaw(request, input);
    if (!resp.ok()) {
        throw new Error(`Create view ${input.name} failed: ${resp.status()} - ${await resp.text()}`);
    }
    return await resp.json() as ListViewDto;
}

/** Edit takes the mutable part only; the resource of a view never changes. */
export async function editView(request: APIRequestContext, uuid: string, input: Omit<ListViewInput, 'resource'>): Promise<ListViewDto> {
    const resp = await request.put(`/api/v1/listViews/${uuid}`, { data: { defaultView: false, ...input } });
    if (!resp.ok()) {
        throw new Error(`Edit view ${uuid} failed: ${resp.status()} - ${await resp.text()}`);
    }
    return await resp.json() as ListViewDto;
}

/** A view that is gone already counts as deleted. */
export async function deleteView(request: APIRequestContext, uuid: string): Promise<void> {
    const resp = await request.delete(`/api/v1/listViews/${uuid}`);
    if (resp.status() === 404) return;
    if (!resp.ok()) {
        throw new Error(`Delete view ${uuid} failed: ${resp.status()} - ${await resp.text()}`);
    }
}

/**
 * A property column the resource offers and can show, read from its searchable-fields operation
 * (`searchPath`, e.g. `/api/v1/certificates/search`) so no field name is guessed.
 */
export async function getDisplayablePropertyColumn(request: APIRequestContext, searchPath: string): Promise<ListViewColumn> {
    const resp = await request.get(searchPath);
    if (!resp.ok()) {
        throw new Error(`Get searchable fields ${searchPath} failed: ${resp.status()} - ${await resp.text()}`);
    }
    const groups = await resp.json() as Array<{
        filterFieldSource: string;
        searchFieldData?: Array<{ fieldIdentifier: string; displayable?: boolean }>;
    }>;
    const property = groups.find((g) => g.filterFieldSource === 'property');
    const field = property?.searchFieldData?.find((f) => f.displayable !== false);
    if (!field) {
        throw new Error(`${searchPath} offers no displayable property field`);
    }
    return { fieldSource: 'property', fieldIdentifier: field.fieldIdentifier };
}
