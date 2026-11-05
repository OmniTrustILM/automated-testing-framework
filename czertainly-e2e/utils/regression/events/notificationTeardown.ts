/**
 * notificationTeardown — run-end teardown of the own notification profiles and instances: deleted only after the own-object check, absence
 * proven by a read; profiles go before instances (core refuses to delete an instance a profile still uses).
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

export const teardownHandlers: Record<string, TeardownHandler> = {
    notificationProfiles: notificationObject('/api/v1/notificationProfiles', 'notification profile'),
    notificationInstances: notificationObject('/api/v1/notificationInstances', 'notification instance'),
};
