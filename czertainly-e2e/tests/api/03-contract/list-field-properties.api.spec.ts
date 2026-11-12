/**
 * API-GEN-13, 14, 15 — Property oracles over the keys, discoveries and audit-log listings. ilm#428, ilm#442.
 *
 * WHAT: 1. Keys list: every returned row satisfies its filter, EMPTY plus NOT_EMPTY and EQUALS plus NOT_EQUALS equal the total, the key
 *          length partitions as a number, AND is the intersection and every sortable field sorts with empty values last.
 *       2. Discoveries list: the same oracles plus the datetime conditions of start and end time (IN_NEXT / IN_PAST windows) and the sort.
 *       3. Audit log: the catalogue has the Property source only and every sort answers 422 "Sorting is not supported for the Audit logs
 *          listing."; inside a closed time window every row satisfies the filter and the partitions add up; IN_PAST 15 minutes is
 *          non-empty;
 *          a GET /v1/statistics, a group create and an inspection POST are each findable in the log.
 * WHY: whatever data the tier holds, a listing's filters, totals and sort must obey the same relations; the audit log is append-only and
 *      every call of the suite is logged, so the relations are checked in a window no new entry can enter, and the suite's own activity
 *      must appear (the audit output must be DATABASE or ALL, otherwise the test skips with the reason).
 * HOW: read-only apart from one own group (recorded in the ledger by the helper before anything is asserted). The oracles walk the live
 *      catalogue: mapped property fields get row predicates and exact sets on a complete baseline, unmapped and attribute fields get the
 *      count relations only, disabled custom attributes are skipped (core#2507); a retry re-reads once. A listing that answers 404 or is
 *      empty on the tier skips with the named reason. The time limit is long because the oracles walk whole listings.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { expectRefused } from '../../../utils/regression/errorContract';
import { CatalogueGroup, fieldsOf, readJsonOk, propertyFilter, send, readAnswer } from '../../../utils/regression/inventory/searchApi';
import { activityFilters, ActivityQuery, auditGate, closedAuditWindow, disabledCustomAttributeNames, readLoggingSettings, waitForActivity } from '../../../utils/regression/inventory/oracles/auditLog';
import { AUDIT_LOGS, DISCOVERIES, expectationsOf, KEYS } from '../../../utils/regression/inventory/oracles/listingTables';
import { Baseline, ListingRun, transportThroughGuard, ListingSpec, listingTotal, loadBaseline, RunLog, Transport, retryOnceWithReread } from '../../../utils/regression/inventory/oracles/listing';
import { catalogueProblems } from '../../../utils/regression/inventory/oracles/catalogueContract';
import { findAndPairs, runAndOracle, runFieldOracles, runGenericFieldOracles } from '../../../utils/regression/inventory/oracles/fieldOracles';
import { probeSort, runSortComposition, runSortField, sortOf, targetOf, unsupportedSortText } from '../../../utils/regression/inventory/oracles/sortOracles';
import { LISTING_ORACLES_MS } from '../../../utils/regression/timeouts';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { GuardedApi } from '../../../utils/regression/guard/types';

const ISSUES = ['ilm#428', 'ilm#442'];

/**
 * The oracles of one listing over its live data: every mapped property field (row predicates, exact sets on a complete baseline, count
 * relations), the unmapped fields by count relations, AND pairs, and the sort of every sortable field. Returns the problems per field.
 */
async function runListing(api: GuardedApi, testInfo: { annotations: Array<{ type: string; description?: string }> }, spec: ListingSpec, opts: { sorts: boolean }): Promise<void> {
    const t: Transport = transportThroughGuard(api);
    const log = new RunLog();
    const served = await readAnswer(api, spec.catalogueUrl);
    test.skip(served.status === 404, `${spec.catalogueUrl} answers 404 on this build: the ${spec.name} listing is not served here`);
    const catalogue = readJsonOk<CatalogueGroup[]>(served, `GET ${spec.catalogueUrl}`);
    const base: Baseline = await loadBaseline(t, spec);
    const run: ListingRun = { transport: t, spec, baseline: base, log };
    test.skip(base.total === 0, `the ${spec.name} listing is empty on this tier: there is no data to hold the oracles to`);
    const live = new Map(fieldsOf(catalogue, 'property').map((f) => [f.fieldIdentifier, f]));
    const problems: string[] = [];
    const attempt = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
        try {
            await retryOnceWithReread(label, log, async () => void (await fn()));
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
        await attempt(field.id, () => runFieldOracles(run, field, l));
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
            await attempt(`${group.filterFieldSource}:${l.fieldIdentifier}`, () => runGenericFieldOracles(run, group.filterFieldSource, l));
        }
    }

    for (const pair of findAndPairs(spec.fields, base.rows, new Set(live.keys()), 2)) await attempt(pair.describe, () => runAndOracle(run, pair));

    let sorted = 0;
    if (opts.sorts && spec.configurable) {
        for (const field of spec.fields) {
            if (!live.get(field.id)?.sortable || field.sort === 'none') continue;
            sorted += 1;
            await attempt(`sort ${field.id}`, () => runSortField(run, targetOf(field)));
            await attempt(`sort composition ${field.id}`, () => runSortComposition(run, targetOf(field)));
        }
    }

    testInfo.annotations.push({ type: 'checked', description: `${base.total} row(s) (${base.complete ? 'all walked' : 'first rows only'}), ${log.steps.length} relation(s), ${sorted} sorted field(s)` });
    for (const n of log.notes) testInfo.annotations.push({ type: 'note', description: n });
    expect(problems.join('\n'), `${spec.name}: fields whose oracles failed`).toBe('');
}

