/**
 * approvals — the run's approval profile, the approval gate on an own clone of the run RA profile, and the approvals of an own certificate
 * with their override decisions.
 * The API answers a status with the enum name and the UI with the label: compare through `sameApprovalStatus`.
 */
import type { APIRequestContext } from '@playwright/test';
import { apiJson, ApiAnswer } from '../apiReads';
import type { GuardedApi } from '../guard/types';
import { assertOwnLive, checkOwnership } from '../ledger/ownership';
import { cloneRunRaProfile, RaLike } from '../ownRaProfiles';
import { ensureRunRole } from '../ownRoles';
import type { JsonObject } from '../json';
import { OwnRef, recordCreated } from '../ledger/ledger';
import { readRunState, runName, runId, updateRunState } from '../ledger/runState';
import { pollUntil } from '../wait';
import { sendRaw } from './rawAnswers';


/**
 * The run's approval profile: one step, approver = the run's OWN role, 1
 * required approval, 24 h expiry; decisions go through the override path.
 */
export async function ensureApprovalProfile(api: GuardedApi, spec: string): Promise<OwnRef> {
    const state = readRunState();
    if (state.approvalProfile) return state.approvalProfile;
    const role = await ensureRunRole(api, spec);
    const name = runName('ap');
    const created = await apiJson<{ uuid: string }>(api, 'POST', '/api/v1/approvalProfiles', {
        name,
        description: `REG run ${runId()}`,
        enabled: true,
        expiry: 24,
        approvalSteps: [{ roleUuid: role.uuid, order: 1, requiredApprovals: 1, description: `REG run ${runId()} step` }],
    });
    const ref = recordCreated('approvalProfiles', { uuid: created.uuid, name }, { spec, note: 'API prerequisite; one step, approver = the run role' });
    updateRunState({ approvalProfile: ref });
    return ref;
}

async function associateApprovalProfile(api: GuardedApi, approvalProfile: OwnRef, ra: OwnRef): Promise<void> {
    await assertOwnLive(api, 'approvalProfiles', approvalProfile, 'associateApprovalProfile (approval profile)');
    await assertOwnLive(api, 'raProfiles', ra, 'associateApprovalProfile (RA profile)');
    await apiJson(api, 'PATCH', `/api/v1/approvalProfiles/${approvalProfile.uuid}/associations/raProfiles/${ra.uuid}`);
}

export async function dissociateApprovalProfile(api: GuardedApi, approvalProfile: OwnRef, ra: OwnRef): Promise<void> {
    await assertOwnLive(api, 'approvalProfiles', approvalProfile, 'dissociateApprovalProfile (approval profile)');
    await assertOwnLive(api, 'raProfiles', ra, 'dissociateApprovalProfile (RA profile)');
    const a = await sendRaw(api, 'DELETE', `/api/v1/approvalProfiles/${approvalProfile.uuid}/associations/raProfiles/${ra.uuid}`);
    if (a.status !== 204 && a.status !== 404) throw new Error(`dissociate approval profile answered ${a.status}: ${a.text.slice(0, 300)}`);
}

export interface ApprovalGate {
    ra: OwnRef & RaLike;
    approvalProfile: OwnRef;
    associate(): Promise<void>;
    release(): Promise<void>;
}

export async function openApprovalGate(api: GuardedApi, spec: string, suffix: string, opts: { associate?: boolean } = {}): Promise<ApprovalGate> {
    const ra = await cloneRunRaProfile(api, spec, suffix);
    const approvalProfile = await ensureApprovalProfile(api, spec);
    let associated = false;
    const gate: ApprovalGate = {
        ra,
        approvalProfile,
        async associate() {
            if (associated) return;
            await associateApprovalProfile(api, approvalProfile, ra);
            associated = true;
        },
        async release() {
            if (!associated) return;
            await dissociateApprovalProfile(api, approvalProfile, ra);
            associated = false;
        },
    };
    if (opts.associate !== false) await gate.associate();
    return gate;
}


async function approvalsOf(api: APIRequestContext, certificateUuid: string): Promise<JsonObject[]> {
    const body = await apiJson<{ approvals?: JsonObject[] } | undefined>(api, 'GET', `/api/v1/certificates/${certificateUuid}/approvals`);
    return body?.approvals ?? [];
}

