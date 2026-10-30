/**
 * uiCreateAnswers — unit tests: a UI create hands its uuid back from the answer, before the page redirects.
 *
 * Runs three page objects on stand-in pages whose create request is answered but whose route never changes. The create still
 * returns the uuid, and only the wait for the redirect fails. A refusal gives no uuid; an error answer that carries one keeps it.
 * The ledger line is written between the two steps, so a created object is never off the ledger because the redirect timed out.
 */
import { expect, request, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import * as fs from 'fs';
import { KeyPage } from '../../pages/KeyPage';
import { NotificationInstancePage } from '../../pages/NotificationInstancePage';
import { TokenPage } from '../../pages/TokenPage';
import { ledgerFile, readLedger } from '../../utils/regression/ledger/ledger';
import { loopbackServer } from './helpers/loopbackServer';
import { currentRunId } from '../../utils/regression/run/runId';
import { lookupDiscovery, lookupKey, recordIfCreated, recordUiCreate, submitRecordingByNameOnFailure } from '../../utils/regression/ledger/uiCreates';

const U1 = '0b1e8a52-4c3f-4d6e-9a7b-1c2d3e4f5a01';
const U2 = '0b1e8a52-4c3f-4d6e-9a7b-1c2d3e4f5a02';
const U3 = '0b1e8a52-4c3f-4d6e-9a7b-1c2d3e4f5a03';
const U4 = '0b1e8a52-4c3f-4d6e-9a7b-1c2d3e4f5a04';
const SPEC = 'UNIT-UI-CREATE';
/** Ledger names carry the run prefix, or the line does not prove ownership. */
const own = (suffix: string): string => `${currentRunId()}-${suffix}`;

const failsFast = async (call: Promise<unknown>): Promise<boolean> => call.then(() => false, () => true);

interface Answer {
    status: number;
    body: unknown;
}

/** A page at `hash` whose Create button POSTs `path` and does nothing with the answer (no redirect, the dialog stays open). */
const createForm = (caption: string, path: string) => `<!doctype html><html><body><main><div role="dialog" aria-label="${caption}">
  <button data-testid="progress-button" onclick="fetch('${path}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'qa-reg-x' }) })">Create</button>
  </div></main></body></html>`;

async function withAnswers(browser: Browser, html: string, answer: Answer, body: (page: Page, posts: () => number) => Promise<void>): Promise<void> {
    let posts = 0;
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9/' });
    try {
        await context.route('**/*', (route) => {
            if (route.request().method() === 'POST') {
                posts += 1;
                return route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) });
            }
            return route.fulfill({ contentType: 'text/html', body: html });
        });
        const page = await context.newPage();
        await body(page, () => posts);
    } finally {
        await context.close();
    }
}

test('NotificationInstancePage: the create answer carries the uuid although the page never redirects; the redirect wait is the step that fails', async ({ browser }) => {
    await withAnswers(browser, createForm('Create Notification Instance', '/api/v1/notificationInstances'), { status: 201, body: { uuid: U1 } }, async (page) => {
        await page.goto('/administrator/#/events?tab=notification-instances');
        const instances = new NotificationInstancePage(page);
        const answer = await instances.submitCreateForm();
        expect(answer.status).toBe(201);
        expect(answer.uuid).toBe(U1);
        expect(answer.body).toEqual({ name: 'qa-reg-x' });
        expect(answer.request.method()).toBe('POST');
        expect(await failsFast(instances.waitForDetailRoute()), 'no redirect came').toBe(true);
        // The redirect arrives later: the same page object now returns the uuid of the route.
        await page.evaluate((u) => { location.hash = `#/notificationinstances/detail/${u}`; }, U1);
        expect(await instances.waitForDetailRoute()).toBe(U1);
    });
});

test('TokenPage: the create answer carries the uuid although the dialog never closes', async ({ browser }) => {
    await withAnswers(browser, createForm('Create Token', '/api/v1/tokens'), { status: 201, body: { uuid: U2, name: 'qa-reg-x' } }, async (page) => {
        await page.goto('/administrator/#/tokens');
        const tokens = new TokenPage(page);
        const answer = await tokens.submitCreateForm();
        expect(answer).toMatchObject({ status: 201, uuid: U2 });
        expect(await failsFast(tokens.waitForCreateDialogClosed(500)), 'the dialog stayed open').toBe(true);
    });
});

