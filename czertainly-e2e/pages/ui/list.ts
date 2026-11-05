/**
 * list — list helpers: real-row waits, filter badges, one text filter and the certificate list request an action causes.
 */
import { expect, Page, Request } from '@playwright/test';
import type { JsonObject } from '../../utils/regression/json';
import { FILTER_LIST_REQUEST_MS, FILTER_REQUEST_SEEN_MS } from '../../utils/regression/timeouts';
import { chooseOption, selectTriggerByLabel } from './select';

export async function waitForListRows(page: Page): Promise<void> {
    await expect(page.locator('main table tbody tr a[href*="/detail/"]').first()).toBeVisible({ timeout: 30_000 });
}

export async function filterBadges(page: Page): Promise<string[]> {
    const raw = await page.locator('main').getByRole('button', { name: /Remove badge$/ }).allInnerTexts();
    return raw.map((t) => t.replace(/\s*Remove badge$/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Source → Field → Condition → value → Apply. The value box is readonly until focused. */
export async function addInventoryTextFilter(page: Page, field: string, condition: string, value: string): Promise<void> {
    const main = page.locator('main');
    await chooseOption(page, selectTriggerByLabel(main, 'Filter Field Source'), 'Property');
    await chooseOption(page, selectTriggerByLabel(main, /^Filter Field$/), field);
    await chooseOption(page, selectTriggerByLabel(main, 'Filter Condition'), condition);
    const input = main.getByTestId('text-input-valueSelect');
    await input.click();
    await input.pressSequentially(value);
    await main.locator('#addFilter').click();
}

export interface ListBody {
    filters?: JsonObject[];
    itemsPerPage?: number;
    pageNumber?: number;
    sort?: JsonObject;
    columns?: JsonObject[];
    includeArchived?: boolean;
    [key: string]: unknown;
}

export interface ListObservation {
    request: Request;
    body: ListBody;
    status: number;
    json: JsonObject | undefined;
}

export function isCertificateListRequest(request: Request): boolean {
    if (request.method() !== 'POST') return false;
    try {
        return /\/api\/v1\/certificates\/?$/.test(new URL(request.url()).pathname);
    } catch {
        return false;
    }
}

function listBodyOf(request: Request): ListBody {
    try {
        return (request.postDataJSON() ?? {}) as ListBody;
    } catch {
        return {};
    }
}

/**
 * Runs `action` and returns the certificate list request it caused (the first one whose body satisfies `match`, when given).
 * A request the page cancelled (no response) is skipped for the next match.
 */
export async function observeListRequest(
    page: Page,
    action: () => Promise<unknown>,
    opts: { match?: (body: ListBody) => boolean; timeout?: number } = {},
): Promise<ListObservation> {
    const timeout = opts.timeout ?? FILTER_LIST_REQUEST_MS;
    const matches = (r: Request): boolean => isCertificateListRequest(r) && (!opts.match || opts.match(listBodyOf(r)));
    const collected: Request[] = [];
    const collect = (r: Request): void => {
        if (matches(r)) collected.push(r);
    };
    page.on('request', collect);
    try {
        const requested = page.waitForRequest(matches, { timeout });
        requested.catch(() => undefined); // an action that throws first must not leave an unhandled rejection behind
        await action();
        let request = await requested;
        let response = await request.response();
        for (let retry = 0; !response && retry < 3; retry++) {
            const later = collected.slice(collected.indexOf(request) + 1)[0];
            request = later ?? (await page.waitForRequest(matches, { timeout: Math.min(timeout, FILTER_REQUEST_SEEN_MS) }));
            response = await request.response();
        }
        if (!response) throw new Error(`the list request ${request.url()} got no response`);
        let json: JsonObject | undefined;
        try {
            json = (await response.json()) as JsonObject;
        } catch {
            json = undefined;
        }
        return { request, body: listBodyOf(request), status: response.status(), json };
    } finally {
        page.off('request', collect);
    }
}
