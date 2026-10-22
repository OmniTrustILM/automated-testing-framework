/**
 * uiCreates — the ledger line of an object a UI form created, written from the form's ANSWER.
 *
 * WHAT: `recordUiCreate` takes what a page object's `submit…` method returned (`status`, `uuid`, `text`), appends the
 * `created` line when the answer carries a uuid, and only then fails when the platform refused (or answered without an id).
 * `recordIfCreated` is the same line for a probe that EXPECTS a refusal: it records an accepted duplicate and never throws.
 * WHY: the object is on a shared tier from the moment the platform answered. The line is therefore written before the spec
 * waits for the form's redirect, reads a list or asserts anything: a timeout after a successful create must not leave an
 * object the teardown cannot name. A refusal that still carries a uuid (an accepted duplicate) is recorded too.
 * `submitRecordingByNameOnFailure` is the safety net around the submit: when no answer arrives in time (the create may still land
 * later) or a 2xx answer carries no uuid, every object of the exact name this run may own is looked up and recorded before the error continues.
 * HOW: a spec calls it right after `submit…`, with the answer and the object's name; it returns the `OwnRef`
 * (`recordCreated`'s result) for the steps after it. An object already in the ledger (this run) is not recorded twice.
 */
import type { APIRequestContext } from '@playwright/test';
import { Logger } from '../../Logger';
import { currentRunId } from '../run/runId';
import { checkOwnership } from './ownership';
import { LedgerLine, OwnRef, recordCreated } from './ledger';

const logger = new Logger('uiCreates');

/** The part of a create answer this module reads (a page object's `CreateAnswer` fits). */
export interface UiCreateAnswer {
    status: number;
    uuid?: string;
    text: string;
}

const SHOWN_TEXT = 300;

/** Records the object a form created, when the answer carries a uuid (whatever the status); returns it, or undefined. */
export function recordIfCreated(type: string, answer: UiCreateAnswer, name: string, spec: string, note?: string, parents?: LedgerLine['parents']): OwnRef | undefined {
    if (answer.uuid === undefined) return undefined;
    return checkOwnership({ uuid: answer.uuid }).own
        ? { uuid: answer.uuid, name, kind: 'own' }
        : recordCreated(type, { uuid: answer.uuid, name }, { spec, note, parents });
}

/**
 * Records the object a form created, then fails when the answer was not a success.
 * @throws when the status is not 2xx, or a 2xx answer carries no uuid; the message names the status and the answer text.
 */
export function recordUiCreate(type: string, answer: UiCreateAnswer, name: string, spec: string, note?: string, parents?: LedgerLine['parents']): OwnRef {
    const ref = recordIfCreated(type, answer, name, spec, note, parents);
    if (answer.status < 200 || answer.status >= 300) {
        throw new Error(`the ${type} create was answered ${answer.status}${ref ? ' (and returned an id, which is recorded)' : ''}: ${answer.text.slice(0, SHOWN_TEXT)}`);
    }
    if (!ref) throw new Error(`the ${type} create was answered ${answer.status} without an id, so nothing could be recorded: look for ${name} on the tier by hand. ${answer.text.slice(0, SHOWN_TEXT)}`);
    return ref;
}

/** One object of a listing that carries the name looked for. */
export interface NamedRow {
    uuid: string;
    /** The creation time the listing shows for it (an ISO timestamp), when it shows one. */
    createdAt?: string;
}

/** What a by-name lookup read: EVERY row with the exact name, and the server's clock at the read (its `Date` header) when it sent one. */
export interface NamedLookupResult {
    rows: NamedRow[];
    serverNow?: Date;
    /** The runner's clock (ms) right when the response carrying `serverNow` arrived: the skew between the two clocks is `serverNow - readAt`. */
    readAt?: number;
}

/** Finds every object carrying an exact name on the tier. */
export type NamedLookup = (name: string) => Promise<NamedLookupResult>;

const serverClock = (res: { headers(): Record<string, string> }): Date | undefined => {
    const t = Date.parse(res.headers().date ?? '');
    return Number.isNaN(t) ? undefined : new Date(t);
};

const rowOf = (r: Record<string, unknown>, createdKey?: string): NamedRow => ({
    uuid: String(r.uuid),
    ...(createdKey && typeof r[createdKey] === 'string' ? { createdAt: r[createdKey] as string } : {}),
});

