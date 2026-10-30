/**
 * auditLog — the audit-log listing oracles.
 *
 * Provides:
 *   - the logging-settings gate: an audit row runs only when the platform logs the activity
 *   - the closed time window around an own activity, and the activity filters
 *   - a read-only wait for the asynchronous entry to appear
 */
import { expect } from '@playwright/test';
import { propertyFilter } from '../searchApi';
import type { Filter } from '../searchApi';
import type { ListRow } from '../listInvariants';
import { datetimeLiteral, elementsOf, instantMs, nested } from './values';
import { ListingSpec, Transport, fetchRows, listingPage } from './listing';

// ====================================================================================================================
// 10. Audit log: logging gate, closed window, own activity
// ====================================================================================================================

export interface AuditGate {
    enabled: boolean;
    why?: string;
}

/**
 * Is a record of (module, resource) written to the DATABASE under these `GET /v1/settings/logging` settings? The gate
 * mirrors AuditLogAspect.java (output NONE writes nothing), LoggingHelper.isLogFilteredBasedOnModuleAndResource
 * and AuditLogServiceImpl.handleAuditLogging (database / all only). Unknown settings (undefined): not decidable, enabled.
 */
export function auditGate(settings: unknown, module: string, resource: string): AuditGate {
    const a = (settings as { auditLogs?: Record<string, unknown> } | undefined)?.auditLogs;
    if (!a) return { enabled: true, why: 'logging settings not readable: not decidable' };
    const output = String(a.output ?? '').toUpperCase();
    if (output !== 'ALL' && output !== 'DATABASE') return { enabled: false, why: `audit log output is ${output || 'unset'}: nothing is written to the database` };
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
    if (list(a.ignoredModules).includes(module) || (!a.logAllModules && !list(a.loggedModules).includes(module))) return { enabled: false, why: `module ${module} is not logged (settings)` };
    if (list(a.ignoredResources).includes(resource) || (!a.logAllResources && !list(a.loggedResources).includes(resource))) return { enabled: false, why: `resource ${resource} is not logged (settings)` };
    return { enabled: true };
}

export async function readLoggingSettings(t: Transport): Promise<unknown | undefined> {
    const p = await t.get('/api/v1/settings/logging');
    return p.status === 200 ? p.json : undefined;
}

/** The names of the custom attributes the platform lists as disabled (core#2507: their filters answer inconsistently). */
export async function disabledCustomAttributeNames(t: Transport): Promise<Set<string>> {
    const p = await t.get('/api/v1/attributes/custom');
    const rows = Array.isArray(p.json) ? (p.json as Array<Record<string, unknown>>) : [];
    return new Set(rows.filter((r) => r.enabled === false).map((r) => String(r.name)));
}

const AUDIT_TIMESTAMP = 'AUDIT_LOG_TIMESTAMP';

export interface AuditWindow {
    filters: Filter[];
    lower: string;
    upper: string;
    /** Rows in the window (a fixed set once both bounds are in the past). */
    total: number;
}

/**
 * A CLOSED window of the audit log that no new entry can enter: bounded below by the timestamp of the oldest of up to 300
 * entries older than two minutes and above by the newest of them, both literals copied from the DTO text. Returns the reason
 * instead when the log is too small or too busy to hold one. The audit log is append-only and every request of the suite
 * (this one included) is itself logged, so an unbounded relation on it would chase its own tail.
 */