test('KeyPage: the key-pair create answer carries the uuid although the detail page never opens', async ({ browser }) => {
    await withAnswers(browser, createForm('Create Key', `/api/v1/tokens/${U1}/tokenProfiles/${U2}/keys/keyPair`), { status: 201, body: { uuid: U3 } }, async (page, posts) => {
        await page.goto('/administrator/#/keys');
        const keys = new KeyPage(page);
        const answer = await keys.submitCreateForm();
        expect(answer).toMatchObject({ status: 201, uuid: U3 });
        expect(posts()).toBe(1);
        expect(await failsFast(keys.waitForDetailRoute(500))).toBe(true);
    });
});

test('a refused create has no uuid and keeps the answer text; an error answer that carries a uuid keeps it', async ({ browser }) => {
    await withAnswers(browser, createForm('Create Token', '/api/v1/tokens'), { status: 422, body: ['Name must be unique'] }, async (page) => {
        await page.goto('/administrator/#/tokens');
        const answer = await new TokenPage(page).submitCreateForm();
        expect(answer.status).toBe(422);
        expect(answer.uuid).toBeUndefined();
        expect(answer.text).toContain('Name must be unique');
    });
    await withAnswers(browser, createForm('Create Token', '/api/v1/tokens'), { status: 500, body: { uuid: U2, message: 'created, then failed' } }, async (page) => {
        await page.goto('/administrator/#/tokens');
        const answer = await new TokenPage(page).submitCreateForm();
        expect(answer).toMatchObject({ status: 500, uuid: U2 });
    });
    await withAnswers(browser, createForm('Create Token', '/api/v1/tokens'), { status: 201, body: { uuid: 'not-a-uuid' } }, async (page) => {
        await page.goto('/administrator/#/tokens');
        expect((await new TokenPage(page).submitCreateForm()).uuid, 'only a canonical uuid is taken from the answer').toBeUndefined();
    });
});

test('recordUiCreate writes the ledger line before it fails a refusal; recordIfCreated records an accepted duplicate and never throws', ({}, testInfo) => {
    const saved = process.env.REG_STATE_DIR;
    process.env.REG_STATE_DIR = testInfo.outputPath('state');
    try {
        // A success: recorded once, returned as an own reference (a second call does not add a second line).
        const ok = recordUiCreate('tokens', { status: 201, uuid: U1, text: '{}' }, own('tok'), SPEC, 'own token');
        expect(ok).toEqual({ uuid: U1, name: own('tok'), kind: 'own' });
        recordUiCreate('tokens', { status: 201, uuid: U1, text: '{}' }, own('tok'), SPEC);
        expect(readLedger().filter((l) => l.uuid === U1)).toHaveLength(1);
        // A refusal with an id: the id is recorded first, then the call throws with the status and the text.
        expect(() => recordUiCreate('groups', { status: 500, uuid: U2, text: 'Internal server error.' }, own('grp'), SPEC)).toThrow(/groups create was answered 500.*recorded.*Internal server error/);
        expect(readLedger().map((l) => l.uuid)).toContain(U2);
        // A refusal without an id records nothing and says why.
        expect(() => recordUiCreate('groups', { status: 422, text: 'already exists' }, own('grp2'), SPEC)).toThrow(/answered 422: already exists/);
        // A 2xx answer without an id cannot be recorded: the failure names the object to look for.
        expect(() => recordUiCreate('groups', { status: 201, text: '' }, own('grp3'), SPEC)).toThrow(/without an id.*-grp3/);
        expect(readLedger()).toHaveLength(2);
        // A probe that expects a refusal: nothing for a plain refusal, a line for an accepted duplicate, never a throw.
        expect(recordIfCreated('roles', { status: 409, text: 'exists' }, own('role'), SPEC)).toBeUndefined();
        expect(recordIfCreated('roles', { status: 201, uuid: U3, text: '{}' }, own('role'), SPEC, 'duplicate accepted')?.uuid).toBe(U3);
        expect(readLedger().map((l) => l.type)).toEqual(['tokens', 'groups', 'roles']);
        expect(fs.existsSync(ledgerFile())).toBe(true);
    } finally {
        if (saved === undefined) delete process.env.REG_STATE_DIR;
        else process.env.REG_STATE_DIR = saved;
    }
});

