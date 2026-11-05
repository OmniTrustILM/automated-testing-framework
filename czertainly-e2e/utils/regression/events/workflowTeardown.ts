/**
 * workflowTeardown — run-end teardown of the workflow objects the events area creates (own objects only).
 *
 * Handles triggers, rules, conditions, executions, actions and eventAssociations.
 *   - Deletes in the order associations, triggers, rules, conditions, actions, executions, because core refuses to delete a
 *     part another part still references (actions BEFORE executions, else the run ends red).
 *   - Sends a DELETE only for an object read with 200 in this step, and proves absence with a detail GET (404).
 *   - An `eventAssociations` line has no object to read. A `platform` line is only checked (read-only) that none of the run's
 *     triggers is still bound platform-wide; for an own object the scope is cleared and proven.
 */
import type { LedgerLine } from '../ledger/ledger';
import { checkOwnership } from '../ledger/ownership';
import type { TeardownContext, TeardownHandler } from '../teardown/teardownTypes';
import { deleteAndVerify } from '../teardown/teardownHandlers';

const parentOf = (line: LedgerLine, key: string): string | undefined => {
    const v = line.parents?.[key];
    return Array.isArray(v) ? v[0] : v;
};

/** DELETE `/api/v1/workflows/<kind>/<uuid>`; the same URL proves absence. */
const workflowObject = (kind: string, what: string): TeardownHandler => ({
    action: `delete (DELETE /v1/workflows/${kind}/{uuid}), absence proven by GET`,
    async remove(ctx: TeardownContext, line: LedgerLine) {
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `${what} ${line.uuid}`, detailUrl: `/api/v1/workflows/${kind}/${line.uuid}` });
    },
});

/** `<event>|<resource>|<object uuid> <free text>` (eventAssociations.associationKey) → the event and resource of a line. */
export function parseAssociationNote(note: string | undefined): { event: string; resource: string; objectUuid: string } | undefined {
    const key = (note ?? '').split(' ')[0];
    const [event, resource, objectUuid] = key.split('|');
    return event && resource && objectUuid ? { event, resource, objectUuid } : undefined;
}

async function readAssociations(ctx: TeardownContext, resource: string, objectUuid: string): Promise<Record<string, string[]>> {
    const res = await ctx.api.get(`/api/v1/workflows/events/${resource}/${objectUuid}`);
    if (!res.ok()) throw new Error(`GET /v1/workflows/events/${resource}/${objectUuid} answered ${res.status()}`);
    return ((await res.json()) ?? {}) as Record<string, string[]>;
}

const eventAssociations: TeardownHandler = {
    action: 'clear the (event, resource, object) trigger list of an own object (POST /v1/workflows/events with an empty list), proven by the association map',
    async remove(ctx: TeardownContext, line: LedgerLine) {
        const parsed = parseAssociationNote(line.note);
        const objectUuid = parentOf(line, 'object');
        if (!parsed) throw new Error(`association ${line.uuid}: the ledger line names no (event, resource, object); not touched`);
        if (parsed.resource === 'platform') {
            // Never cleared here (a platform-wide replace is a @local spec's own step, with its restore): only proven absent, read-only.
            const res = await ctx.api.get('/api/v1/settings/events');
            if (!res.ok()) throw new Error(`GET /v1/settings/events answered ${res.status()}`);
            const listed = ((((await res.json()) ?? {}) as { eventsMapping?: Record<string, string[]> }).eventsMapping?.[parsed.event] ?? []) as string[];
            const ours = listed.filter((trigger) => checkOwnership({ uuid: trigger }, { lines: ctx.ledger, runId: ctx.runId }).own);
            if (!ours.length) return; // none of this run's triggers is bound platform-wide: nothing to clear
            throw new Error(`association ${line.uuid}: ${ours.length} trigger(s) of this run are still bound to ${parsed.event} platform-wide; a platform-level association is restored by its @local spec, never cleared by the teardown`);
        }
        if (!objectUuid || parsed.objectUuid !== objectUuid) {
            throw new Error(`association ${line.uuid}: the ledger line names no (event, resource, object); not touched`);
        }
        const before = ((await readAssociations(ctx, parsed.resource, objectUuid))[parsed.event] ?? []) as string[];
        if (!before.length) return; // nothing left: the scope was cleared (or its object deleted) already
        const own = checkOwnership({ uuid: objectUuid }, { lines: ctx.ledger, runId: ctx.runId });
        if (!own.own) throw new Error(`association ${line.uuid}: the scope object ${objectUuid} is not a live object of this run (${own.reason}); not cleared`);
        for (const trigger of before) {
            const t = checkOwnership({ uuid: trigger }, { lines: ctx.ledger, runId: ctx.runId });
            if (!t.own) throw new Error(`association ${line.uuid}: the scope lists trigger ${trigger}, which this run did not create (${t.reason}); not cleared`);
        }
        const res = await ctx.api.post('/api/v1/workflows/events', { data: { event: parsed.event, resource: parsed.resource, objectUuid, triggerUuids: [] } });
        if (!res.ok()) throw new Error(`Failed to clear the ${parsed.event} association of ${parsed.resource} ${objectUuid}: ${res.status()} - ${(await res.text()).slice(0, 300)}`);
        const after = ((await readAssociations(ctx, parsed.resource, objectUuid))[parsed.event] ?? []) as string[];
        if (after.length) throw new Error(`association ${line.uuid}: the scope still lists ${after.length} trigger(s) after the clear (absence not proven)`);
    },
};

/** The raw handlers; runTeardown wraps each with wrapHandlerWithGuard when it loads this module. */
export const teardownHandlers: Record<string, TeardownHandler> = {
    triggers: workflowObject('triggers', 'trigger'),
    rules: workflowObject('rules', 'rule'),
    conditions: workflowObject('conditions', 'condition'),
    executions: workflowObject('executions', 'execution'),
    actions: workflowObject('actions', 'action'),
    eventAssociations,
};
