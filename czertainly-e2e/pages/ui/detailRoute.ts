/**
 * detailRoute — a create form's submit and the detail route it leaves behind.
 *
 * WHAT: `submitCreate` clicks the Create button of a form scope and returns the create request's answer (the
 *       `CreateAnswer` of `createAnswer.ts`: status, uuid, request, body and the shared `ApiAnswer`, which the brief
 *       called `CreateOutcome`); the later `waitForDetailRoute` waits for the redirect to `#/<route>/detail/<uuid>`;
 *       `uuidFromHash` reads the uuid out of that route (the second uuid of a two-id route with `segments: 2`, the
 *       version of a versioned route with `version: true`; a trailing tab or query is allowed).
 * WHY: the answer comes first so that the spec writes the ledger line from it before any wait for the redirect: an
 *      object created on a shared tier must be on the ledger even when the page never redirects. The pages share one
 *      submit and one uuid reader instead of four click-and-wait copies and five regexes.
 * HOW: `submitCreate` builds on `createAnswerFrom` (wait registered before the click, uuid from the answer body); the
 *      route readers match a canonical uuid (8-4-4-4-12 hex) only, so a truncated id or a stray `-` is never taken.
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { CreateAnswer, createAnswerFrom } from './createAnswer';
import { submitButtonOf } from './form';
import { ApiCall } from './waitForResponse';

/** A canonical uuid: 8-4-4-4-12 hex digits. */
const CANONICAL_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export interface DetailRouteShape {
    /** How many uuids follow `/detail/` (the RA-profile route has two); the last one is read. Default 1. */
    segments?: number;
    /** The route ends in a numeric version after the uuids (`/detail/<uuid>/<version>`, notification profiles). */
    version?: boolean;
}

/** `#/<route>/detail/` followed by the uuids (the last one captured) and, when asked, the version. */
function detailRoutePattern(route: string, shape: DetailRouteShape): RegExp {
    const segments = shape.segments ?? 1;
    const ids = Array.from({ length: segments }, (_, i) => (i === segments - 1 ? `(${CANONICAL_UUID})` : `${CANONICAL_UUID}/`)).join('');
    return new RegExp(`#/${route}/detail/${ids}${shape.version ? '/\\d+' : ''}(?:[/?]|$)`, 'i');
}

/** The uuid of the detail route the page shows right now, or undefined when the page is on another route. */
export function detailUuidIfOn(page: Pick<Page, 'url'>, route: string, shape: DetailRouteShape = {}): string | undefined {
    return detailRoutePattern(route, shape).exec(page.url())?.[1];
}

/** The uuid of the detail route `#/<route>/detail/<uuid>` the page shows; throws when the page is on another route. */
export function uuidFromHash(page: Pick<Page, 'url'>, route: string, shape: DetailRouteShape = {}): string {
    const uuid = detailUuidIfOn(page, route, shape);
    if (!uuid) {
        const ids = Array(shape.segments ?? 1).fill('<uuid>').join('/');
        throw new Error(`uuidFromHash: the page is not on a ${route} detail route (#/${route}/detail/${ids}${shape.version ? '/<version>' : ''})`);
    }
    return uuid;
}

export interface SubmitCreateOptions {
    /** The create request: a string matches the end of the path (`/v1/groups`), a RegExp tests it. */
    endpoint: ApiCall['path'];
    /** Overrides the default timeout of the wait for the answer. */
    timeout?: number;
    /** Clicks Create twice (the double-submit probe); the answer is the first request's. */
    doubleClick?: boolean;
}

/**
 * Clicks the submit button of `scope` and returns the answer of the create request (`POST` to `endpoint`): status, the new
 * uuid, the request and its body. The wait is registered before the click; the redirect is NOT waited for: record the
 * ledger line from the answer first, then `waitForDetailRoute`.
 */
export async function submitCreate(page: Page, scope: Locator, options: SubmitCreateOptions): Promise<CreateAnswer> {
    const button = submitButtonOf(scope);
    return createAnswerFrom(page, { method: 'POST', path: options.endpoint, timeout: options.timeout }, () => (options.doubleClick ? button.dblclick() : button.click()));
}

/** Waits for the redirect to `#/<route>/detail/<uuid>` (the form's last act) and returns that uuid. Call it AFTER the ledger line. */
export async function waitForDetailRoute(page: Page, route: string, options: DetailRouteShape & { timeout?: number } = {}): Promise<string> {
    const { timeout, ...shape } = options;
    await expect(page, `the create form opens the ${route} detail page`).toHaveURL(detailRoutePattern(route, shape), timeout === undefined ? undefined : { timeout });
    return uuidFromHash(page, route, shape);
}
