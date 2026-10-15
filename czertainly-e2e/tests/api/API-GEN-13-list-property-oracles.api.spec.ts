/**
 * API-GEN-13, 14, 15 — property oracles over the keys, discoveries and audit-log listings (inventory-api plan §3.3; ilm#428 T4
 * steps 12–14, ilm#442 QA#10; rules §2.2 r8–r25, §2.3 "Observed metamorphic invariants", §6.2 r1).
 *
 *   API-GEN-13  keys list: per catalogue field and sampled value every returned row satisfies the filter, totalItems = sum of
 *               pages, #EMPTY + #NOT_EMPTY = total, #EQUALS v + #NOT_EQUALS v = total, GREATER n and LESSER_OR_EQUAL n partition the
 *               non-null rows (CKI_LENGTH), AND of two filters = the intersection, sort non-decreasing with empty values last.
 *   API-GEN-14  discoveries list: the same oracles incl. the datetime conditions (start / end time) and the sort.
 *   API-GEN-15  audit-log list: Property source only, no field sortable (any sort 422), the predicate oracle per filter inside a CLOSED
 *               time window (the log is append-only and the suite's own calls are logged), `IN_PAST PT15M` is non-empty, and the suite's
 *               OWN activity is findable (a statistics read, a group create; the inspection POST is a guard request).
 *
 * Read-only on the tier except the own group of API-GEN-15 (create-only, recorded in the ledger before any assertion). Never touches
 * a discovery (SMK-003 cleanup issue automated-testing-framework#99). A listing with no data skips with the named reason. The engine
 * is utils/regression/inventoryOracles.ts (one re-read absorbs a concurrent change, a second mismatch fails). The "own key exact oracle"
 * of API-GEN-13 is [blocked: token and key objects belong to the keys area] and is not written here.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { expect422Messages } from '../../utils/regression/errorContract';
import { CatalogueGroup, fieldsOf, okJson, prop, readProbe, send } from '../../utils/regression/inventoryApi';
import { createOwnGroup } from '../../utils/regression/inventoryOwn';
import {
    activityFilters, ActivityQuery, AUDIT_LOGS, auditGate, Baseline, catalogueProblems, closedAuditWindow, disabledCustomAttributeNames, DISCOVERIES, expectationsOf, findAndPairs,
    guardedTransport, KEYS, ListingSpec, listingTotal, loadBaseline, probeSort, readLoggingSettings, runAndOracle, runFieldOracles, runGenericFieldOracles, runSortComposition,
    runSortField, RunLog, sortOf, targetOf, Transport, unsupportedSortText, waitForActivity, withReread,
} from '../../utils/regression/inventoryOracles';
import { regName } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';
import type { GuardedApi } from '../../utils/regression/guardedApi';

const ISSUES = ['ilm#428', 'ilm#442'];

/**
 * The oracles of one listing over its live data: every mapped property field (row predicates, exact sets on a complete baseline, count
 * relations), the unmapped fields by count relations, AND pairs, and the sort of every sortable field. Returns the problems per field.
 */
