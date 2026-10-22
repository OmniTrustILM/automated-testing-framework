/**
 * notificationTeardown — how the run-end teardown removes the notification objects the events area creates (own objects only, deleted at run end).
 *
 * WHAT: the teardown handlers of the ledger types `notificationProfiles` and `notificationInstances`. The resource-type
 * registry names this module for them, and runTeardown wraps each handler with `wrapHandlerWithGuard` (dry-run check, then
 * `assertOwnLive`: ledger line of this run on this tier and a live run-prefixed name). Spec-facing helpers live in
 * utils/regression/events/notificationInstances.ts and notificationProfiles.ts.
 *
 * WHY: a notification object is deleted only after the live check proved it this run's, and its absence is proven by a read.
 *
 * HOW: order (teardown step 9): profiles before instances. Core refuses to delete an instance a profile's CURRENT version
 * still uses ("Cannot delete notification instance. Notification profile(s) referencing this notification instance: …")
 * and a profile an execution still uses (executions are removed in step 8, before this step).
 */
import type { LedgerLine } from '../ledger/ledger';
import type { TeardownContext, TeardownHandler } from '../teardown/teardownTypes';
import { deleteAndVerify } from '../teardown/teardownHandlers';

const notificationObject = (path: string, what: string): TeardownHandler => ({
    action: `delete (DELETE ${path}/{uuid}), absence proven by GET`,
    async remove(ctx: TeardownContext, line: LedgerLine) {
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `${what} ${line.uuid}`, detailUrl: `${path}/${line.uuid}` });
    },
});

/** The raw handlers; runTeardown wraps each with wrapHandlerWithGuard when it loads this module. */
export const teardownHandlers: Record<string, TeardownHandler> = {
    notificationProfiles: notificationObject('/api/v1/notificationProfiles', 'notification profile'),
    notificationInstances: notificationObject('/api/v1/notificationInstances', 'notification instance'),
};
