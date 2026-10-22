/**
 * Shared steps of the certificate list UI specs (REG-CERT-40 … 43 and 49 … 51): open the list (optionally filtered to the
 * run's seed by Common Name prefix and with a page size), check that the rows shown are an expected set and agree with
 * the API search for the same filters, read the seed ids in display order, and check an order against the comparator.
 */
import type { Page } from '@playwright/test';
import { expect, loginAsSmokeUser } from '../../../fixtures/testFixtures';
import { CertificateListPage } from '../../../pages/CertificateListPage';
import type { ListObservation } from '../../../pages/FilterWidget';
import type { PageSize } from '../../../pages/PagerWidget';
import type { TestEnv } from '../../env';
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

/**
 * Signs in and opens the certificate list. With `manifest` and `labels` the Common Name prefix filter of the run's seed is
 * added through the widget first (and kept); then the page size is set when given. Only one of the two is a caller
 * error and throws before anything is opened: the isolation filter is never skipped silently.
 */
export async function openCertificateList(
    page: Page, env: TestEnv, opts: { pageSize?: PageSize; manifest?: SeedAManifest; labels?: PlatformLabels } = {},
): Promise<CertificateListPage> {
    if (!opts.manifest !== !opts.labels) {
        throw new Error(`openCertificateList: the seed prefix filter needs both manifest and labels (${opts.manifest ? 'labels' : 'manifest'} missing)`);
    }
    const list = new CertificateListPage(page);
    await loginAsSmokeUser(page, env);
    await list.goToList();
    if (opts.manifest && opts.labels) await list.filterByCommonNamePrefix(opts.manifest.prefix, opts.labels);
    if (opts.pageSize) await list.setPageSize(opts.pageSize);
    return list;
}

/** The label of an attribute content type (the Field select appends it to a shared label). */
export const contentTypeLabel = (labels: PlatformLabels) => (code: string): string => labels.display('AttributeContentType', code);

/** An API filter as the list request carries it. */
export const wire = (f: Filter): Record<string, unknown> => ({ ...f });

/** The rows the page shows are exactly `ids`, and the API search for the same filters agrees on the uuid set and the count. */
export async function expectRowsAre(list: CertificateListPage, api: GuardedApi, m: SeedAManifest, ids: readonly CertId[], apiFilters: Filter[], seen: ListObservation): Promise<void> {
    const expectedNames = ids.map((id) => certById(m, id).commonName).sort();
    await expect.poll(async () => [...(await list.commonNames())].sort(), { message: 'the rows shown' }).toEqual(expectedNames);
    const apiRows = await searchAllRows(api, { filters: apiFilters, includeArchived: false });
    expect(uuidSet(apiRows), 'the API search for the same filters returns the expected set').toEqual(uuidsOfIds(m, ids));
    expect(seen.status, 'the list request the page sent').toBe(200);
    expect(seen.json?.totalItems, 'totalItems of the list the page showed = the API total').toBe(apiRows.length);
    expect((await list.commonNames()).length, 'rows shown (page size 25) = the API total').toBe(apiRows.length);
    const summary = await list.pager.summary();
    if (ids.length === 0) {
        expect(summary, 'no summary line without rows').toBeNull();
        await list.pager.assertPageSizeControl(false);
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
        .poll(async () => orderProblem(await visibleIds(list, m), groups), { message: `rows ordered by ${field} ${direction} (comparator over the manifest, ties as a set)` })
        .toBeUndefined();
}
