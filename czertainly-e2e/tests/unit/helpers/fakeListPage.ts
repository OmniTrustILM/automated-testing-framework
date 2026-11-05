/**
 * fakeListPage — a stand-in of a searchable list page of the admin UI and a browser context that serves it.
 * The page filters its rows in the browser; `withServedPage` lets a test swap the HTML between two calls.
 */
import type { Browser, Page } from '@playwright/test';

export const listPage = (title: string, kind: string, rows: string[], loaded = true) => `<!doctype html><html><body><main>
  <section><div><h5>${title}</h5><button data-testid="plus-button">+</button></div>
  <input aria-label="Search" id="search">
  <table><tbody id="rows">${loaded ? rows.map((r, i) => `<tr data-id="u${i}"><td><a href="#/${kind}/detail/u${i}">${r}</a></td></tr>`).join('') : '<tr><td>loading</td></tr>'}</tbody></table>
  </section></main>
  <script>document.getElementById('search').addEventListener('input', (e) => {
    for (const tr of document.querySelectorAll('#rows tr')) tr.style.display = tr.textContent.toLowerCase().includes(e.target.value.toLowerCase()) ? '' : 'none';
  });</script></body></html>`;

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