export interface OwnApproval extends OwnRef {
    row: JsonObject;
}

/** The API answers a status with the enum name (`PENDING`), the UI with the label (`Pending`); compare through these two. */
export const approvalStatusLabel = (status: unknown): string => {
    const t = String(status ?? '').trim().toLowerCase();
    return t ? t[0].toUpperCase() + t.slice(1) : '';
};
export const sameApprovalStatus = (a: unknown, b: unknown): boolean => approvalStatusLabel(a) === approvalStatusLabel(b);

/**
 * The approval the listener raised for an own certificate (polled up to `timeoutMs`), recorded as an `approvals` line with its own parents
 * so the guard admits the detail read and the decision.
 */
export async function findApproval(api: APIRequestContext, cert: OwnRef, spec: string, opts: { timeoutMs?: number; status?: string } = {}): Promise<OwnApproval> {
    const timeout = opts.timeoutMs ?? 60_000;
    const row = await pollUntil(
        // The status filter holds: a closed approval never stands in for the Pending one.
        async () => (await approvalsOf(api, cert.uuid)).find((r) => !opts.status || sameApprovalStatus(r.status, opts.status)),
        (found) => !!found && typeof found.approvalUuid === 'string',
        { timeoutMs: timeout, intervalMs: 1000, tolerateErrors: 0, onTimeout: 'return' },
    );
    if (!row) throw new Error(`certificate ${cert.uuid}: no approval listed within ${timeout} ms`);
    // A listed row without its uuid is another failure than "nothing listed".
    if (typeof row.approvalUuid !== 'string') {
        throw new Error(`certificate ${cert.uuid}: an approval is listed (status ${String(row.status)}) but carries no approvalUuid within ${timeout} ms`);
    }
    const uuid = row.approvalUuid;
    const name = runName(`approval-${uuid.slice(0, 8)}`);
    // The approval profile is a parent too when it is an own line: the
    // guard decides only for an own certificate AND an own approval profile.
    const ap = typeof row.approvalProfileUuid === 'string' ? checkOwnership({ uuid: row.approvalProfileUuid }) : undefined;
    const parents = { certificate: cert.uuid, ...(ap?.own && ap.line?.type === 'approvalProfiles' ? { approvalProfile: String(row.approvalProfileUuid) } : {}) };
    const ref = checkOwnership({ uuid }).own ? ({ uuid, name, kind: 'own' } as OwnRef) : recordCreated('approvals', { uuid, name }, { spec, note: `approval ${row.resourceAction ?? ''} of an own certificate`, parents });
    return { ...ref, row };
}

export async function approvalDetail(api: GuardedApi, approval: OwnRef): Promise<JsonObject> {
    return apiJson<JsonObject>(api, 'GET', `/api/v1/approvals/${approval.uuid}`);
}

export async function waitForApprovalStatus(api: GuardedApi, approval: OwnRef, status: string, timeoutMs = 60_000): Promise<JsonObject> {
    const d = await pollUntil(() => approvalDetail(api, approval), (detail) => sameApprovalStatus(detail.status, status), { timeoutMs, intervalMs: 1000, tolerateErrors: 0, onTimeout: 'return' });
    if (!d || !sameApprovalStatus(d.status, status)) throw new Error(`approval ${approval.uuid}: status ${d?.status}, not ${status} within ${timeoutMs} ms`);
    return d;
}

export async function decideApproval(api: GuardedApi, approval: OwnRef, decision: 'approve' | 'reject'): Promise<ApiAnswer> {
    await assertOwnLive(api, 'approvals', approval, `decideApproval (${decision})`);
    return sendRaw(api, 'PATCH', `/api/v1/approvals/${approval.uuid}/${decision}`);
}

export function recipientComments(detail: JsonObject): string[] {
    return ((detail?.approvalSteps ?? []) as JsonObject[]).flatMap((s) => ((s.approvalStepRecipients ?? []) as JsonObject[]).map((r) => String(r.comment ?? ''))).filter(Boolean);
}