test('KeyPage.watchCreates: every create of a double click is collected with its own uuid, before the redirect is judged', async ({ browser }) => {
    const U4 = '0b1e8a52-4c3f-4d6e-9a7b-1c2d3e4f5a04';
    let n = 0;
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9/' });
    try {
        await context.route('**/*', (route) => {
            if (route.request().method() === 'POST') {
                n += 1;
                return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ uuid: n === 1 ? U3 : U4 }) });
            }
            return route.fulfill({ contentType: 'text/html', body: createForm('Create Key', `/api/v1/tokens/${U1}/tokenProfiles/${U2}/keys/keyPair`) });
        });
        const page = await context.newPage();
        await page.goto('/administrator/#/keys');
        const keys = new KeyPage(page);
        const creates = keys.watchCreates();
        const first = await keys.submitCreateForm({ doubleClick: true });
        expect(first.uuid).toBe(U3);
        const every = await creates.settled();
        expect(creates.requests()).toBe(2);
        expect(every.map((a) => a.uuid).sort()).toEqual([U3, U4]);
    } finally {
        await context.close();
    }
});

test('submitRecordingByNameOnFailure: an answer that never arrives, or a 2xx without a uuid, is adopted by the run\'s own name; a refusal, a foreign name and a failing lookup are not', async ({}, testInfo) => {
    const saved = process.env.REG_STATE_DIR;
    process.env.REG_STATE_DIR = testInfo.outputPath('state');
    try {
        const name = own('named');
        const base = { type: 'groups', name, spec: SPEC, note: 'own group' };
        const found = (...uuids: string[]) => async () => ({ rows: uuids.map((uuid) => ({ uuid })) });
        // No answer at all (the create may still land): EVERY object of the name is recorded (a double click may have made two), the error
        // continues.
        await expect(submitRecordingByNameOnFailure({ ...base, lookup: found(U1, U2) }, async () => { throw new Error('no answer within 60 s'); })).rejects.toThrow(/no answer/);
        expect(readLedger().map((l) => l.uuid)).toEqual([U1, U2]);
        // A 2xx without a uuid: adopted by name, and the answer carries the recorded uuid instead of failing "without an id" later.
        const answer = await submitRecordingByNameOnFailure({ ...base, name: own('named2'), lookup: found(U3) }, async () => ({ status: 201, text: '{}' }));
        expect(answer).toMatchObject({ status: 201, uuid: U3, recordedByName: [U3] });
        expect(readLedger().map((l) => l.uuid)).toEqual([U1, U2, U3]);
        expect(recordUiCreate('groups', answer, own('named2'), SPEC).uuid, 'the normal recording path goes on with the by-name record').toBe(U3);
        // A refusal created nothing: no lookup. An answer with a uuid needs none.
        let lookups = 0;
        const counting = async () => { lookups += 1; return { rows: [{ uuid: U4 }] }; };
        await submitRecordingByNameOnFailure({ ...base, lookup: counting }, async () => ({ status: 422, text: 'refused' }));
        await submitRecordingByNameOnFailure({ ...base, lookup: counting }, async () => ({ status: 201, uuid: U1, text: '{}' }));
        expect(lookups).toBe(0);
        // A name that does not start with THIS run's id is never adopted, not even one of another run of the same family.
        for (const foreign of ['somebody-elses', 'qa-reg-20200101-000000-zzzz-group', 'qa-api-adhoc-group']) {
            await expect(submitRecordingByNameOnFailure({ ...base, name: foreign, lookup: counting }, async () => { throw new Error('boom'); })).rejects.toThrow(/boom/);
        }
        expect(lookups).toBe(0);
        // A failing lookup never masks the original error.
        await expect(submitRecordingByNameOnFailure({ ...base, lookup: async () => { throw new Error('list unreadable'); } }, async () => { throw new Error('boom'); })).rejects.toThrow(/boom/);
        expect(readLedger().map((l) => l.uuid)).toEqual([U1, U2, U3]);
    } finally {
        if (saved === undefined) delete process.env.REG_STATE_DIR;
        else process.env.REG_STATE_DIR = saved;
    }
});

