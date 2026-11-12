/**
 * lifecycleTeardown — the run-end teardown handlers of the `approvals` and `approvalProfiles` ledger types (runTeardown
 * `HANDLER_MODULES` maps both to this module). Approvals are never deleted by the
 * platform and an approval profile with approvals cannot be deleted: both are reported as kept, never left silently.
 */
import { apiJson } from '../apiReads';
import { guardApi } from '../guard/createGuard';
import type { JsonObject } from '../json';
import { checkOwnership } from '../ledger/ownership';
import type { TeardownHandler } from '../teardown/runTeardown';
import { pollUntil } from '../wait';
import { sameApprovalStatus } from './approvals';
import { sendRaw } from './rawAnswers';

// ------------------------------------------------------------------ teardown handlers (runTeardown HANDLER_MODULES → lifecycle)

const EXISTING_APPROVALS = /existing approvals/i;

/**
 * `approvals` (step 1 of the teardown order): a Pending approval of an own certificate is REJECTED through the override
 * path (the certificate then leaves `pending_approval`); approvals are never deleted by the platform, so the line is
 * reported as kept with its final status. `approvalProfiles` (step 12): its remaining associations on own RA profiles
 * are removed, then the delete is attempted; a profile that has approvals cannot be deleted (core
 * ApprovalProfileServiceImpl) and is reported as kept, naming the rule. Both send their mutations through the guard
 * (`guardApi` over the teardown's context: ledger lines of this run, dry run honoured).
 */
export const teardownHandlers: Record<string, TeardownHandler> = {
    approvals: {
        action: 'reject through the override path when still Pending; approvals are retained by the platform (kept, reported)',
        async remove(ctx, line) {
            // The guard over the teardown's own context (never disposed here: the context serves every object).
            const api = guardApi(ctx.api);
            const detail = await apiJson<JsonObject>(api, 'GET', `/api/v1/approvals/${line.uuid}`);
            if (sameApprovalStatus(detail.status, 'Pending')) {
                const a = await sendRaw(api, 'PATCH', `/api/v1/approvals/${line.uuid}/reject`);
                if (a.status !== 204) throw new Error(`approval ${line.uuid}: override reject answered ${a.status}: ${a.text.slice(0, 200)}`);
                ctx.warn(`kept approval ${line.uuid}: was Pending, rejected through the override path; the platform retains approvals`);
            } else {
                ctx.warn(`kept approval ${line.uuid}: status ${String(detail.status)}; the platform retains approvals`);
            }
            return 'kept';
        },
    },
    approvalProfiles: {
        action: 'remove its associations on own RA profiles, then DELETE /v1/approvalProfiles/{uuid}; a profile with approvals cannot be deleted (kept, reported)',
        async remove(ctx, line) {
            const api = guardApi(ctx.api);
            {
                const associations = await apiJson<JsonObject[]>(api, 'GET', `/api/v1/approvalProfiles/${line.uuid}/associations`).catch(() => [] as JsonObject[]);
                for (const a of associations ?? []) {
                    const raUuid = String(a.objectUuid ?? a.uuid ?? '');
                    const own = checkOwnership({ uuid: raUuid });
                    if (own.own && own.line?.type === 'raProfiles') {
                        const d = await sendRaw(api, 'DELETE', `/api/v1/approvalProfiles/${line.uuid}/associations/raProfiles/${raUuid}`);
                        if (d.status !== 204 && d.status !== 404) throw new Error(`approval profile ${line.uuid}: dissociating RA profile ${raUuid} answered ${d.status}`);
                    } else {
                        ctx.warn(`approval profile ${line.uuid}: association with ${String(a.resource ?? 'object')} ${raUuid} is not this run's; left as is`);
                    }
                }
                const del = await sendRaw(api, 'DELETE', `/api/v1/approvalProfiles/${line.uuid}`);
                if (del.status === 422 && EXISTING_APPROVALS.test(del.text)) {
                    ctx.warn(`kept approval profile ${line.uuid}: the platform refuses to delete an approval profile with approvals ("Unable to delete approval profile with existing approvals.")`);
                    return 'kept';
                }
                if (del.status !== 204 && del.status !== 200) throw new Error(`approval profile ${line.uuid}: DELETE answered ${del.status}: ${del.text.slice(0, 200)}`);
                const gone = await pollUntil(
                    async () => (await ctx.api.get(`/api/v1/approvalProfiles/${line.uuid}`)).status() === 404,
                    (absent) => absent,
                    { attempts: 5, timeoutMs: Number.POSITIVE_INFINITY, intervalMs: ctx.pollMs ?? 1000, tolerateErrors: 0, onTimeout: 'return' },
                );
                if (gone) return;
                throw new Error(`approval profile ${line.uuid}: the delete was answered but the detail still answers; absence not proven`);
            }
        },
    },
};