/** A lookup in a full GET list endpoint (`key` is the name field of its rows, `name` by default; `createdKey` the creation-time field when the rows have one). */
export const lookupInList = (api: APIRequestContext, listUrl: string, key = 'name', createdKey?: string): NamedLookup => async (name) => {
    const res = await api.get(listUrl);
    const readAt = Date.now();
    if (!res.ok()) throw new Error(`GET ${listUrl} answered ${res.status()}`);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) throw new Error(`GET ${listUrl} did not answer a list`);
    return { rows: rows.filter((r) => r[key] === name && r.uuid !== undefined).map((r) => rowOf(r, createdKey)), serverNow: serverClock(res), readAt: readAt };
};

/** The most pages a paged lookup reads (1000 rows each): a bound against a runaway listing, reported when it is hit. */
const MAX_LOOKUP_PAGES = 50;
const PAGE_SIZE = 1000;

/** Reads EVERY page of a listing (`readPage` answers one page) and keeps the rows with the exact name. */
async function everyPage(
    readPage: (pageNumber: number) => Promise<{ status: number; ok: boolean; json: Record<string, unknown>; res: { headers(): Record<string, string> }; receivedAt: number }>,
    label: string, rowsOf: (page: Record<string, unknown>) => Array<Record<string, unknown>>, name: string, createdKey?: string,
): Promise<NamedLookupResult> {
    const rows: NamedRow[] = [];
    let serverNow: Date | undefined;
    let readAt: number | undefined;
    for (let pageNumber = 1; pageNumber <= MAX_LOOKUP_PAGES; pageNumber++) {
        const page = await readPage(pageNumber);
        if (!page.ok) throw new Error(`${label} answered ${page.status}`);
        if (serverNow === undefined) {
            serverNow = serverClock(page.res);
            readAt = page.receivedAt; // taken next to the first response, not after the whole lookup
        }
        rows.push(...rowsOf(page.json).filter((r) => r.name === name && r.uuid !== undefined).map((r) => rowOf(r, createdKey)));
        const totalPages = Number(page.json.totalPages ?? 1);
        if (pageNumber >= totalPages) return { rows, serverNow, readAt };
    }
    logger.warn(`${label}: stopped after ${MAX_LOOKUP_PAGES} pages; later rows were not read`);
    return { rows, serverNow, readAt };
}

/** Lookups in the two listings that are searched with a POST (the guard admits these literal read paths): keys and discoveries; every page is read. */
export const lookupKey = (api: APIRequestContext): NamedLookup => (name) =>
    everyPage(async (pageNumber) => {
        const res = await api.post('/api/v1/keys', { data: { itemsPerPage: PAGE_SIZE, pageNumber, filters: [] } });
        return { status: res.status(), ok: res.ok(), receivedAt: Date.now(), json: res.ok() ? ((await res.json()) as Record<string, unknown>) : {}, res };
    }, 'POST /api/v1/keys', (p) => (p.cryptographicKeys as Array<Record<string, unknown>> | undefined) ?? [], name, 'creationTime');

export const lookupDiscovery = (api: APIRequestContext): NamedLookup => (name) =>
    everyPage(async (pageNumber) => {
        const res = await api.post('/api/v1/discoveries/list', { data: { itemsPerPage: PAGE_SIZE, pageNumber, filters: [] } });
        return { status: res.status(), ok: res.ok(), receivedAt: Date.now(), json: res.ok() ? ((await res.json()) as Record<string, unknown>) : {}, res };
    }, 'POST /api/v1/discoveries/list', (p) => (p.discoveries as Array<Record<string, unknown>> | undefined) ?? [], name, 'startTime');

/** A lookup in a GET list that answers pages (notification profiles): `rowsOf` takes the rows out of one page; every page is read. */
export const lookupInPagedGet = (api: APIRequestContext, listUrl: string, rowsOf: (page: Record<string, unknown>) => Array<Record<string, unknown>>): NamedLookup => (name) =>
    everyPage(async (pageNumber) => {
        const res = await api.get(`${listUrl}${listUrl.includes('?') ? '&' : '?'}itemsPerPage=${PAGE_SIZE}&pageNumber=${pageNumber}`);
        return { status: res.status(), ok: res.ok(), receivedAt: Date.now(), json: res.ok() ? ((await res.json()) as Record<string, unknown>) : {}, res };
    }, `GET ${listUrl}`, rowsOf, name);

