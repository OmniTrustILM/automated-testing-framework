/**
 * uiSubmitCreate — `submitCreate` hands back the create answer before any redirect, and `setSwitch` proves the state it sets.
 *
 * Checks, on a stand-in form whose Create button POSTs and whose route never changes: `submitCreate` returns status, uuid,
 * request, body and `ApiAnswer` at once; `waitForDetailRoute` is the step that fails, and returns the uuid once the route
 * arrives (also for a two-uuid route); the wait is registered BEFORE the click; a double click sends two requests and
 * returns the first answer. `setSwitch` clicks the label of a hidden input, never forces it, and fails when the state does
 * not follow. The ledger line is written between the steps, so a redirect timeout never leaves a created object off the ledger.
 */
import { expect, test } from '@playwright/test';
import { submitCreate, waitForDetailRoute } from '../../pages/ui/detailRoute';
import { fillRequiredCustomAttributes, setSwitch } from '../../pages/ui/form';

const U1 = '0b1e8a52-4c3f-4d6e-9a7b-1c2d3e4f5b01';
const U2 = '0b1e8a52-4c3f-4d6e-9a7b-1c2d3e4f5b02';

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

const form = `<!doctype html><html><body><main><div role="dialog" aria-label="Create Thing">
  <button data-testid="progress-button" onclick="fetch('/api/v1/things', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'qa-reg-x' }) })">Create</button>
  </div></main></body></html>`;

test('submitCreate returns the answer although the redirect never comes; waitForDetailRoute is the step that fails, then reads the uuid', async ({ browser }) => {
    let posts = 0;
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9/' });
    try {
        await context.route('**/*', (route) => {
            if (route.request().method() === 'POST') {
                posts += 1;
                return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ uuid: U1 }) });
            }
            return route.fulfill({ contentType: 'text/html', body: form });
        });
        const page = await context.newPage();
        await page.goto('/administrator/#/things');
        const dialog = page.getByRole('dialog', { name: 'Create Thing' });
        const created = await submitCreate(page, dialog, { endpoint: '/v1/things' });
        expect(created).toMatchObject({ status: 201, uuid: U1, body: { name: 'qa-reg-x' } });
        expect(created.request.method()).toBe('POST');
        expect(created.answer).toMatchObject({ status: 201, json: { uuid: U1 } });
        expect(await failsFast(waitForDetailRoute(page, 'things')), 'no redirect came').toBe(true);
        await page.evaluate((u) => { location.hash = `#/things/detail/${u}`; }, U1);
        expect(await waitForDetailRoute(page, 'things')).toBe(U1);
        await page.evaluate(([a, b]) => { location.hash = `#/pairs/detail/${a}/${b}`; }, [U1, U2]);
        expect(await waitForDetailRoute(page, 'pairs', { segments: 2 })).toBe(U2);
        expect(posts).toBe(1);
    } finally {
        await context.close();
    }
});

const switchPage = (follows: boolean) => `<!doctype html><html><body><div id="scope"><label for="flag">Flag</label>
  <label for="flag"><input type="checkbox" id="flag" data-testid="switch-flag-input" style="position:absolute;opacity:0;width:1px;height:1px" ${follows ? '' : 'onclick="event.preventDefault()"'}></label></div></body></html>`;

/** A form whose Create handler sends a SYNCHRONOUS request: the answer is complete before `click()` returns. */
const syncForm = `<!doctype html><html><body><main><div role="dialog" aria-label="Create Thing">
  <button data-testid="progress-button" onclick="const x = new XMLHttpRequest(); x.open('POST', '/api/v1/things', false); x.send('{}')">Create</button>
  </div></main></body></html>`;

