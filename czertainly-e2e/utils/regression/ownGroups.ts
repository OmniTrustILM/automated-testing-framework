/** ownGroups — the groups this run creates, the groups of its certificates, and how a group change is read back. */
import { GuardedApi } from './guard/types';
import { patchCertificate } from './inventory/groupProbes';
import type { Json } from './inventory/searchApi';
import { apiJson } from './apiReads';
import { requiredCustomAttributes } from './customAttributes';
import { OwnRef, recordCreated } from './ledger/ledger';
import { runId } from './ledger/runState';

/**
 * `POST /v1/groups` for a run-prefixed `name` (any required custom attribute filled), recorded before the caller asserts
 * anything. `email` is the group's contact address (`@example.test` only).
 */
export async function createOwnGroup(api: GuardedApi, spec: string, name: string, fields: { description?: string; email?: string } = {}, note = 'own group (API prerequisite)'): Promise<OwnRef> {
    const created = await apiJson<Json>(api, 'POST', '/api/v1/groups', {
        name,
        description: fields.description ?? `REG run ${runId()}`,
        ...(fields.email ? { email: fields.email } : {}),
        customAttributes: await requiredCustomAttributes(api, 'groups', name),
    });
    return recordCreated('groups', { uuid: String(created.uuid), name }, spec, note);
}

/** The uuids of the groups of a certificate detail (`groups: [{ uuid, name }]`), sorted. */
export const groupUuidsOf = (detail: Json): string[] => (Array.isArray(detail.groups) ? (detail.groups as Json[]).map((g) => String(g.uuid)).sort() : []);

/** Sets the groups of an own certificate through its PATCH and requires 204 (a prerequisite step, not the behaviour under test). */
export async function setCertificateGroups(api: GuardedApi, certificateUuid: string, groupUuids: string[]): Promise<void> {
    const p = await patchCertificate(api, certificateUuid, { groupUuids });
    if (p.status !== 204) throw new Error(`setting the groups answered ${p.status} ${p.text.slice(0, 300)}`);
}