async function runListing(api: GuardedApi, testInfo: { annotations: Array<{ type: string; description?: string }> }, spec: ListingSpec, opts: { sorts: boolean }): Promise<void> {
    const t: Transport = guardedTransport(api);
    const log = new RunLog();
    const served = await readProbe(api, spec.catalogueUrl);
    test.skip(served.status === 404, `${spec.catalogueUrl} answers 404 on this build: the ${spec.name} listing is not served here`);
    const catalogue = okJson<CatalogueGroup[]>(served, `GET ${spec.catalogueUrl}`);
    const base: Baseline = await loadBaseline(t, spec);
    test.skip(base.total === 0, `the ${spec.name} listing is empty on this tier: there is no data to hold the oracles to`);
    const live = new Map(fieldsOf(catalogue, 'property').map((f) => [f.fieldIdentifier, f]));
    const problems: string[] = [];
    const attempt = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
        try {
            await withReread(label, log, async () => void (await fn()));
        } catch (e) {
            problems.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    for (const field of spec.fields) {
        const l = live.get(field.id);
        if (!l) {
            problems.push(`${field.id}: the field table maps it but the live catalogue does not publish it`);
            continue;
        }
        await attempt(field.id, () => runFieldOracles(t, spec, field, l, base, log));
    }

    // Fields the table does not map (a newer core adds some) and attribute fields: the count relations alone.
    const mapped = new Set(spec.fields.map((f) => f.id));
    const disabled = await disabledCustomAttributeNames(t);
    for (const group of catalogue) {
        for (const l of group.searchFieldData ?? []) {
            if (group.filterFieldSource === 'property' && mapped.has(l.fieldIdentifier)) continue;
            if (group.filterFieldSource === 'custom' && disabled.has(l.fieldIdentifier.split('|')[0])) {
                log.note(`${l.fieldIdentifier}: a disabled custom attribute (core#2507): skipped`);
                continue;
            }
            await attempt(`${group.filterFieldSource}:${l.fieldIdentifier}`, () => runGenericFieldOracles(t, spec, group.filterFieldSource, l, base, log));
        }
    }

    for (const pair of findAndPairs(spec.fields, base.rows, new Set(live.keys()), 2)) await attempt(pair.describe, () => runAndOracle(t, spec, pair, log));

    let sorted = 0;
    if (opts.sorts && spec.configurable) {
        for (const field of spec.fields) {
            if (!live.get(field.id)?.sortable || field.sort === 'none') continue;
            sorted += 1;
            await attempt(`sort ${field.id}`, () => runSortField(t, spec, targetOf(field), base, log));
            await attempt(`sort composition ${field.id}`, () => runSortComposition(t, spec, targetOf(field), base, log));
        }
    }

    testInfo.annotations.push({ type: 'checked', description: `${base.total} row(s) (${base.complete ? 'all walked' : 'first rows only'}), ${log.steps.length} relation(s), ${sorted} sorted field(s)` });
    for (const n of log.notes) testInfo.annotations.push({ type: 'note', description: n });
    expect(problems.join('\n'), `${spec.name}: fields whose oracles failed`).toBe('');
}

/** The audit log is part of the build, or the named skip. */
async function auditServedOrSkip(api: GuardedApi): Promise<void> {
    const p = await readProbe(api, AUDIT_LOGS.catalogueUrl);
    test.skip(p.status === 404, `${AUDIT_LOGS.catalogueUrl} answers 404 on this build: the audit log is not served here`);
}

test.describe('API-GEN-13 listing property oracles', { tag: tags.api }, () => {
    test('API-GEN-13: keys list: row-level predicates, totals, EMPTY / NOT_EMPTY, EQUALS / NOT_EQUALS, CKI_LENGTH number partition, AND, sort with empty values last',
        meta({
            id: 'API-GEN-13', prio: 'P1', issue: ISSUES,
            rule: ['inventory-api §2.2 r12–r16, r21–r23, §2.3 "Observed metamorphic invariants" (|EMPTY| + |NOT_EMPTY| = total; |EQUALS v| + |NOT_EQUALS v| = total)', 'core CryptographicKeyItem.mapToSummaryDto, FilterField CKI_*; ilm#428 T4#12; QA#10'],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(1_500_000);
            await runListing(api, testInfo, KEYS, { sorts: true });
        });

    test('API-GEN-14: discoveries list: the same property oracles incl. the datetime conditions of start / end time, AND, and the sort (read-only, no discovery is touched)',
        meta({
            id: 'API-GEN-14', prio: 'P1', issue: ISSUES,
            rule: ['inventory-api §2.2 r12–r18, r21–r23 (datetime conditions, IN_NEXT / IN_PAST windows), §2.3', 'core DiscoveryDtoMapper.toListDto, FilterField DISCOVERY_*; ilm#428 T4#13; QA#10'],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(1_500_000);
            await runListing(api, testInfo, DISCOVERIES, { sorts: true });
        });
});

test.describe('API-GEN-15 audit-log list', { tag: tags.api }, () => {
    test('API-GEN-15[catalogue]: the audit-log catalogue publishes the Property source only and no sortable field; any sort is refused 422 "Sorting is not supported for the Audit logs listing."',
        meta({
            id: 'API-GEN-15', prio: 'P1', issue: ISSUES,
            rule: ['inventory-api §2.2 r24 (audit logs refuse any sort), §1.3 row "sort … on a listing that does not sort"', 'core AuditLogServiceImpl.java:96-125, :193-205; RequestValidatorHelper.java:24-30; ilm#428 T4#14'],
        }),
        async ({ api }) => {
            const t = guardedTransport(api);
            const p = await readProbe(api, AUDIT_LOGS.catalogueUrl);
            test.skip(p.status === 404, `${AUDIT_LOGS.catalogueUrl} answers 404 on this build`);
            expect(p.status, p.text.slice(0, 200)).toBe(200);
            const report = catalogueProblems(p.json, expectationsOf(AUDIT_LOGS, true));
            expect(report.problems).toEqual([]);
            expect(report.fields.every((f) => f.source === 'property'), 'Property source only').toBe(true);
            expect(report.fields.filter((f) => f.sortable), 'no sortable field').toEqual([]);
            for (const sort of [sortOf('AUDIT_LOG_TIMESTAMP', 'property', 'asc'), sortOf('AUDIT_LOG_TIMESTAMP', 'property', 'desc')]) {
                const s = await probeSort(t, AUDIT_LOGS.searchUrl, sort);
                expect(s.status, s.text.slice(0, 200)).toBe(422);
                expect(expect422Messages(s.text)).toContain(unsupportedSortText(AUDIT_LOGS.refusalLabel));
            }
        });

    test('API-GEN-15[oracles]: inside a closed time window of the log every returned row satisfies the filter, totals add up, EMPTY / NOT_EMPTY and EQUALS / NOT_EQUALS partition the window, datetime conditions hold',
        meta({
            id: 'API-GEN-15', prio: 'P1', issue: ISSUES,
            rule: ['inventory-api §2.2 r12–r18, §2.3; the audit log is append-only and every call of the suite is logged, so the relations run in a window no new entry can enter', 'core AuditLog.mapToDto, FilterField AUDIT_LOG_*; ilm#428 T4#14; QA#10'],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(1_500_000);
            await auditServedOrSkip(api);
            const t = guardedTransport(api);
            const window = await closedAuditWindow(t, AUDIT_LOGS);
            test.skip('skip' in window, 'skip' in window ? window.skip : '');
            if ('skip' in window) return;
            testInfo.annotations.push({ type: 'window', description: `${window.total} entries between two fixed instants` });
            await runListing(api, testInfo, { ...AUDIT_LOGS, baseFilters: window.filters }, { sorts: false });
        });

    test('API-GEN-15[in-past]: IN_PAST PT15M on the audit timestamp is non-empty: the suite\'s own calls are logged',
        meta({ id: 'API-GEN-15', prio: 'P1', issue: ISSUES, rule: ['inventory-api §2.2 r18 (IN_PAST = BETWEEN now - d AND now), plan row API-GEN-15; core AuditLogAspect.java:100-125 (writes only when the audit output is DATABASE / ALL)'] }),
        async ({ api }) => {
            await auditServedOrSkip(api);
            const t = guardedTransport(api);
            const settings = await readLoggingSettings(t);
            const gate = auditGate(settings, 'core', 'dashboard');
            test.skip(!gate.enabled, `audit logging is off for this call: ${gate.why}`);
            // A read of our own just before: it is logged.
            await readProbe(api, '/api/v1/auth/profile');
            const total = await listingTotal(t, AUDIT_LOGS, [prop('AUDIT_LOG_TIMESTAMP', 'IN_PAST', 'PT15M')]);
            expect(total, 'the last 15 minutes of the audit log hold this suite\'s own requests').toBeGreaterThan(0);
        });

    const OWN_ACTIVITY: Array<{ id: string; what: string; query: (groupUuid?: string) => ActivityQuery }> = [
        { id: 'statistics', what: 'a GET /v1/statistics', query: () => ({ resource: 'dashboard', operation: 'statistics', module: 'core' }) },
        { id: 'group-create', what: 'a group create', query: (groupUuid) => ({ resource: 'groups', operation: 'create', module: 'core', objectUuid: groupUuid }) },
    ];

    for (const a of OWN_ACTIVITY) {
        test(`API-GEN-15[own-activity.${a.id}]: ${a.what} is findable in the audit log: matching resource / operation, a timestamp at or after t0 (polled up to 10 s)`,
            meta({
                id: 'API-GEN-15', prio: 'P1', issue: ISSUES,
                rule: ['inventory-api §2.2 r24 / ledger API-GEN-15 ("own activity is findable"); core StatisticsControllerImpl.java:42 (@AuditLogged DASHBOARD / STATISTICS), GroupControllerImpl.java:55 (GROUP / CREATE)', 'core AuditLogAspect.java:181-194 (entries are published asynchronously)'],
            }),
            async ({ api }) => {
                await auditServedOrSkip(api);
                const t = guardedTransport(api);
                const gate = auditGate(await readLoggingSettings(t), 'core', a.query().resource);
                test.skip(!gate.enabled, `audit logging is off for this call: ${gate.why}`);
                // t0 from the SERVER clock (the Date header of a read just before), minus the one-second resolution of the header.
                const before = await readProbe(api, '/api/v1/auth/profile');
                const t0 = new Date((before.headers.date ? Date.parse(before.headers.date) : Date.now()) - 1_000);
                let groupUuid: string | undefined;
                if (a.id === 'statistics') {
                    const s = await send(api, 'GET', '/api/v1/statistics');
                    expect(s.status, s.text.slice(0, 200)).toBe(200);
                } else {
                    // Create-only, own: recorded in the ledger by the helper before anything is asserted.
                    groupUuid = (await createOwnGroup(api, 'API-GEN-15', regName(`audit-${Date.now().toString(36)}`), {}, 'own group for the audit-log activity row')).uuid;
                }
                const q = a.query(groupUuid);
                expect(activityFilters(q).length, 'the activity is located by resource, operation, module (and object) and the last 15 minutes').toBeGreaterThanOrEqual(4);
                const found = await waitForActivity(t, AUDIT_LOGS, q, t0);
                expect(found.length).toBeGreaterThan(0);
            });
    }

    test('API-GEN-15[own-activity.inspect]: an inspection POST is findable in the audit log (certificates / inspect, Operation.INSPECT)',
        meta({
            id: 'API-GEN-15', prio: 'P1', issue: ISSUES,
            rule: ['inventory-api §6.2 r1 ("audited as Operation.INSPECT"); core InspectionControllerImpl.java:28-29 (@AuditLogged CERTIFICATES / CERTIFICATE / INSPECT, affiliated TOKEN_PROFILE)'],
        }),
        async ({ api }) => {
            const t = guardedTransport(api);
            const before = await readProbe(api, '/api/v1/auth/profile');
            const t0 = new Date((before.headers.date ? Date.parse(before.headers.date) : Date.now()) - 1_000);
            // A one-byte file: refused 422 by the reader, still audited (the inspection is logged before the refusal).
            const res = await send(api, 'POST', '/api/v1/inspections', { data: { file: Buffer.from('x').toString('base64') } });
            expect(res.status, res.text.slice(0, 200)).toBe(422);
            const found = await waitForActivity(t, AUDIT_LOGS, { resource: 'certificates', operation: 'inspect', module: 'certificates' }, t0);
            expect(found.length).toBeGreaterThan(0);
        });
});
