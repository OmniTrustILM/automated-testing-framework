/**
 * certificateListSteps — shared steps of the certificate list UI specs (REG-CERT-40 … 43, 49 … 51): the rows shown against the API
 * search, the seed ids in display order and an order against the comparator.
 */
import { expect } from '../../../fixtures/testFixtures';
import type { CertificateListPage } from '../../../pages/CertificateListPage';
import type { ListObservation } from '../../../pages/ui/list';
import type { GuardedApi } from '../guard/types';
import type { PlatformLabels } from './fieldLabels';
import { Filter, searchAllRows, uuidSet } from './searchApi';
import { expectedOrderGroups, orderProblem, SortField } from './searchTables';
import { CertId, certById, SeedAManifest, uuidsOfIds } from './seedFull';

/** The column ids of the columns the sort and value rows name. */
export const COLUMN = {
    notAfter: 'property:NOT_AFTER',
    groups: 'property:GROUP_NAME',
    owner: 'property:OWNER',
    privateKey: 'property:PRIVATE_KEY',
} as const;

/** The label of an attribute content type (the Field select appends it to a shared label). */
export const contentTypeLabel = (labels: PlatformLabels) => (code: string): string => labels.display('AttributeContentType', code);

/** An API filter as the list request carries it. */
export const wire = (f: Filter): Record<string, unknown> => ({ ...f });

/** The seed ids the page must show, the API filters of the same search and the list request the page sent. */
interface ExpectedRows {
    manifest: SeedAManifest;
    ids: readonly CertId[];
    filters: Filter[];
    seen: ListObservation;
}

/** The rows the page shows are exactly `ids`, and the API search for the same filters agrees on the uuid set and the count. */
export async function expectRowsAre(
    list: CertificateListPage, api: GuardedApi, { manifest: m, ids, filters, seen }: ExpectedRows,
): Promise<void> {
    const expectedNames = ids.map((id) => certById(m, id).commonName).sort();
    await expect.poll(async () => [...(await list.commonNames())].sort(), { message: 'the rows shown' }).toEqual(expectedNames);
    const apiRows = await searchAllRows(api, { filters, includeArchived: false });
    expect(uuidSet(apiRows), 'the API search for the same filters returns the expected set').toEqual(uuidsOfIds(m, ids));
    expect(seen.status, 'the list request the page sent').toBe(200);
    expect(seen.json?.totalItems, 'totalItems of the list the page showed = the API total').toBe(apiRows.length);
    const summary = await list.pagerSummary();
    if (ids.length === 0) {
        expect(summary, 'no summary line without rows').toBeNull();
        await list.assertPageSizeControl(false);
    } else {
        expect(summary).toEqual({ from: 1, to: ids.length, total: ids.length });
    }
}

/** The seed ids of the rows shown, in display order (`?<name>` for a row that is not a seed). */
export async function visibleIds(list: CertificateListPage, m: SeedAManifest): Promise<CertId[]> {
    const byName = new Map(m.certificates.map((c) => [c.commonName, c.id]));
    return (await list.commonNames()).map((name) => byName.get(name) ?? (`?${name}` as CertId));
}

/** The loaded rows (polled, so a refetch in flight is never read half way) follow the comparator of a field and direction. */
export async function expectListOrder(list: CertificateListPage, m: SeedAManifest, field: SortField, direction: 'asc' | 'desc'): Promise<void> {
    const groups = expectedOrderGroups(m, field, direction);
    await expect
        .poll(async () => orderProblem(await visibleIds(list, m), groups), {
            message: `rows ordered by ${field} ${direction} (comparator over the manifest, ties as a set)`,
        })
        .toBeUndefined();
}
