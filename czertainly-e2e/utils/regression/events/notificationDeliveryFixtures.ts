/**
 * notificationDeliveryFixtures — the own objects the `@local` delivery rows need: an own RA profile, group and owner, one own
 * certificate in that group, and ONE trigger on `Certificate status changed` (associated on the own group) whose execution
 * sends the given notification profiles; revoking the certificate fires it. Object level only, every object own and
 * ledgered; delivery goes to the local catchers of notificationCatchers.ts.
 */
import { GuardedApi } from '../guard/types';
import { createOwnGroup } from '../ownGroups';
import { createOwnRaProfileOrSkip, OwnRaProfile } from '../ownRaProfiles';
import { issueOwnCertificateInGroup, revokeOwnCertificateAndWait } from './workflowFixtures';
import { OwnCertificate } from '../ownCertificates';
import { createOwnUser } from '../ownUsers';
import { OwnRef } from '../ledger/ledger';
import { associateTriggers } from './eventAssociations';
import { ObjectHistoryRow, waitForFinishedFirings, waitForTriggerRows } from './eventHistory';
import { EVENT } from './eventVocabulary';
import { createOwnAction, createOwnExecution, createOwnTrigger, sendNotificationItem } from './workflowObjects';

export interface Rig {
    ra: OwnRaProfile;
    group: OwnRef;
    owner: OwnRef;
    ownerEmail: string;
    cert: OwnCertificate;
}

/** The address of an own user / group / role: `<name>@example.test` (reserved, RFC 6761: only the local catcher ever sees it). */
export const addressOf = (name: string): string => `${name}@example.test`;

/** The suffix of the rig's certificate: short, because it becomes part of a common name that has a 64-character limit. */
export const rigCertificateSuffix = (suffix: string): string => `${suffix}-c`;

/** RA profile, group (with a contact e-mail), owner (with an e-mail) and one issued certificate in the group owned by the owner. */
export async function buildRig(api: GuardedApi, spec: string, suffix: string, skip: (reason: string) => void): Promise<Rig> {
    const ra = await createOwnRaProfileOrSkip(api, spec, `${suffix}-ra`, skip);
    const owner = await createOwnUser(api, spec, `${suffix}-owner`, { email: addressOf(`${suffix}-owner`) });
    const group = await createOwnGroup(api, spec, `${suffix}-group`, { email: addressOf(`${suffix}-group`) });
    const cert = await issueOwnCertificateInGroup(api, ra, spec, group, owner, rigCertificateSuffix(suffix));
    return { ra, group, owner, ownerEmail: addressOf(`${suffix}-owner`), cert };
}

/** One trigger (event Certificate status changed) with ONE execution sending every profile; associated on the rig's group. */
export async function armGroup(api: GuardedApi, spec: string, rig: Pick<Rig, 'group'>, suffix: string, profiles: OwnRef[]): Promise<{ triggerName: string; triggerUuid: string }> {
    const execution = await createOwnExecution(api, spec, `${suffix}-e`, { type: 'sendNotification', items: profiles.map((p) => sendNotificationItem(p.uuid)) });
    const action = await createOwnAction(api, spec, `${suffix}-a`, { executions: [execution] });
    const trigger = await createOwnTrigger(api, spec, `${suffix}-t`, { event: EVENT.statusChanged, actions: [action] });
    const sent = await associateTriggers(api, spec, { event: EVENT.statusChanged, resource: 'groups', object: rig.group, triggers: [trigger] });
    if (sent.status >= 300) throw new Error(`associate on the group → ${sent.status} ${sent.text.slice(0, 300)}`);
    return { triggerName: trigger.name, triggerUuid: trigger.uuid };
}

/** Revokes the rig's certificate and returns the trigger's history row on it once the firing finished. */
export async function fire(api: GuardedApi, rig: Rig, armed: { triggerName: string }): Promise<ObjectHistoryRow> {
    const revoked = await revokeOwnCertificateAndWait(api, rig.ra, rig.cert);
    if (revoked.status >= 300) throw new Error(`revoke → ${revoked.status} ${revoked.text.slice(0, 300)}`);
    await waitForFinishedFirings(api, { event: EVENT.statusChanged, scope: { resource: 'groups', objectUuid: rig.group.uuid } }, 1, { timeoutMs: 180_000 });
    const rows = await waitForTriggerRows(api, 'certificates', rig.cert.uuid, [armed.triggerName], { timeoutMs: 180_000 });
    return rows.find((r) => r.trigger.name === armed.triggerName)!;
}
