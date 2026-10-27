/**
 * fakeListPage — a stand-in of a searchable list page of the admin UI and a browser context that serves it.
 *
 * WHAT: `listPage(title, kind, rows, loaded?)` is a list page (a titled widget, a client-side `Search` box and detail links
 * per row); `withServedPage` serves a page on a loopback base URL in a browser context and lets the test swap the HTML.
 * WHY: the role and user page tests need to change what "the server" answers between two calls of a page object, which a
 * static `setContent` page cannot do.
 * HOW: the page filters its rows in the browser like CustomTable; the context answers from a table of routes the test
 * changes; nothing leaves the browser.
 */
import type { Browser, Page } from '@playwright/test';

/** A list page whose Search box filters the rows client-side, like CustomTable; `rows` = the names listed. */
export const listPage = (title: string, kind: string, rows: string[], loaded = true) => `<!doctype html><html><body><main>
  <section><div><h5>${title}</h5><button data-testid="plus-button">+</button></div>
  <input aria-label="Search" id="search">
  <table><tbody id="rows">${loaded ? rows.map((r, i) => `<tr data-id="u${i}"><td><a href="#/${kind}/detail/u${i}">${r}</a></td></tr>`).join('') : '<tr><td>loading</td></tr>'}</tbody></table>
  </section></main>
  <script>document.getElementById('search').addEventListener('input', (e) => {
    for (const tr of document.querySelectorAll('#rows tr')) tr.style.display = tr.textContent.toLowerCase().includes(e.target.value.toLowerCase()) ? '' : 'none';
  });</script></body></html>`;

/**
 * A browser context that answers every request itself with the current `served` document (a loopback base URL, nothing
 * leaves the machine), so a test can change what "the server" answers between two calls of a page object.
 */
export async function withServedPage(browser: Browser, first: string, body: (page: Page, serve: (html: string) => void) => Promise<void>): Promise<void> {
    let served = first;
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9/' });
    try {
        await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: served }));
        await body(await context.newPage(), (html) => { served = html; });
    } finally {
        await context.close();
    }
}
