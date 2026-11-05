/**
 * notificationTeardown — the run-end teardown of the notification objects the events area creates (own objects only).
 *
 * Handles the ledger types `notificationProfiles` and `notificationInstances`. An object is deleted only after the own-object
 * check (a ledger line of this run and a live run-prefixed name), and its absence is proven by a read.
 *
 * Profiles go before instances (teardown step 9): core refuses to delete an instance a profile still uses, and a profile an
 * execution still uses (executions go in step 8).
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
