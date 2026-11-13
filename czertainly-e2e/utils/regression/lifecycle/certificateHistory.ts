/**
 * certificateHistory — the relations (successors, predecessors) and the event history of a certificate, oldest first, with the event codes
 * the rules use and the order check of an expected history (presence and order, never counts).
 */
import type { APIRequestContext } from '@playwright/test';
import { apiJson } from '../apiReads';
import type { JsonObject } from '../json';


export async function relationsOf(api: APIRequestContext, uuid: string): Promise<{ successors: JsonObject[]; predecessors: JsonObject[] }> {
    const body = await apiJson<{ successorCertificates?: JsonObject[]; predecessorCertificates?: JsonObject[] } | undefined>(api, 'GET', `/api/v1/certificates/${uuid}/relations`);
    return { successors: body?.successorCertificates ?? [], predecessors: body?.predecessorCertificates ?? [] };
}

export async function historyOf(api: APIRequestContext, uuid: string): Promise<JsonObject[]> {
    const rows = await apiJson<JsonObject[]>(api, 'GET', `/api/v1/certificates/${uuid}/history`);
    return sortedHistory(rows ?? []);
}

/** Oldest first by `created`; the server lists newest first, so rows with the same timestamp keep that order reversed. */
export function sortedHistory(rows: readonly JsonObject[]): JsonObject[] {
    return rows.map((r, i) => ({ r, i, t: Date.parse(String(r.created ?? '')) }))
        .sort((a, b) => (Number.isNaN(a.t) || Number.isNaN(b.t) ? b.i - a.i : a.t - b.t || b.i - a.i))
        .map((x) => x.r);
}

export const historyMessages = (rows: readonly JsonObject[]): string[] => rows.map((r) => String(r.message ?? ''));

export const EVENT_CODES: Readonly<Record<string, string>> = {
    ISSUE: 'Issue Certificate',
    REQUEST: 'Request Certificate',
    RENEW: 'Renew Certificate',
    REKEY: 'Rekey Certificate',
    REVOKE: 'Revoke Certificate',
    APPROVAL_REQUEST: 'Approve action requested',
    APPROVAL_CLOSE: 'Approve action closed',
    UPDATE_STATE: 'Update State',
};

export type HistoryStep = [event: keyof typeof EVENT_CODES, status: 'SUCCESS' | 'FAILED'];

/**
 * The problem with a history that does not carry `expected` (event / status pairs) in order, or undefined. `rows` are oldest first, as
 * `historyOf()` returns them; do not sort again.
 */
export function historyOrderProblem(rows: readonly JsonObject[], expected: readonly HistoryStep[]): string | undefined {
    const seq = rows.map((r) => `${String(r.event)}/${String(r.status)}`);
    let from = 0;
    for (const [event, status] of expected) {
        const want = `${EVENT_CODES[event]}/${status}`;
        const at = seq.indexOf(want, from);
        if (at < 0) return `missing ${want} after position ${from} in [${seq.join(', ')}]`;
        from = at + 1;
    }
    return undefined;
}
