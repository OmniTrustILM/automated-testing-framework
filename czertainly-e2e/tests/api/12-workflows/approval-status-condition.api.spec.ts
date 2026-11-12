/**
 * API-WFL-28 — A workflow condition on Approval Status matches the status the UI stores (enum name). core#2539, fix core#2576.
 *
 * WHAT: 1. Neighbour, any tier: an own trigger on `Certificate action performed` of an own RA profile whose condition is Certificate State
 *          equals [issued] matches once the own certificate is issued (conditions met, action performed); an own control trigger with
 *          State equals [revoked] on the same profile does not match and leaves an "is false" record.
 *       2. Local stack only: an own trigger on `Approval requested` with Approval Status equals [PENDING] matches the own pending approval;
 *          an own control trigger with Status equals [APPROVED] on the same event does not.
 *       3. Local stack only: on `Approval closed`, Status equals [APPROVED] matches an approved approval and not a rejected one; Status
 *          equals [REJECTED] matches the rejected one and not the approved one.
 * WHY: the rule filter offers (and the UI stores) the approval status as the enum name (`PENDING` … `EXPIRED`: ApprovalStatusEnum has no
 *      `@JsonValue`), but the evaluator compared the enum's code, so "Status equals PENDING" was never met (core#2539: "Condition item
 *      'Property APPROVAL_STATUS equals [PENDING]' is false."). core#2576 compares APPROVAL_STATUS by name and keeps every other enum
 *      property on its code (the diff's else branch), which is what row 1 guards: Certificate State is still compared by code.
 * HOW: the approval events evaluate PLATFORM-level triggers only (ApprovalRequestedEventHandler / ApprovalClosedEventHandler do not override
 *      `getOverridingTriggers`; only the certificate and comment handlers evaluate object-level associations), and core offers no
 *      evaluation endpoint, so rows 2 and 3 replace a platform setting: they are `@local` (excluded by the configs on a shared tier and
 *      skipped again by `describeLocalOnly`), require an empty platform list for their event (`platform-triggers-free`, which is exactly the
 *      state the `afterEach` restores and reads back) and touch the platform setting through `localApi` only (platformAssociate,
 *      getPlatformAssociations); everything else is own objects through the guarded `api`. Their action sends to an own internal-only profile whose recipient is an own
 *      role without members, so nothing is delivered and no pre-existing notification profile is used. The approvals go through an own
 *      RA profile clone gated by the run approval profile (decided by override); the gate is released in the `afterEach` (its own timeout slot, so a timed-out body
 *      still restores; the platform clear and the gate release are independent), the run-end teardown
 *      removes the rest. Row 1 is create-only on an own RA profile and an own group; it does not need a free platform list because it
 *      reads its own triggers' rows only. Every result is read from the object's event history (`conditionsMatched` per trigger).
 *      Open: the fix adds no expiry case; EXPIRED is not exercised here.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { associateTriggers, platformAssociate, getPlatformAssociations } from '../../../utils/regression/events/eventAssociations';
import { getObjectHistory, ObjectHistoryRow } from '../../../utils/regression/events/eventHistory';
import { EVENT, EventCode } from '../../../utils/regression/events/eventVocabulary';
import { createOwnInternalProfile } from '../../../utils/regression/events/notificationProfiles';
import { eventCertificate } from '../../../utils/regression/events/workflowFixtures';
import { conditionItem, createOwnChain, sendNotificationItem, setGroupsAction, OwnChain } from '../../../utils/regression/events/workflowObjects';
import { decideApproval, findApproval, openApprovalGate, waitForApprovalStatus, type ApprovalGate } from '../../../utils/regression/lifecycle/approvals';
import { submitOwnCertificate } from '../../../utils/regression/ownCertificates';
import { createOwnRole } from '../../../utils/regression/ownRoles';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import type { OwnRef } from '../../../utils/regression/ledger/ledger';
import { testMeta, tags } from '../../../utils/regression/tags';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { APPROVAL_STATE_WAIT_MS, ISSUE_MS, SLOW_LIFECYCLE_MS, STATE_CHANGE_WAIT_MS, TRIGGER_ROWS_WAIT_MS } from '../../../utils/regression/timeouts';
import { pollUntil } from '../../../utils/regression/wait';
import { waitForCertificateState } from '../../../utils/regression/wait/certificateState';

const ISSUE = 'core#2539';
const FIX = 'core#2576 (TriggerEvaluator: APPROVAL_STATUS compared by enum name, other enum properties by code)';

/** The rows of `triggers` in an object's event history, once each trigger has at least one row (`resource` = `certificates` / `approvals`). */
async function rowsOf(api: GuardedApi, resource: string, uuid: string, triggers: OwnRef[], ready: (rows: ObjectHistoryRow[]) => boolean = () => true): Promise<ObjectHistoryRow[]> {
    const names = triggers.map((t) => t.name);
    return pollUntil(
        async () => (await getObjectHistory(api, resource, uuid)).rows.filter((r) => names.includes(r.trigger?.name)),
        (rows) => names.every((n) => rows.some((r) => r.trigger.name === n)) && ready(rows),
        { what: `event-history rows of ${names.join(', ')} on the own ${resource} object`, timeoutMs: TRIGGER_ROWS_WAIT_MS },
    );
}