test('by-name adoption checks the creation time against the server clock when the listing shows one, and says so when it cannot', async ({}, testInfo) => {
    const saved = process.env.REG_STATE_DIR;
    process.env.REG_STATE_DIR = testInfo.outputPath('state');
    try {
        const base = { type: 'keys', spec: SPEC };
        const serverNow = new Date(Date.now() + 3_600_000); // the server clock runs an hour ahead of the runner
        const iso = (msFromServerNow: number) => new Date(serverNow.getTime() + msFromServerNow).toISOString();
        // Created on the server a minute before "now": after the submit started (a moment ago) is false for it, so it is an older object.
        await expect(submitRecordingByNameOnFailure({ ...base, name: own('old'), lookup: async () => ({ rows: [{ uuid: U1, createdAt: iso(-60_000) }], serverNow, readAt: Date.now() }) }, async () => { throw new Error('boom'); })).rejects.toThrow(/boom/);
        expect(readLedger()).toHaveLength(0);
        // Created just now on the server clock: adopted (the skew between the clocks is measured, not guessed).
        await expect(submitRecordingByNameOnFailure({ ...base, name: own('new'), lookup: async () => ({ rows: [{ uuid: U2, createdAt: iso(-500) }, { uuid: U3, createdAt: iso(-60_000) }], serverNow, readAt: Date.now() }) }, async () => { throw new Error('boom'); })).rejects.toThrow(/boom/);
        expect(readLedger().map((l) => l.uuid)).toEqual([U2]);
        // No server clock: the creation time is not compared with the runner's clock; the run's own name decides.
        await expect(submitRecordingByNameOnFailure({ ...base, name: own('noclock'), lookup: async () => ({ rows: [{ uuid: U4, createdAt: '2020-01-01T00:00:00Z' }] }) }, async () => { throw new Error('boom'); })).rejects.toThrow(/boom/);
        expect(readLedger().map((l) => l.uuid)).toEqual([U2, U4]);
    } finally {
        if (saved === undefined) delete process.env.REG_STATE_DIR;
        else process.env.REG_STATE_DIR = saved;
    }
});

test('lookupKey and lookupDiscovery read every page and return every row of the exact name, with its creation time', async () => {
    const pages: Record<number, unknown[]> = {
        1: [{ uuid: U1, name: 'other', creationTime: '2026-10-22T10:00:00Z' }, { uuid: U2, name: 'wanted', creationTime: '2026-10-22T10:01:00Z' }],
        2: [{ uuid: U3, name: 'wanted', creationTime: '2026-10-22T10:02:00Z' }],
    };
    const server = await loopbackServer((a) => {
        if (a.method !== 'POST') return undefined;
        const { pageNumber } = JSON.parse(a.body) as { pageNumber: number };
        const rows = pages[pageNumber] ?? [];
        const body = a.url === '/api/v1/keys'
            ? { cryptographicKeys: rows, pageNumber, totalPages: 2 }
            : { discoveries: rows.map((r) => ({ ...(r as object), startTime: (r as { creationTime: string }).creationTime })), pageNumber, totalPages: 2 };
        return { status: 200, body };
    });
    const api = await request.newContext({ baseURL: server.origin });
    try {
        const keys = await lookupKey(api as never)('wanted');
        expect(keys.rows).toEqual([{ uuid: U2, createdAt: '2026-10-22T10:01:00Z' }, { uuid: U3, createdAt: '2026-10-22T10:02:00Z' }]);
        expect(keys.serverNow, 'the Date header of the listing is the server clock').toBeInstanceOf(Date);
        expect(server.arrived.filter((x) => x.url === '/api/v1/keys').map((x) => (JSON.parse(x.body) as { pageNumber: number }).pageNumber), 'both pages were read').toEqual([1, 2]);
        const discoveries = await lookupDiscovery(api as never)('wanted');
        expect(discoveries.rows.map((r) => r.uuid)).toEqual([U2, U3]);
        expect(discoveries.rows[0].createdAt).toBe('2026-10-22T10:01:00Z');
    } finally {
        await api.dispose();
        await server.close();
    }
});