test('submitCreate registers the wait before the click: an answer that is complete before click() returns is still seen', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9/' });
    try {
        await context.route('**/*', (route) => (route.request().method() === 'POST'
            ? route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ uuid: U1 }) })
            : route.fulfill({ contentType: 'text/html', body: syncForm })));
        const page = await context.newPage();
        await page.goto('/administrator/#/things');
        const created = await submitCreate(page, page.getByRole('dialog', { name: 'Create Thing' }), { endpoint: '/v1/things', timeout: 3_000 });
        expect(created.uuid).toBe(U1);
    } finally {
        await context.close();
    }
});

test('a double click that is answered with two different uuids returns the first answer; both requests were sent', async ({ browser }) => {
    const answers = [U1, U2];
    let posts = 0;
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9/' });
    try {
        await context.route('**/*', (route) => {
            if (route.request().method() !== 'POST') return route.fulfill({ contentType: 'text/html', body: form });
            const uuid = answers[posts++] ?? U2;
            return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ uuid }) });
        });
        const page = await context.newPage();
        await page.goto('/administrator/#/things');
        const twice = await submitCreate(page, page.getByRole('dialog', { name: 'Create Thing' }), { endpoint: '/v1/things', doubleClick: true });
        expect(twice.uuid, 'the first answer is the one returned').toBe(U1);
        await expect.poll(() => posts).toBe(2);
    } finally {
        await context.close();
    }
});

test('setSwitch clicks the label to set the state, leaves a switch already in state alone and proves the result', async ({ page }) => {
    await page.setContent(switchPage(true));
    const scope = page.locator('#scope');
    await setSwitch(scope, 'flag', true);
    await expect(page.getByTestId('switch-flag-input')).toBeChecked();
    await setSwitch(scope, 'flag', true);
    await setSwitch(scope, 'flag', false);
    await expect(page.getByTestId('switch-flag-input')).not.toBeChecked();
});

test('setSwitch fails when the state does not follow the click (mutant: a switch that ignores its label)', async ({ page }) => {
    await page.setContent(switchPage(false));
    expect(await failsFast(setSwitch(page.locator('#scope'), 'flag', true))).toBe(true);
});

const labelledCheckbox = (withId: boolean) => `<!doctype html><html><body><div id="scope"><label for="cat">Category</label>
  <input type="checkbox" ${withId ? 'id="cat"' : ''} data-testid="eventDataCategory-x-input" style="position:absolute;opacity:0;width:1px;height:1px"></div></body></html>`;

test('setSwitch takes an input locator too (a category checkbox) and fails on an input without an id', async ({ page }) => {
    await page.setContent(labelledCheckbox(true));
    const scope = page.locator('#scope');
    await setSwitch(scope, scope.getByTestId('eventDataCategory-x-input'), true);
    await expect(scope.getByTestId('eventDataCategory-x-input')).toBeChecked();
    await page.setContent(labelledCheckbox(false));
    expect(await failsFast(setSwitch(scope, scope.getByTestId('eventDataCategory-x-input'), true)), 'no id, no label to click').toBe(true);
});

test('fillRequiredCustomAttributes waits for the editor on a tier with only required attributes (labels, no add-select) and with only optional ones (add-select, no labels)', async ({ page }) => {
    const scope = page.locator('#scope');
    await page.setContent('<div id="scope"><label for="__attributes__custom__.team">Team *</label><input id="__attributes__custom__.team"></div>');
    expect(await fillRequiredCustomAttributes(page, scope, 'v', true)).toEqual(['Team *']);
    await expect(page.locator('[id="__attributes__custom__.team"]')).toHaveValue('v');
    await page.setContent('<div id="scope"><button data-testid="select-selectAddCustomAttribute-trigger">Show custom attribute</button></div>');
    expect(await fillRequiredCustomAttributes(page, scope, 'v', true)).toEqual([]);
    await page.setContent('<div id="scope"></div>');
    expect(await failsFast(fillRequiredCustomAttributes(page, scope, 'v', true)), 'definitions exist but no editor rendered').toBe(true);
    expect(await fillRequiredCustomAttributes(page, scope, 'v', false), 'no definitions, nothing to wait for').toEqual([]);
});