const of = (rows: ObjectHistoryRow[], t: OwnRef) => rows.filter((r) => r.trigger.name === t.name);
/** Order-insensitive list comparison (the platform list and the event history do not promise an order). */
const sorted = <T>(xs: T[]): T[] => [...xs].sort((a, b) => String(a).localeCompare(String(b)));
const falseRecords = (rows: ObjectHistoryRow[]) => rows.flatMap((r) => r.records ?? []).map((x) => String(x.message ?? '')).filter((m) => m.includes(' is false'));

// ================================================================== row 1: Certificate State (by code), any tier

test.describe('Approval Status condition: the neighbour enum (Certificate State) still compares by code', { tag: tags.api }, () => {
    test('certificate state equals issued matches the issued certificate and equals revoked does not',
        testMeta({ id: 'API-WFL-28', row: 'certificate-state', prio: 'P2', issue: ISSUE, needs: 'ca', rule: [FIX, 'the else branch: Certificate State equals [issued] (code) still matches after issue; equals [revoked] stays false'] }),
        async ({ api, own }) => {
            test.setTimeout(ISSUE_MS);
            const { ra, issued, revoked } = await test.step('Own RA profile, own group and two own triggers (State equals issued / revoked), Set field Groups', async () => {
                const ra = await own.raProfile('wf28-ra');
                const g = await own.group('wf28-g');
                const state = (code: string) => [conditionItem('property', 'CERTIFICATE_STATE', 'EQUALS', [code])];
                const issued = await createOwnChain(api, own.spec, 'wf28-issued', { event: EVENT.actionPerformed, items: state('issued'), executionItems: [setGroupsAction([g.uuid])] });
                const revoked = await createOwnChain(api, own.spec, 'wf28-revoked', { event: EVENT.actionPerformed, items: state('revoked'), executionItems: [setGroupsAction([g.uuid])] });
                return { ra, issued, revoked };
            });

            await test.step('Associate both on Certificate action performed of the own RA profile (object level)', async () => {
                const sent = await associateTriggers(api, own.spec, { event: EVENT.actionPerformed, resource: 'raProfiles', object: ra, triggers: [issued.trigger, revoked.trigger] });
                expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
            });

            const cert = await test.step('Issue an own certificate on the RA profile', async () => own.certificate.issue(ra, eventCertificate('wf28-cert')));

            await test.step('State equals [issued]: conditions met and action performed; State equals [revoked]: not met, "is false" record', async () => {
                const rows = await rowsOf(api, 'certificates', cert.uuid, [issued.trigger, revoked.trigger], (r) => of(r, issued.trigger).some((x) => x.conditionsMatched));
                const hit = of(rows, issued.trigger).find((x) => x.conditionsMatched)!;
                expect({ matched: hit.conditionsMatched, performed: hit.actionsPerformed }, 'State equals [issued]').toEqual({ matched: true, performed: true });
                expect(falseRecords([hit]), 'no "is false" record on the matched row').toEqual([]);
                const control = of(rows, revoked.trigger);
                expect(control.map((x) => x.conditionsMatched), 'State equals [revoked] never matches an issued certificate').not.toContain(true);
                expect(falseRecords(control).join(' | ')).toContain('CERTIFICATE_STATE');
            });
        });
});

