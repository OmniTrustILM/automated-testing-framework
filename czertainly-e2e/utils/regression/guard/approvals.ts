/**
 * approvals — lets the run's own user approve its own certificates; everything else about approvals stays refused.
 *
 *   - An approval profile step may name the CALLER as `userUuid`, and only that exact position is waived.
 *   - An approval may only be DECIDED (PATCH approve / reject / approveRecipient / rejectRecipient), by the run's own
 *     user, and only when this run's ledger line names an own certificate and an own approval profile for it, checked
 *     live. Probe uuids keep their 404 allowance.
 *   - Every other mutation whose path names an approval is refused.
 */
import { IS_UUID, isCanonicalUuid, UUID } from './uuids';
import { isPlainObject } from './targets';
import type { BodyView } from './bodies';

/** The four decision routes (interfaces ApprovalController), PATCH only. */
const APPROVAL_DECISION = new RegExp(`^/v1/approvals/(${UUID})/(approve|reject|approveRecipient|rejectRecipient)$`);

/** The approval profile writes whose steps may name the caller (interfaces ApprovalProfileController). */
export function isApprovalProfileWrite(method: string, apiPath: string): boolean {
    return (method === 'POST' && apiPath === '/v1/approvalProfiles') || (method === 'PUT' && new RegExp(`^/v1/approvalProfiles/${UUID}$`).test(apiPath));
}

/** Why a request on an approval target is not an allowed decision (route, identity, body), or undefined. */
export function approvalDecisionProblem(method: string, apiPath: string, view: BodyView, otherIdentity: boolean): string | undefined {
    const m = APPROVAL_DECISION.exec(apiPath);
    if (method !== 'PATCH' || !m) {
        return 'an approval may only be decided (PATCH /v1/approvals/{own}/approve | reject | approveRecipient | rejectRecipient); every other mutation of an approval is refused';
    }
    if (otherIdentity) return 'an approval decision goes out as the run\'s own user (no identity header, no identityOverride)';
    const recipient = m[2].endsWith('Recipient');
    if (view.kind === 'none') return undefined;
    if (view.kind !== 'json') return 'an approval decision with a body that is not JSON';
    const body = view.value;
    if (!recipient) {
        return isPlainObject(body) && Object.keys(body).length === 0 ? undefined : 'the override decision (approve / reject) takes no body';
    }
    if (!isPlainObject(body)) return 'a recipient decision takes a UserApprovalDto object ({ comment })';
    const extra = Object.keys(body).filter((k) => k !== 'comment');
    if (extra.length) return `a recipient decision with a field UserApprovalDto does not have (${extra.slice(0, 3).map((k) => JSON.stringify(k.slice(0, 24))).join(', ')})`;
    if (body.comment !== undefined && body.comment !== null && typeof body.comment !== 'string') return 'the comment of a recipient decision must be a string';
    return undefined;
}

/** The canonical `userUuid` values of the plain-object steps of `approvalSteps` (lower-cased), in order. */
export function stepUserUuids(json: unknown): string[] {
    if (!isPlainObject(json) || !Array.isArray(json.approvalSteps)) return [];
    return json.approvalSteps.filter((st) => isPlainObject(st) && isCanonicalUuid(st.userUuid)).map((st) => String((st as Record<string, unknown>).userUuid).toLowerCase());
}

/** The body with every step `userUuid` equal to `self` removed (a copy; the sent body is unchanged). */
export function withoutSelfSteps(json: unknown, self: string): unknown {
    if (!isPlainObject(json) || !Array.isArray(json.approvalSteps)) return json;
    return {
        ...json,
        approvalSteps: json.approvalSteps.map((st) => {
            if (!isPlainObject(st) || !isCanonicalUuid(st.userUuid) || String(st.userUuid).toLowerCase() !== self) return st;
            const { userUuid: _self, ...rest } = st;
            return rest;
        }),
    };
}

/** The caller's uuid from a `GET /v1/auth/profile` body, lower-cased, or undefined. */
export function callerUuidOf(profile: unknown): string | undefined {
    const u = isPlainObject(profile) ? profile.uuid : undefined;
    return typeof u === 'string' && IS_UUID.test(u) ? u.toLowerCase() : undefined;
}

/** Why a live approval detail does not belong to the own certificate and approval profile, or undefined. */
export function approvalLiveProblem(detail: unknown, certificate: string, approvalProfile: string): string | undefined {
    if (!isPlainObject(detail)) return 'the approval detail is not an object';
    if (detail.resource !== 'certificates') return 'the approval is not a certificate\'s (resource)';
    if (typeof detail.objectUuid !== 'string' || detail.objectUuid.toLowerCase() !== certificate) return 'the approval belongs to another certificate than its ledger parent';
    if (typeof detail.approvalProfileUuid !== 'string' || detail.approvalProfileUuid.toLowerCase() !== approvalProfile) {
        return 'the approval belongs to another approval profile than its ledger parent';
    }
    return undefined;
}
