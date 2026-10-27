/**
 * eventHistory — the reads of what an event did: the firings of an event in one scope (paged, with the objects inside a
 * firing), the trigger rows of one object, the waits for finished firings and trigger rows, the read-only gate that skips a
 * row when a platform-level trigger already listens on its events, and `assertHeldFor` for an absence over a time window.
 */
import { GuardedApi } from '../guard/types';
import { pollUntil, WaitOptions } from '../wait';
import { AssociationScope, EVENT_LABEL, EventCode } from './eventVocabulary';
import { sendJson } from './workflowRequests';
import { ApiAnswer } from '../apiReads';
import type { JsonObject } from '../json';

export interface FiringsOptions {
    event: EventCode;
    /** The overriding object whose firings are listed; omit for the platform scope of the event. */
    scope?: { resource: AssociationScope; objectUuid: string };
    page?: number;
    pageSize?: number;
    objectsPage?: number;
    objectsPageSize?: number;
}

export interface Firing {
    startedAt: string;
    finishedAt?: string | null;
    status: 'inProgress' | 'finished' | 'failed';
    resource: string;
    objectsEvaluated: number;
    objectsMatched: number;
    objectsIgnored: number;
    objectHistories: { items: JsonObject[]; itemsPerPage: number; pageNumber: number; totalPages: number; totalItems: number };
}

export interface FiringPage {
    items: Firing[];
    itemsPerPage: number;
    pageNumber: number;
    totalPages: number;
    totalItems: number;
}

/**
 * `POST /v1/workflows/events/{event}[/{resource}/{uuid}]/history`: the firings of an event in one scope, newest first, with
 * `pagination` (firings) and `objectsPagination` (objects inside a firing). A read: the guard's POST allow-list.
 */
export async function getFirings(api: GuardedApi, o: FiringsOptions): Promise<ApiAnswer & { page?: FiringPage }> {
    const path = o.scope ? `/api/v1/workflows/events/${o.event}/${o.scope.resource}/${o.scope.objectUuid}/history` : `/api/v1/workflows/events/${o.event}/history`;
    const sent = await sendJson(api, 'POST', path, {
        pagination: { itemsPerPage: o.pageSize ?? 10, pageNumber: o.page ?? 1 },
        objectsPagination: { itemsPerPage: o.objectsPageSize ?? 10, pageNumber: o.objectsPage ?? 1 },
    });
    return { ...sent, ...(sent.status === 200 ? { page: sent.json as FiringPage } : {}) };
}

/** One row of an object's own history: a trigger evaluated on it (`ObjectEventHistoryDto`). */
export interface ObjectHistoryRow {
    event: string;
    trigger: { uuid: string; name: string };
    origin?: JsonObject;
    conditionsMatched: boolean;
    actionsPerformed: boolean;
    triggeredAt: string;
    message?: string | null;
    notificationsSent?: boolean | null;
    records: Array<{ message?: string; condition?: JsonObject; execution?: JsonObject }>;
}

/** `GET /v1/workflows/events/{resource}/{uuid}/history`: the triggers evaluated on one object, newest first. */
export async function getObjectHistory(api: GuardedApi, resource: string, uuid: string, opts: { page?: number; pageSize?: number } = {}): Promise<ApiAnswer & { rows: ObjectHistoryRow[]; totalItems: number }> {
    const q = `itemsPerPage=${opts.pageSize ?? 100}&pageNumber=${opts.page ?? 1}`;
    const sent = await sendJson(api, 'GET', `/api/v1/workflows/events/${resource}/${uuid}/history?${q}`);
    const rows = (sent.json?.items ?? []) as ObjectHistoryRow[];
    return { ...sent, rows, totalItems: Number(sent.json?.totalItems ?? rows.length) };
}