// ================================================================== rows 2 and 3: Approval Status (by name), local stack only

test.describe('Approval Status condition on the approval events (local stack)', { tag: tags.api }, () => {
    describeLocalOnly(test);
    // The approval events read platform-level triggers only, so these rows replace the platform list of their event: `@local`, through
    // `localApi`, from an empty list (`platform-triggers-free`) and back to it in the `afterEach` below.

    /** What the `afterEach` must undo: set once the empty platform list was proven and the gate opened. */
    let restore: { localApi: GuardedApi; spec: string; event: EventCode; gate: ApprovalGate } | undefined;

    test.afterEach(async () => {
        const r = restore;
        restore = undefined;
        if (!r) return;
        const problems: string[] = [];
        // Two independent cleanups: one failing never skips the other.
        try {
            const cleared = await platformAssociate(r.localApi, r.spec, r.event, []);
            expect(cleared.status, `clearing the platform list of ${r.event}: ${cleared.text.slice(0, 300)}`).toBeLessThan(300);
            expect(await getPlatformAssociations(r.localApi, r.event), `the platform list of ${r.event} is restored (empty)`).toEqual([]);
        } catch (e) {
            problems.push(`platform list: ${(e as Error).message}`);
        }
        try {
            await r.gate.release();
        } catch (e) {
            problems.push(`approval gate release: ${(e as Error).message}`);
        }
        if (problems.length) throw new Error(problems.join('\n'));
    });

    const status = (value: string) => [conditionItem('property', 'APPROVAL_STATUS', 'EQUALS', [value])];

    /** One own approvals trigger whose action sends to an own internal-only profile (own role without members: nothing is delivered). */
    async function approvalTrigger(api: GuardedApi, spec: string, suffix: string, event: EventCode, value: string, profile: OwnRef): Promise<OwnChain> {
        return createOwnChain(api, spec, suffix, { event, resource: 'approvals', items: status(value), executionItems: [sendNotificationItem(profile.uuid)] });
    }

    async function silentProfile(api: GuardedApi, spec: string, suffix: string): Promise<OwnRef> {
        const role = await createOwnRole(api, spec, `${suffix}-role`);
        return createOwnInternalProfile(api, spec, `${suffix}-np`, { recipientType: 'role', recipients: [role] });
    }

    test('approval requested: status equals PENDING matches a pending approval, APPROVED does not',
        testMeta({ id: 'API-WFL-28', row: 'approval-requested', prio: 'P1', issue: ISSUE, needs: 'ca', local: true, rule: [FIX, 'core#2539 expected behaviour: the condition "Approval Status equals PENDING" is met and the action runs'] }),
        async ({ needs, api, localApi, own }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            await needs.platformTriggersFree(EVENT.approvalRequested);
            const profile = await silentProfile(api, own.spec, 'wf28-req');
            const pending = await approvalTrigger(api, own.spec, 'wf28-req-pending', EVENT.approvalRequested, 'PENDING', profile);
            const approved = await approvalTrigger(api, own.spec, 'wf28-req-approved', EVENT.approvalRequested, 'APPROVED', profile);
            const gate = await openApprovalGate(api, own.spec, 'wf28-req');
            restore = { localApi, spec: own.spec, event: EVENT.approvalRequested, gate };

            const sent = await platformAssociate(localApi, own.spec, EVENT.approvalRequested, [pending.trigger, approved.trigger]);
            expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
            expect(sorted(await getPlatformAssociations(localApi, EVENT.approvalRequested))).toEqual(sorted([pending.trigger.uuid, approved.trigger.uuid]));

            const c = await submitOwnCertificate(api, gate.ra, own.spec, { suffix: 'w28r-c', note: 'API-WFL-28 approval requested' });
            expect(c.answer.status, c.answer.text.slice(0, 300)).toBe(200);
            await waitForCertificateState(api, c.uuid, 'pending_approval', STATE_CHANGE_WAIT_MS);
            const approval = await findApproval(api, c, own.spec, { status: 'Pending' });

            const rows = await rowsOf(api, 'approvals', approval.uuid, [pending.trigger, approved.trigger]);
            const hit = of(rows, pending.trigger);
            expect(hit.map((x) => x.conditionsMatched), 'Status equals [PENDING] on the pending approval').toEqual([true]);
            expect(hit[0].actionsPerformed, 'the action ran').toBe(true);
            expect(falseRecords(hit), 'no "Condition item \'Property APPROVAL_STATUS equals [PENDING]\' is false." record').toEqual([]);
            expect(of(rows, approved.trigger).map((x) => x.conditionsMatched), 'control: Status equals [APPROVED] on a pending approval').toEqual([false]);
        });

    test('approval closed: status equals APPROVED or REJECTED matches only the approval so decided',
        testMeta({ id: 'API-WFL-28', row: 'approval-closed', prio: 'P1', issue: ISSUE, needs: 'ca', local: true, rule: [FIX, 'the same field on Approval closed: equals [APPROVED] after approve → met; after reject → not met (control)'] }),
        async ({ needs, api, localApi, own }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            await needs.platformTriggersFree(EVENT.approvalClosed);
            const profile = await silentProfile(api, own.spec, 'wf28-cls');
            const approved = await approvalTrigger(api, own.spec, 'wf28-cls-approved', EVENT.approvalClosed, 'APPROVED', profile);
            const rejected = await approvalTrigger(api, own.spec, 'wf28-cls-rejected', EVENT.approvalClosed, 'REJECTED', profile);
            const gate = await openApprovalGate(api, own.spec, 'wf28-cls');
            restore = { localApi, spec: own.spec, event: EVENT.approvalClosed, gate };

            const sent = await platformAssociate(localApi, own.spec, EVENT.approvalClosed, [approved.trigger, rejected.trigger]);
            expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);

            const decided: Record<'approve' | 'reject', OwnRef> = {} as Record<'approve' | 'reject', OwnRef>;
            // A table of `key` rows, so the common-name length check (tests/unit/commonNames.spec.ts) can expand the suffix.
            // Short keys: the common name must stay under 64 characters with the longest run id.
            const DECISIONS: Array<{ key: string; decision: 'approve' | 'reject' }> = [
                { key: 'ap', decision: 'approve' },
                { key: 'rj', decision: 'reject' },
            ];
            for (const row of DECISIONS) {
                const decision = row.decision;
                const c = await submitOwnCertificate(api, gate.ra, own.spec, { suffix: `w28c-${row.key}`, note: `API-WFL-28 approval closed (${decision})` });
                expect(c.answer.status, c.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, c.uuid, 'pending_approval', STATE_CHANGE_WAIT_MS);
                const approval = await findApproval(api, c, own.spec, { status: 'Pending' });
                const d = await decideApproval(api, approval, decision);
                expect(d.status, d.text.slice(0, 200)).toBe(204);
                await waitForApprovalStatus(api, approval, decision === 'approve' ? 'Approved' : 'Rejected', APPROVAL_STATE_WAIT_MS);
                decided[decision] = approval;
            }

            const onApproved = await rowsOf(api, 'approvals', decided.approve.uuid, [approved.trigger, rejected.trigger]);
            expect(of(onApproved, approved.trigger).map((x) => x.conditionsMatched), 'Status equals [APPROVED] on the approved approval').toEqual([true]);
            expect(falseRecords(of(onApproved, approved.trigger))).toEqual([]);
            expect(of(onApproved, rejected.trigger).map((x) => x.conditionsMatched), 'control: Status equals [REJECTED] on the approved approval').toEqual([false]);

            const onRejected = await rowsOf(api, 'approvals', decided.reject.uuid, [approved.trigger, rejected.trigger]);
            expect(of(onRejected, approved.trigger).map((x) => x.conditionsMatched), 'control: Status equals [APPROVED] on the rejected approval').toEqual([false]);
            expect(of(onRejected, rejected.trigger).map((x) => x.conditionsMatched), 'Status equals [REJECTED] on the rejected approval').toEqual([true]);
        });
});
