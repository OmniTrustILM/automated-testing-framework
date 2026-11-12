/**
 * certificateLabels — the texts of the certificate lifecycle rules: the v2 operations base of an RA profile, the nine
 * revocation reasons, the state labels, the 422 state-guard text and the approval-close and revoke history lines (the
 * run-prefixed common names are in ownCertificates.ts). Pure, no I/O.
 */
import type { RaLike } from '../ownRaProfiles';

/** The v2 operations base of an RA profile (`/api/v2/operations/authorities/{a}/raProfiles/{r}`). */
export const opsBase = (ra: Pick<RaLike, 'uuid' | 'authorityUuid'>): string => `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}`;

// ------------------------------------------------------------------ labels and texts (cert-lifecycle rules)

/** The nine revocation reasons: wire code and UI / history label (`CertificateRevocationReason`). */
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

/** Certificate state codes → labels (`CertificateState`). */
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

/** The one-element 422 text of a lifecycle operation on a certificate that is not `issued`. */
export const stateGuardText = (op: 'renew' | 'rekey' | 'revoke', stateCode: string): string =>
    `Cannot perform operation ${op} on certificate in state ${STATE_LABELS[stateCode] ?? stateCode}. Certificate: `;

/** The history line the approval close writes. */
export const approvalClosedText = (action: string, profileName: string, status: 'Approved' | 'Rejected' | 'Expired'): string =>
    `Approval for action ${action} with approval profile ${profileName} closed with status ${status}`;

/** The history line of a completed revoke. */
export const revokedText = (label: string): string => `Certificate revoked. Reason: ${label}`;
