/** ownGroups — the groups this run creates, the groups of its certificates, and how a group change is read back. */
import { GuardedApi } from './guard/types';
import { patchCertificate } from './inventory/groupProbes';
import { requiredCustomAttributes } from './customAttributes';
import { createOwn } from './ownCrud';
import type { OwnRef } from './ledger/ledger';
import { ownName, runId, runName } from './ledger/runState';
import { JsonObject } from './json';

export interface GroupOptions {
    /** Default `REG run <id>`; `null` sends a null description (a negative row). */
    description?: string | null;
    /** The group's contact address (`@example.test` only). */
    email?: string | null;
    /** Extra custom attribute items; the tier's REQUIRED ones are always filled. */
    customAttributes?: JsonObject[];
    note?: string;
    /** A planned name (the seed's isolation prefix); default `ownName(suffix)`. */
    name?: string;
}

/** A group body (`name` may be anything: the negative rows send blank, null and whitespace). */
export const groupBody = (name: unknown, fields: Omit<GroupOptions, 'note' | 'name'> = {}): JsonObject => ({ name, ...fields });

/**
 * `POST /v1/groups`: a NEW own group (2xx required; ledger first; any required custom attribute of the tier filled). The
 * name is `ownName(suffix)` unless `options.name` is a planned one.
 */
export async function createOwnGroup(api: GuardedApi, spec: string, suffix: string, o: GroupOptions = {}): Promise<OwnRef & { description?: string | null; email?: string | null }> {
    const name = o.name ?? ownName(suffix);
    const customAttributes = [...(await requiredCustomAttributes(api, 'groups', o.name ?? runName('ca'))), ...(o.customAttributes ?? [])];
    const created = await createOwn(api, spec, {
        type: 'groups',
        path: '/api/v1/groups',
        name,
        note: o.note ?? 'own group (API prerequisite)',
        body: {
            description: o.description === undefined ? `REG run ${runId()}` : o.description,
            ...(o.email !== undefined ? { email: o.email } : {}),
            customAttributes,
        },
    });
    const { answer: _answer, ...ref } = created;
    return { ...ref, description: o.description, email: o.email };
}

/** The uuids of the groups of a certificate detail (`groups: [{ uuid, name }]`), sorted. */
export const groupUuidsOf = (detail: JsonObject): string[] => (Array.isArray(detail.groups) ? (detail.groups as JsonObject[]).map((g) => String(g.uuid)).sort() : []);

/** Sets the groups of an own certificate through its PATCH and requires 204 (a prerequisite step, not the behaviour under test). */
export async function setCertificateGroups(api: GuardedApi, certificateUuid: string, groupUuids: string[]): Promise<void> {
    const p = await patchCertificate(api, certificateUuid, { groupUuids });
    if (p.status !== 204) throw new Error(`setting the groups answered ${p.status} ${p.text.slice(0, 300)}`);
}