/** Waits until the scope's event history holds `count` firings that are no longer in progress (fails on a `failed` firing). */
export async function waitForFinishedFirings(api: GuardedApi, o: FiringsOptions, count: number, opts: WaitOptions = {}): Promise<FiringPage> {
    return pollUntil(
        async () => {
            const r = await getFirings(api, { ...o, pageSize: Math.max(o.pageSize ?? 10, 10) });
            if (!r.page) throw new Error(`event history of ${o.event} answered ${r.status}`);
            return r.page;
        },
        (page) => {
            const failed = page.items.find((f) => f.status === 'failed');
            if (failed) throw new Error(`a firing of ${o.event} failed: ${JSON.stringify(failed).slice(0, 400)}`);
            return page.totalItems >= count && page.items.every((f) => f.status !== 'inProgress');
        },
        { what: `${count} finished firing(s) of ${o.event}`, ...opts },
    );
}

/** Pure: the firings of a page that evaluated the object `uuid` (its row in `objectHistories.items`), in page order. */
export const firingsOfObject = (page: Pick<FiringPage, 'items'>, uuid: string): Firing[] =>
    page.items.filter((f) => (f.objectHistories?.items ?? []).some((o) => o?.objectUuid === uuid));

/** Waits until an object's own history holds rows for every trigger name given (evaluated), returning all rows. */
export async function waitForTriggerRows(api: GuardedApi, resource: string, uuid: string, triggerNames: string[], opts: WaitOptions = {}): Promise<ObjectHistoryRow[]> {
    const r = await pollUntil(
        async () => (await getObjectHistory(api, resource, uuid)).rows,
        (rows) => triggerNames.every((n) => rows.some((x) => x.trigger?.name === n)),
        { what: `trigger rows ${triggerNames.join(', ')} on ${resource}`, ...opts },
    );
    return r;
}

/** Rows ordered by evaluation time, oldest first (the object history answers newest first). */
export const inEvaluationOrder = (rows: ObjectHistoryRow[]): ObjectHistoryRow[] =>
    [...rows].sort((a, b) => Date.parse(a.triggeredAt) - Date.parse(b.triggeredAt));

/**
 * Whether a PLATFORM-level trigger already listens on any of `events` (`GET /v1/settings/events`, read only). Such a trigger acts
 * on this spec's certificates too (an ignore trigger could even refuse them), so the rows that assert "nothing happened" or an
 * exact firing / history outcome skip with a named reason, as the `@local` rows do for an occupied platform list. Answers the reason,
 * or undefined when none of the events is occupied. A read that fails THROWS: the absence of a platform trigger cannot be shown,
 * and a test must not pass or skip on a settings page it could not read.
 */
export async function getPlatformTriggerGate(api: GuardedApi, events: readonly EventCode[]): Promise<string | undefined> {
    const sent = await sendJson(api, 'GET', '/api/v1/settings/events');
    if (sent.status !== 200) throw new Error(`GET /api/v1/settings/events → ${sent.status}: the platform event settings could not be read, so a platform-level trigger on the events of this row cannot be ruled out`);
    const mapping = (sent.json?.eventsMapping ?? {}) as Record<string, string[]>;
    const occupied = events.filter((e) => (mapping[e] ?? []).length > 0);
    return occupied.length ? `platform-level trigger(s) already listen on ${occupied.map((e) => EVENT_LABEL[e]).join(', ')}; the row stays out of events it does not own` : undefined;
}

/**
 * An ABSENCE over a time window ("no second run", "nothing delivered"): only the clock can show that something never happens, so the
 * window is kept, but API state is read THROUGH it every `everyMs` and `check` asserts the absence on each read. A violation fails at
 * the read that sees it, not after one long sleep, and the check runs once more at the end of the window. Returns the number of reads.
 */
export async function assertHeldFor(window: { forMs: number; everyMs: number }, check: () => Promise<void>): Promise<number> {
    let reads = 0;
    await pollUntil(
        async () => {
            await check();
            reads += 1;
        },
        () => false,
        { timeoutMs: window.forMs, intervalMs: window.everyMs, tolerateErrors: 0, onTimeout: 'return' },
    );
    return reads;
}
