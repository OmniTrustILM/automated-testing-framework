/**
 * detailRoute — `submitCreate`, `waitForDetailRoute` and `uuidFromHash`: a create form's submit and its detail route.
 * The answer comes first, so the spec writes the ledger line before any wait for the redirect.
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { CreateAnswer, createAnswerFrom } from './createAnswer';
import { ApiCall } from './waitForResponse';

const CANONICAL_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export interface DetailRouteShape {
    segments?: number;
    version?: boolean;
}

function detailRoutePattern(route: string, shape: DetailRouteShape): RegExp {
    const segments = shape.segments ?? 1;
    const ids = Array.from({ length: segments }, (_, i) => (i === segments - 1 ? `(${CANONICAL_UUID})` : `${CANONICAL_UUID}/`)).join('');
    return new RegExp(`#/${route}/detail/${ids}${shape.version ? '/\\d+' : ''}(?:[/?]|$)`, 'i');
}

export function detailUuidIfOn(page: Pick<Page, 'url'>, route: string, shape: DetailRouteShape = {}): string | undefined {
    return detailRoutePattern(route, shape).exec(page.url())?.[1];
}

export function uuidFromHash(page: Pick<Page, 'url'>, route: string, shape: DetailRouteShape = {}): string {
    const uuid = detailUuidIfOn(page, route, shape);
    if (!uuid) {
        const ids = Array(shape.segments ?? 1).fill('<uuid>').join('/');
        throw new Error(`uuidFromHash: the page is not on a ${route} detail route (#/${route}/detail/${ids}${shape.version ? '/<version>' : ''})`);
    }
    return uuid;
}

export interface SubmitCreateOptions {
    endpoint: ApiCall['path'];
    timeout?: number;
    doubleClick?: boolean;
}

/** Clicks Create and returns the create answer. The redirect is NOT waited for: record the ledger line first, then `waitForDetailRoute`. */
export async function submitCreate(page: Page, createButton: Locator, options: SubmitCreateOptions): Promise<CreateAnswer> {
    return createAnswerFrom(page, { method: 'POST', path: options.endpoint, timeout: options.timeout }, () => (options.doubleClick ? createButton.dblclick() : createButton.click()));
}

/** Call it AFTER the ledger line. */
export async function waitForDetailRoute(page: Page, route: string, options: DetailRouteShape & { timeout?: number } = {}): Promise<string> {
    const { timeout, ...shape } = options;
    await expect(page, `the create form opens the ${route} detail page`).toHaveURL(detailRoutePattern(route, shape), timeout === undefined ? undefined : { timeout });
    return uuidFromHash(page, route, shape);
}