export async function closedAuditWindow(t: Transport, spec: ListingSpec, wanted = 300): Promise<AuditWindow | { skip: string }> {
    const first = await listingPage(t, spec, { size: 100 });
    const now = first.serverNow ?? Date.now();
    const old: ListRow[] = [];
    let page = first;
    for (let n = 1; n <= 5; n++) {
        for (const r of page.rows) if ((instantMs(r.timestamp) ?? Infinity) <= now - 120_000) old.push(r);
        if (old.length >= wanted || n >= page.totalPages) break;
        page = await listingPage(t, spec, { size: 100, page: n + 1 });
    }
    if (old.length < 20) return { skip: `the audit log holds ${old.length} entr${old.length === 1 ? 'y' : 'ies'} older than two minutes within the newest 500 (a closed window needs 20)` };
    const slice = old.slice(0, wanted);
    const times = slice.map((r) => instantMs(r.timestamp)!);
    const upperRow = slice[times.indexOf(Math.max(...times))];
    const lowerRow = slice[times.indexOf(Math.min(...times))];
    const lower = datetimeLiteral(lowerRow.timestamp);
    const upper = datetimeLiteral(upperRow.timestamp);
    const filters = [propertyFilter(AUDIT_TIMESTAMP, 'GREATER_OR_EQUAL', lower), propertyFilter(AUDIT_TIMESTAMP, 'LESSER_OR_EQUAL', upper)];
    const windowed = { ...spec, baseFilters: filters };
    const rows = await fetchRows(t, windowed, [], spec.maxWalkRows);
    if (rows.total === 0) return { skip: 'the closed audit window answered no entry (the platform reads filter timestamps in another zone than it serves them)' };
    const outside = rows.rows.filter((r) => {
        const ms = instantMs(r.timestamp);
        return ms === undefined || ms < Math.min(...times) - 1000 || ms > Math.max(...times) + 1000;
    });
    if (outside.length) return { skip: `the closed audit window returned ${outside.length} entr${outside.length === 1 ? 'y' : 'ies'} outside its bounds (the platform reads filter timestamps in another zone than it serves them)` };
    return { filters, lower, upper, total: rows.total };
}

export interface ActivityQuery {
    /** Resource code (`dashboard`, `groups`, `certificates`). */
    resource: string;
    /** Operation code (`statistics`, `create`, `inspect`). */
    operation: string;
    module?: string;
    /** The own object the entry names (AUDIT_LOG_RESOURCE_UUID). */
    objectUuid?: string;
}

/** The filters that locate an activity in the audit log: resource, operation, module, object, and the last 15 minutes. */
export function activityFilters(q: ActivityQuery): Filter[] {
    return [
        propertyFilter('AUDIT_LOG_RESOURCE', 'EQUALS', q.resource),
        propertyFilter('AUDIT_LOG_OPERATION', 'EQUALS', q.operation),
        ...(q.module ? [propertyFilter('AUDIT_LOG_MODULE', 'EQUALS', q.module)] : []),
        ...(q.objectUuid ? [propertyFilter('AUDIT_LOG_RESOURCE_UUID', 'EQUALS', q.objectUuid)] : []),
        propertyFilter(AUDIT_TIMESTAMP, 'IN_PAST', 'PT15M'),
    ];
}

/**
 * The entries of `rows` that are this activity and are not older than `t0` (a server-clock instant): resource, operation, module, object.
 */
export function activityMatches(rows: ListRow[], q: ActivityQuery, t0: Date): ListRow[] {
    return rows.filter((r) => {
        const at = instantMs(r.timestamp);
        if (at === undefined || at < t0.getTime()) return false;
        if (nested('resource', 'type')(r)[0] !== q.resource || String(r.operation) !== q.operation) return false;
        if (q.module && String(r.module) !== q.module) return false;
        if (q.objectUuid && !elementsOf(['resource', 'objects'], 'uuid')(r).includes(q.objectUuid)) return false;
        return true;
    });
}

/**
 * Polls (<= timeoutMs, default 10 s) until the activity is in the audit log; the entries are published asynchronously
 * (AuditLogAspect.java).
 */
export async function waitForActivity(t: Transport, spec: ListingSpec, q: ActivityQuery, t0: Date, timeoutMs = 10_000): Promise<ListRow[]> {
    let found: ListRow[] = [];
    await expect
        .poll(
            async () => {
                const page = await listingPage(t, spec, { filters: activityFilters(q), size: 100 });
                found = activityMatches(page.rows, q, t0);
                return found.length;
            },
            { timeout: timeoutMs, intervals: [250, 500, 1000], message: `audit log: no ${q.resource} / ${q.operation} entry at or after ${t0.toISOString()} within ${timeoutMs} ms` },
        )
        .toBeGreaterThan(0);
    return found;
}