export interface NamedRecording {
    type: string;
    /** The run-prefixed name the object is created under: it must start with `<this run's id>-`. */
    name: string;
    spec: string;
    note?: string;
    parents?: LedgerLine['parents'];
    lookup: NamedLookup;
}

/** The creation-time tolerance between the runner's and the server's clocks once the skew is measured. */
const CLOCK_MARGIN_MS = 2_000;

/**
 * The rows of a lookup that this run may adopt: the name starts with the run's own id (checked by the caller), and where the listing shows a
 * creation time it is not before the submit started (the server clock from the `Date` header when it came; else that check is skipped and the
 * log says so, because a runner clock must not be compared with a server time).
 */
function adoptable(result: NamedLookupResult, submitStartedAt: number, label: string): NamedRow[] {
    const skew = result.serverNow && result.readAt !== undefined ? result.serverNow.getTime() - result.readAt : undefined;
    return result.rows.filter((row) => {
        if (row.createdAt === undefined) return true;
        const created = Date.parse(row.createdAt);
        if (Number.isNaN(created) || skew === undefined) {
            logger.info(`${label}: the creation time of ${row.uuid} was not checked (${skew === undefined ? 'the server sent no clock' : 'unreadable timestamp'}); adopted by the run's own name only`);
            return true;
        }
        const startedOnServer = submitStartedAt + skew - CLOCK_MARGIN_MS;
        if (created < startedOnServer) {
            logger.warn(`${label}: ${row.uuid} carries the run's name but was created before this submit started; not adopted`);
            return false;
        }
        return true;
    });
}

/**
 * Runs `submit` (the click on Create and the wait for its answer). If it throws (no answer arrived, so the create may still land) or
 * the answer is a 2xx without a uuid, EVERY object of the exact name this run may own (the name starts with the run's id, and a listed
 * creation time is not before the submit) is recorded in a `finally`, before the error continues. A 4xx or 5xx answer without a uuid created
 * nothing and costs no lookup; a failing lookup never masks the original error. When the answer was a 2xx without a uuid and an object
 * was recorded by name, the returned answer carries that uuid (and `recordedByName`), so the spec goes on instead of failing "without an id".
 */
export async function submitRecordingByNameOnFailure<T extends UiCreateAnswer>(o: NamedRecording, submit: () => Promise<T>): Promise<T & { recordedByName?: string[] }> {
    const startedAt = Date.now();
    let answer: T | undefined;
    let recorded: string[] = [];
    try {
        answer = await submit();
    } finally {
        const unanswered = answer === undefined;
        const withoutId = answer !== undefined && answer.uuid === undefined && answer.status >= 200 && answer.status < 300;
        if ((unanswered || withoutId) && o.name.startsWith(`${currentRunId()}-`)) recorded = await adoptByName(o, startedAt);
    }
    if (recorded.length && answer !== undefined && answer.uuid === undefined) {
        logger.info(`the ${o.type} create answered ${answer.status} without a uuid; recorded by name instead: ${recorded.join(', ')}`);
        return { ...answer, uuid: recorded[0], recordedByName: recorded };
    }
    return answer;
}

/** Looks every object of `o.name` up and records those this run may adopt; returns their uuids. Never throws. */
async function adoptByName(o: NamedRecording, startedAt: number): Promise<string[]> {
    const label = `${o.type} ${o.name}`;
    try {
        const found = adoptable(await o.lookup(o.name), startedAt, label);
        for (const row of found) {
            if (!checkOwnership({ uuid: row.uuid }).own) {
                recordCreated(o.type, { uuid: row.uuid, name: o.name }, { spec: o.spec, note: `${o.note ?? o.type} (found by name: the create answer did not carry its uuid)`, parents: o.parents });
            }
        }
        return found.map((r) => r.uuid);
    } catch (e) {
        logger.warn(`the by-name lookup of ${label} failed (${String(e).split('\n')[0].slice(0, 120)}); look for it by hand`);
        return [];
    }
}
