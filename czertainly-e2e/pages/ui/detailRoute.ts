/**
 * What a create form leaves behind: the admin UI routes to the new object's detail page (`#/<route>/detail/<uuid>`), and
 * a page object returns the uuid with the create request it sent, as one `CreateOutcome`.
 */
import type { Page, Request } from '@playwright/test';
import { UUID } from './waitForResponse';

/** The result of a create through a form: the new object's uuid, the create request and its JSON body. */
export interface CreateOutcome {
    uuid: string;
    /** The create request the form sent (method POST, JSON body), for the request ↔ stored object ↔ detail oracle. */
    request: Request;
    body: Record<string, unknown>;
}

/** The uuid of the detail route `#/<route>/detail/<uuid>` the page shows; throws when the page is on another route. */
export function uuidFromHash(page: Pick<Page, 'url'>, route: string): string {
    const url = page.url();
    const m = new RegExp(`#/${route}/detail/(${UUID})(?:[/?]|$)`).exec(url);
    if (!m) throw new Error(`uuidFromHash: the page is not on a ${route} detail route (#/${route}/detail/<uuid>)`);
    return m[1];
}
