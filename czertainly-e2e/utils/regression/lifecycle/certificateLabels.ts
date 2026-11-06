/**
 * certificateLabels — the texts of the certificate lifecycle rules: the v2 operations base of an RA profile, revocation reasons, state
 * labels, the 422 state-guard text and the approval-close and revoke history lines. Pure.
 */
import type { RaLike } from '../ownRaProfiles';

export const opsBase = (ra: Pick<RaLike, 'uuid' | 'authorityUuid'>): string => `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}`;


export const REVOKE_REASONS: ReadonlyArray<{ code: string; label: string }> = [
    { code: 'unspecified', label: 'Unspecified' },
    { code: 'keyCompromise', label: 'Key compromise' },
    { code: 'cACompromise', label: 'CA compromise' },
    { code: 'affiliationChanged', label: 'Affiliation changed' },
    { code: 'superseded', label: 'Superseded' },
    { code: 'cessationOfOperation', label: 'Cessation of operation' },
    { code: 'certificateHold', label: 'Certificate hold' },
    { code: 'privilegeWithdrawn', label: 'Privilege withdrawn' },
    { code: 'aACompromise', label: 'AA compromise' },
];

export const STATE_LABELS: Readonly<Record<string, string>> = {
    requested: 'Requested',
    rejected: 'Rejected',
    pending_approval: 'Pending approval',
    pending_issue: 'Pending issue',
    pending_revoke: 'Pending revoke',
    pending_registration: 'Pending registration',
    registered: 'Registered',
    failed: 'Failed',
    issued: 'Issued',
    revoked: 'Revoked',
};

export const stateGuardText = (op: 'renew' | 'rekey' | 'revoke', stateCode: string): string =>
    `Cannot perform operation ${op} on certificate in state ${STATE_LABELS[stateCode] ?? stateCode}. Certificate: `;

export const approvalClosedText = (action: string, profileName: string, status: 'Approved' | 'Rejected' | 'Expired'): string =>
    `Approval for action ${action} with approval profile ${profileName} closed with status ${status}`;

export const revokedText = (label: string): string => `Certificate revoked. Reason: ${label}`;
