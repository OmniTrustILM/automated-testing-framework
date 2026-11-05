/** eventVocabulary — the event and resource codes of the workflow API and the event labels the platform prints; pure data. */

export const EVENT = {
    statusChanged: 'certificate_status_changed',
    actionPerformed: 'certificate_action_performed',
    discovered: 'certificate_discovered',
    expiring: 'certificate_expiring',
    notCompliant: 'certificate_not_compliant',
    uploaded: 'certificate_uploaded',
    registered: 'certificate_registered',
    discoveryFinished: 'discovery_finished',
    approvalRequested: 'approval_requested',
    approvalClosed: 'approval_closed',
    commentCreated: 'comment_created',
    commentResolved: 'comment_resolved',
    scheduledJobFinished: 'scheduled_job_finished',
} as const;
export type EventCode = (typeof EVENT)[keyof typeof EVENT];

export const EVENT_LABEL: Record<EventCode, string> = {
    certificate_status_changed: 'Certificate validation status changed',
    certificate_action_performed: 'Certificate action performed',
    certificate_discovered: 'Certificate discovered',
    certificate_expiring: 'Certificate expiring',
    certificate_not_compliant: 'Certificate not compliant',
    certificate_uploaded: 'Certificate uploaded',
    certificate_registered: 'Certificate registered',
    discovery_finished: 'Discovery Finished',
    approval_requested: 'Approval requested',
    approval_closed: 'Approval closed',
    comment_created: 'Comment created',
    comment_resolved: 'Comment resolved',
    scheduled_job_finished: 'Scheduled job finished',
};

export type AssociationScope = 'raProfiles' | 'groups' | 'discoveries';
