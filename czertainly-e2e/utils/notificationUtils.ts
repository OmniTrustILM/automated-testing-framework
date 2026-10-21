/**
 * notificationUtils — how the run-end teardown removes the notification objects the events area creates (own objects only, deleted at run end).
 *
 * runTeardown's registry (HANDLER_MODULES) loads this module for the ledger types `notificationProfiles` and
 * `notificationInstances` and wraps each handler with `wrapHandlerWithGuard` (dry-run check, then `assertOwnLive`: ledger line of this
 * run on this tier and a live run-prefixed name). Spec-facing helpers live in utils/regression/notificationApi.ts (the
 * deny-by-default lint lets a spec import only create / find / get / list / wait / generate / upload / ensure names from a
 * `utils/*Utils` module).
 *
 * Order (DELETE_ORDER step 8): profiles before instances. Core refuses to delete an instance a profile's CURRENT version
 * still uses ("Cannot delete notification instance. Notification profile(s) referencing this notification instance: …")
 * and a profile an execution still uses (executions are removed in step 7, before this step).
 */
import type { LedgerLine } from './regression/ledger/ledger';
import type { TeardownContext, TeardownHandler } from './regression/teardown/runTeardown';
import { deleteAndVerify } from './regression/teardown/teardownHandlers';

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
