/**
 * Run-end teardown handlers of the inventory types named by id: saved list views and OID registry entries. runTeardown
 * loads them through HANDLER_MODULES; each handler proves the live object is this run's before it deletes it (through
 * the guard) and proves it is gone afterwards. OID entries are removed on a proven local stack only.
 */
import type { APIRequestContext } from '@playwright/test';
import { assertNotDryRun } from '../run/flags';
import { guardApi } from '../guard/createGuard';
import { carriesRunPrefix, LiveObjectMissing, OwnObjectViolation } from '../ledger/ownership';
import { LedgerLine, ledgerKeyProblem } from '../ledger/ledger';
import type { TeardownContext, TeardownHandler } from '../teardown/runTeardown';
import { hasLocalProof } from '../tier/localProof';
import { isLocalTier } from '../tier/kind';
import { pollUntil } from '../wait';

type Json = Record<string, any>;

/** The absence poll of both handlers: five reads, `ctx.pollMs` apart (1 s), the first error raised. */
const absencePoll = (ctx: TeardownContext) => ({ attempts: 5, intervalMs: ctx.pollMs ?? 1000, timeoutMs: 60_000, tolerateErrors: 0, onTimeout: 'return' as const });

/** The caller's saved views (`GET /v1/listViews`), or a thrown error when the answer proves nothing. */
async function listViews(api: APIRequestContext): Promise<Json[]> {
    const res = await api.get('/api/v1/listViews');
    if (!res.ok()) throw new Error(`GET /api/v1/listViews answered ${res.status()}: the saved views cannot be read`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body) || !body.every((r) => typeof (r as Json | null)?.uuid === 'string')) throw new Error('GET /api/v1/listViews did not answer a list of views; it proves nothing');
    return body as Json[];
}

const listed = (rows: Json[], uuid: string): Json | undefined => rows.find((r) => String(r.uuid).toLowerCase() === uuid.toLowerCase());

const savedViews: TeardownHandler = {
    action: 'delete own view (DELETE /api/v1/listViews/{uuid}) after its live run-prefixed name in the caller\'s list; absence proven by the list',
    async remove(ctx: TeardownContext, line: LedgerLine) {
        assertNotDryRun(`teardown.savedViews ${line.uuid}`);
        const row = listed(await listViews(ctx.api), line.uuid);
        if (!row) {
            if (ctx.seen.has(line.uuid)) return; // the first attempt removed it
            throw new LiveObjectMissing('savedViews', line.uuid, 'not in the caller\'s list of views');
        }
        if (typeof row.name !== 'string' || !carriesRunPrefix(row.name, ctx.runId)) {
            throw new OwnObjectViolation('teardown.savedViews', line, `its live name does not start with ${ctx.runId}-`, 'savedViews');
        }
        ctx.seen.add(line.uuid);
        const del = await guardApi(ctx.api).delete(`/api/v1/listViews/${line.uuid}`, { failOnStatusCode: false });
        if (!del.ok() && del.status() !== 404) throw new Error(`saved view ${line.uuid}: DELETE answered ${del.status()} - ${(await del.text()).slice(0, 300)}`);
        const still = await pollUntil(async () => listed(await listViews(ctx.api), line.uuid), (row) => !row, absencePoll(ctx));
        if (!still) return;
        throw new Error(`saved view ${line.uuid}: the delete was answered but the list still names it: not deleted (absence not proven)`);
    },
};

const oidEntries: TeardownHandler = {
    action: 'local stack only: delete own OID entry (DELETE /api/v1/oids/{oid}) after its live run-prefixed displayName; absence proven by GET',
    async remove(ctx: TeardownContext, line: LedgerLine) {
        assertNotDryRun(`teardown.oidEntries ${line.uuid}`);
        if (!isLocalTier() || !hasLocalProof()) {
            throw new OwnObjectViolation('teardown.oidEntries', line, 'the OID registry is platform-level: an oidEntries line is removed on a proven local stack only', 'oidEntries', 'request');
        }
        const keyProblem = line.key === undefined ? 'the line carries no OID' : ledgerKeyProblem('oidEntries', line.uuid, line.key);
        if (keyProblem) throw new OwnObjectViolation('teardown.oidEntries', line, keyProblem, 'oidEntries', 'request');
        const url = `/api/v1/oids/${line.key}`;
        const res = await ctx.api.get(url);
        if (res.status() === 404) {
            if (ctx.seen.has(line.uuid)) return;
            throw new LiveObjectMissing('oidEntries', line.uuid, 'GET answered 404');
        }
        if (!res.ok()) throw new Error(`OID entry ${line.uuid}: GET answered ${res.status()}`);
        const live = (await res.json()) as Json;
        if (typeof live?.displayName !== 'string' || !carriesRunPrefix(live.displayName, ctx.runId) || live.oid !== line.key) {
            throw new OwnObjectViolation('teardown.oidEntries', line, `its live displayName does not start with ${ctx.runId}- (or the entry answers another OID)`, 'oidEntries');
        }
        ctx.seen.add(line.uuid);
        const del = await guardApi(ctx.api, { localStack: true }).delete(url, { failOnStatusCode: false });
        if (!del.ok() && del.status() !== 404) throw new Error(`OID entry ${line.uuid}: DELETE answered ${del.status()} - ${(await del.text()).slice(0, 300)}`);
        const status = await pollUntil(async () => (await ctx.api.get(url)).status(), (s) => s === 404, absencePoll(ctx));
        if (status === 404) return;
        throw new Error(`OID entry ${line.uuid}: the delete was answered but the detail still answers: not deleted (absence not proven)`);
    },
};

/** The raw handlers; runTeardown wraps each with wrapHandlerWithGuard when it loads this module. */
export const teardownHandlers: Record<string, TeardownHandler> = { savedViews, oidEntries };
