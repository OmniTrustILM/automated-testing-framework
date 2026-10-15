/**
 * notifRig — the shared rig of the `@local:notif` delivery rows (REG-WFL-25 / 27 / 29): an own RA profile, an own group and owner, one
 * own issued certificate in that group, and ONE trigger on `Certificate status changed` (associated on the own group) whose single
 * execution sends the given notification profiles; a revoke of the certificate fires it (revoke raises the status change: T14 W34).
 * Object level only — nothing is associated at platform level — and every object is own and ledgered. Delivery goes to the local
 * catchers (utils/regression/catchers.ts); nothing leaves the stack.
 */
import { GuardedApi } from './guardedApi';
import {
    createOwnGroup, createOwnRaProfileOrSkip, issueOwnCertificateInGroup, OwnCertificate, OwnRa, revokeOwnCertificate,
} from './eventsDrivers';
import { createOwnUser } from './regressionApi';
import { OwnRef } from './regressionRun';
import {
    associateTriggers, createOwnAction, createOwnExecution, createOwnTrigger, EVENT, sendNotificationItem, waitForFinishedFirings, waitForTriggerRows, ObjectHistoryRow,
} from './workflowApi';

export interface Rig {
    ra: OwnRa;
    group: OwnRef;
    owner: OwnRef;
    ownerEmail: string;
    cert: OwnCertificate;
}

/** The address of an own user / group / role: `<name>@example.test` (reserved, RFC 6761: only the local catcher ever sees it). */
export const addressOf = (name: string): string => `${name}@example.test`;

/** RA profile, group (with a contact e-mail), owner (with an e-mail) and one issued certificate in the group owned by the owner. */
export async function buildRig(api: GuardedApi, spec: string, suffix: string, skip: (reason: string) => void): Promise<Rig> {
    const ra = await createOwnRaProfileOrSkip(api, spec, `${suffix}-ra`, skip);
    const owner = await createOwnUser(api, `${suffix}-owner`, spec, { email: addressOf(`${suffix}-owner`) });
    const group = await createOwnGroup(api, spec, `${suffix}-group`, { email: addressOf(`${suffix}-group`) });
    const cert = await issueOwnCertificateInGroup(api, spec, ra, group, owner, `${suffix}-cert`);
    return { ra, group, owner, ownerEmail: addressOf(`${suffix}-owner`), cert };
}

/** One trigger (event Certificate status changed) with ONE execution sending every profile; associated on the rig's group. */
export async function armGroup(api: GuardedApi, spec: string, rig: Pick<Rig, 'group'>, suffix: string, profiles: OwnRef[]): Promise<{ triggerName: string; triggerUuid: string }> {
    const execution = await createOwnExecution(api, spec, { suffix: `${suffix}-e`, type: 'sendNotification', items: profiles.map((p) => sendNotificationItem(p.uuid)) });
    const action = await createOwnAction(api, spec, { suffix: `${suffix}-a`, executions: [execution] });
    const trigger = await createOwnTrigger(api, spec, { suffix: `${suffix}-t`, event: EVENT.statusChanged, actions: [action] });
    const sent = await associateTriggers(api, spec, { event: EVENT.statusChanged, resource: 'groups', object: rig.group, triggers: [trigger] });
    if (sent.status >= 300) throw new Error(`associate on the group → ${sent.status} ${sent.text.slice(0, 300)}`);
    return { triggerName: trigger.name, triggerUuid: trigger.uuid };
}

/** Revokes the rig's certificate and returns the trigger's history row on it once the firing finished. */
export async function fire(api: GuardedApi, rig: Rig, armed: { triggerName: string }): Promise<ObjectHistoryRow> {
    const revoked = await revokeOwnCertificate(api, rig.ra, rig.cert);
    if (revoked.status >= 300) throw new Error(`revoke → ${revoked.status} ${revoked.text.slice(0, 300)}`);
    await waitForFinishedFirings(api, { event: EVENT.statusChanged, scope: { resource: 'groups', objectUuid: rig.group.uuid } }, 1, { timeoutMs: 180_000 });
    const rows = await waitForTriggerRows(api, 'certificates', rig.cert.uuid, [armed.triggerName], { timeoutMs: 180_000 });
    return rows.find((r) => r.trigger.name === armed.triggerName)!;
}
