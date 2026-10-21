/**
 * The run's own user as the approver of its own approval profile, deciding the approvals of its own
 * certificates. Everything else about approvals stays refused on a shared tier.
 *
 * (a) `POST /v1/approvalProfiles` and `PUT /v1/approvalProfiles/{own}`: a step (`approvalSteps[i]`, a plain object) may
 *     name the CALLER as `userUuid` — the uuid `GET /v1/auth/profile` answers for the identity the request goes out as
 *     (core AuthServiceImpl.java:68-75: the logged-in user's detail, a read). Core stores the uuid on the own profile's
 *     step and writes nothing on the user (ApprovalProfileServiceImpl.java:322-340 `ApprovalStep.setUserUuid`;
 *     :343-366 only checks that one of user / role / group is set). Only that exact position is waived: the same uuid
 *     anywhere else in the body, another user's uuid, a request with an identity header (another identity), a string
 *     body (the guard scans the caller's text as written) or an unreadable profile keep the refusal (BODY_FIELD_TYPES
 *     `userUuid` → users: own or a probe).
 * (b) An approval named as a mutation target (`approvals`, TARGET_TYPES) may only be DECIDED, as the run's own user:
 *     `PATCH /v1/approvals/{uuid}/approve | reject` (the override path, no body; core ApprovalServiceImpl.java:176-198)
 *     and `PATCH /v1/approvals/{uuid}/approveRecipient | rejectRecipient` (the recipient path, `UserApprovalDto` =
 *     `{ comment }` only; :200-217, the caller must be a recipient of the pending step and not the creator, :272-311).
 *     A decision closes the approval and runs its action on the approval's object (:370-426): so the approval must belong
 *     to an OWN certificate and an OWN approval profile — its `approvals` ledger line of this run names both as parents
 *     (`certificate`, `approvalProfile`), each an own, non-derived ledger line of that type checked live, and the
 *     approval's live detail (`GET /v1/approvals/{uuid}`, ApprovalDto: `resource`, `objectUuid`, `approvalProfileUuid`;
 *     core Approval.java:91-106) names exactly those two. No identity header, no identityOverride. Every other mutation
 *     whose path names an approval is refused. Probe uuids keep their 404 allowance.
 */
import { IS_UUID, isCanonicalUuid, UUID } from './uuids';
import { isPlainObject } from './targets';
import type { BodyView } from './bodies';

/** The four decision routes (interfaces ApprovalController.java:57-88), PATCH only. */
const APPROVAL_DECISION = new RegExp(`^/v1/approvals/(${UUID})/(approve|reject|approveRecipient|rejectRecipient)$`);

/** The approval profile writes whose steps may name the caller (interfaces ApprovalProfileController.java:89, :102). */
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