/** The audit log is part of the build, or the named skip. */
async function auditServedOrSkip(api: GuardedApi): Promise<void> {
    const p = await readAnswer(api, AUDIT_LOGS.catalogueUrl);
    test.skip(p.status === 404, `${AUDIT_LOGS.catalogueUrl} answers 404 on this build: the audit log is not served here`);
}

test.describe('listing property oracles', { tag: tags.api }, () => {
    test('keys list holds the property oracles: predicates, totals, partitions, AND, sort',
        testMeta({
            id: 'API-GEN-13', prio: 'P1', issue: ISSUES,
            rule: ['|EMPTY| + |NOT_EMPTY| = total; |EQUALS v| + |NOT_EQUALS v| = total', 'core CryptographicKeyItem.mapToSummaryDto, FilterField CKI_*; ilm#428', 'row-level predicates, totals, EMPTY / NOT_EMPTY, EQUALS / NOT_EQUALS, CKI_LENGTH number partition, AND, sort with empty values last'],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(LISTING_ORACLES_MS);
            await runListing(api, testInfo, KEYS, { sorts: true });
        });

    test('discoveries list holds the same property oracles, datetime conditions and sort',
        testMeta({
            id: 'API-GEN-14', prio: 'P1', issue: ISSUES,
            rule: ['datetime conditions and IN_NEXT / IN_PAST windows', 'core DiscoveryDtoMapper.toListDto, FilterField DISCOVERY_*; ilm#428', 'datetime conditions of start / end time, AND, and the sort (read-only, no discovery is touched)'],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(LISTING_ORACLES_MS);
            await runListing(api, testInfo, DISCOVERIES, { sorts: true });
        });
});

test.describe('audit-log list', { tag: tags.api }, () => {
    test('the audit-log catalogue has the Property source only, and any sort gives 422',
        testMeta({
            id: 'API-GEN-15', row: 'catalogue', prio: 'P1', issue: ISSUES,
            rule: ['audit logs refuse any sort ("sort … on a listing that does not sort")', 'core AuditLogServiceImpl; RequestValidatorHelper; ilm#428', 'the 422 text is "Sorting is not supported for the Audit logs listing."', 'no sortable field'],
        }),
        async ({ api }) => {
            const t = transportThroughGuard(api);
            const p = await readAnswer(api, AUDIT_LOGS.catalogueUrl);
            test.skip(p.status === 404, `${AUDIT_LOGS.catalogueUrl} answers 404 on this build`);
            expect(p.status, p.text.slice(0, 200)).toBe(200);
            const report = catalogueProblems(p.json, expectationsOf(AUDIT_LOGS, true));
            expect(report.problems).toEqual([]);
            expect(report.fields.every((f) => f.source === 'property'), 'Property source only').toBe(true);
            expect(report.fields.filter((f) => f.sortable), 'no sortable field').toEqual([]);
            for (const sort of [sortOf('AUDIT_LOG_TIMESTAMP', 'property', 'asc'), sortOf('AUDIT_LOG_TIMESTAMP', 'property', 'desc')]) {
                const s = await probeSort(t, AUDIT_LOGS.searchUrl, sort);
                expectRefused(s, { status: 422, text: unsupportedSortText(AUDIT_LOGS.refusalLabel), among: true, what: `the audit log sorted by ${sort.fieldIdentifier}` });
            }
        });

    test('in a closed time window every row satisfies the filter and partitions add up',
        testMeta({
            id: 'API-GEN-15', row: 'oracles', prio: 'P1', issue: ISSUES,
            rule: ['the audit log is append-only and every call of the suite is logged, so the relations run in a window no new entry can enter', 'core AuditLog.mapToDto, FilterField AUDIT_LOG_*; ilm#428', 'inside a closed time window of the log every returned row satisfies the filter, totals add up, EMPTY / NOT_EMPTY and EQUALS / NOT_EQUALS partition the window, datetime conditions hold'],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(LISTING_ORACLES_MS);
            await auditServedOrSkip(api);
            const t = transportThroughGuard(api);
            const window = await closedAuditWindow(t, AUDIT_LOGS);
            test.skip('skip' in window, 'skip' in window ? window.skip : '');
            if ('skip' in window) return;
            testInfo.annotations.push({ type: 'window', description: `${window.total} entries between two fixed instants` });
            await runListing(api, testInfo, { ...AUDIT_LOGS, baseFilters: window.filters }, { sorts: false });
        });

    test('IN_PAST PT15M on the audit timestamp is non-empty (own calls are logged)',
        testMeta({ id: 'API-GEN-15', row: 'in-past', prio: 'P1', issue: ISSUES, rule: ['IN_PAST = BETWEEN now - d AND now; core AuditLogAspect (writes only when the audit output is DATABASE / ALL)'] }),
        async ({ api }) => {
            await auditServedOrSkip(api);
            const t = transportThroughGuard(api);
            const settings = await readLoggingSettings(t);
            const gate = auditGate(settings, 'core', 'dashboard');
            test.skip(!gate.enabled, `audit logging is off for this call: ${gate.why}`);
            // A read of our own just before: it is logged.
            await readAnswer(api, '/api/v1/auth/profile');
            const total = await listingTotal(t, AUDIT_LOGS, [propertyFilter('AUDIT_LOG_TIMESTAMP', 'IN_PAST', 'PT15M')]);
            expect(total, 'liveness: the last 15 minutes of the audit log hold this suite\'s own requests').toBeGreaterThan(0);
        });

    const OWN_ACTIVITY: Array<{ id: string; what: string; query: (groupUuid?: string) => ActivityQuery }> = [
        { id: 'statistics', what: 'a GET /v1/statistics', query: () => ({ resource: 'dashboard', operation: 'statistics', module: 'core' }) },
        { id: 'group-create', what: 'a group create', query: (groupUuid) => ({ resource: 'groups', operation: 'create', module: 'core', objectUuid: groupUuid }) },
    ];

    for (const a of OWN_ACTIVITY) {
        test(`${a.what} is findable in the audit log`,
            testMeta({
                id: 'API-GEN-15', row: `own-activity.${a.id}`, prio: 'P1', issue: ISSUES,
                rule: ['own activity is findable in the audit log; core StatisticsControllerImpl (@AuditLogged DASHBOARD / STATISTICS), GroupControllerImpl (GROUP / CREATE)', 'core AuditLogAspect (entries are published asynchronously)', 'matching resource / operation, a timestamp at or after t0 (polled up to 10 s)'],
            }),
            async ({ api, own }) => {
                await auditServedOrSkip(api);
                const t = transportThroughGuard(api);
                const gate = auditGate(await readLoggingSettings(t), 'core', a.query().resource);
                test.skip(!gate.enabled, `audit logging is off for this call: ${gate.why}`);
                // t0 from the SERVER clock (the Date header of a read just before), minus the one-second resolution of the header.
                const before = await readAnswer(api, '/api/v1/auth/profile');
                const t0 = new Date((before.headers.date ? Date.parse(before.headers.date) : Date.now()) - 1_000);
                let groupUuid: string | undefined;
                if (a.id === 'statistics') {
                    const s = await send(api, 'GET', '/api/v1/statistics');
                    expect(s.status, s.text.slice(0, 200)).toBe(200);
                } else {
                    // Create-only, own: recorded in the ledger by the helper before anything is asserted.
                    groupUuid = (await own.group('audit', { note: 'own group for the audit-log activity row' })).uuid;
                }
                const q = a.query(groupUuid);
                expect(activityFilters(q).length, 'the activity is located by resource, operation, module (and object) and the last 15 minutes').toBeGreaterThanOrEqual(4);
                const found = await waitForActivity(t, AUDIT_LOGS, q, t0);
                expect(found.length, 'liveness: the own activity is in the audit log').toBeGreaterThan(0);
            });
    }

    test('an inspection POST is findable in the audit log',
        testMeta({
            id: 'API-GEN-15', row: 'own-activity.inspect', prio: 'P1', issue: ISSUES,
            rule: ['inspection is audited as Operation.INSPECT; core InspectionControllerImpl (@AuditLogged CERTIFICATES / CERTIFICATE / INSPECT, affiliated TOKEN_PROFILE)', 'certificates / inspect, Operation.INSPECT'],
        }),
        async ({ api }) => {
            const t = transportThroughGuard(api);
            const before = await readAnswer(api, '/api/v1/auth/profile');
            const t0 = new Date((before.headers.date ? Date.parse(before.headers.date) : Date.now()) - 1_000);
            // A one-byte file: refused 422 by the reader, still audited (the inspection is logged before the refusal).
            const res = await send(api, 'POST', '/api/v1/inspections', { data: { file: Buffer.from('x').toString('base64') } });
            expect(res.status, res.text.slice(0, 200)).toBe(422);
            const found = await waitForActivity(t, AUDIT_LOGS, { resource: 'certificates', operation: 'inspect', module: 'certificates' }, t0);
            expect(found.length, 'liveness: the own activity is in the audit log').toBeGreaterThan(0);
        });
});
